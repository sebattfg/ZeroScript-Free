// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen.js - the Qwen (chat.qwen.ai, Alibaba Cloud) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and kimi.js;
// the core (core/main.js) is provider-agnostic. To DISABLE Qwen support, remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS +
// main.js AI_SITES).
//
// Qwen DOM notes (validated live, 2026-06):
//  - React + Ant Design app. One exchange = a `.qwen-chat-message-user` then a
//    `.qwen-chat-message-assistant`. Both share `.qwen-chat-message`.
//  - Reply body is `.response-message-content.phase-answer` (the answer phase);
//    thinking cards (QwQ/extended thinking) live OUTSIDE `.response-message-content`
//    so they're naturally excluded from tool detection.
//  - Code blocks render as `pre.qwen-markdown-code` containing a full Monaco
//    editor (`.monaco-editor`). Plain textContent collapses multi-line code
//    because Monaco view-lines are separate sibling divs with no newline text
//    nodes between them. textWithout() intercepts `pre.qwen-markdown-code` and
//    joins `.view-line` elements with "\n" directly (same fix GLM uses for
//    CodeMirror's `.cm-line`).
//  - Editor: real <textarea class="message-input-textarea">. Drive with the
//    native HTMLTextAreaElement.prototype.value setter + input event. When the
//    textarea is empty the send control shows a voice-input button (waveform
//    icon) and `button.send-button` is absent. After setting text, React renders
//    `button.send-button`; wait for it before clicking.
//  - Generating: `button.stop-button` replaces send (may briefly carry class
//    `disabled` in the first frame of generation; clicking it still works). The
//    stop button is present for the WHOLE generation (thinking + answer).
//  - Conversation URL: /c/<uuid>. Fresh chat: /.
//  - Bar: anchored via barAnchor() returning `.message-input-wrapper` (the editor
//    is not inside `.chat-message-input-fixed-container`, so closest() falls
//    through to S.composer). NOT in-flow barMount: `.message-input-container` is
//    React-height-clamped + overflow:hidden, so a mounted child clips the input.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    userItem: ".qwen-chat-message-user",
    assistantItem: ".qwen-chat-message-assistant",
    anyItem: ".qwen-chat-message",
    reply: ".response-message-content",
    editor: "textarea.message-input-textarea",
    composer: ".message-input-wrapper",
    sendBtn: "button.send-button",
    stopBtn: "button.stop-button",
    codeWrap: "pre.qwen-markdown-code",
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[class*="notification"],[class*="ant-message"],[class*="message-notice"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|length|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "\\u4e0a\\u4e0b\\u6587.{0,10}(\\u8d85\\u51fa|\\u8fc7\\u957f|\\u9650\\u5236)",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|context .{0,15}(length|window)/i,
    busy: /something went wrong|une erreur s.est produite|try again|réessayer|server is busy|rate.?limit|too many requests|系统繁忙|请稍后再试/i,
    // Qwen free-tier DAILY usage cap. When hit, Qwen sits on each message ~35s
    // (throttle) and eventually shows this toast; we surface it as a hard limit so
    // the loop STOPS with a clear banner instead of grinding silently. Seen live:
    // "You have reached the daily usage limit. Please wait 4 hours before trying
    // again." Tolerant to wording/locale + the "wait N hours" variant.
    usageLimit: /(reached|exceeded|atteint|dépassé).{0,20}(daily|usage|quota|free|限)|daily.{0,10}(usage|message|limit)|usage limit|quota.{0,15}(exceeded|reached|atteint)|please wait.{0,12}\d+\s*hour|(每日|免费).{0,6}(额度|次数|上限|限制)/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Monaco code-block cache (the CRITICAL fix) ─────────────────────────────
  // Qwen renders fenced code in a Monaco editor and DISPOSES the block when it
  // scrolls out of view (validated live: the block collapses to its FIRST
  // `.view-line` only, e.g. a 50-line execute_luau payload becomes just
  // "###LUA###"). The agent loop then reads a command that has its opener but no
  // body/closer -> hasOpenToolBlock() stays true (the ~5s "stuck on active"
  // wait) and parseToolCalls() fails (the "command detected but JSON could not be
  // parsed" error). Both symptoms are this one disposal race.
  // Fix: while a block is still rendered (during streaming it is in view with ALL
  // view-lines present - Monaco does NOT virtualize, only DISPOSES off-screen), a
  // MutationObserver snapshots its joined source into `pre.dataset.zsCode`,
  // keeping the LONGEST capture. After disposal the full source survives in the
  // attribute, so codeText() below always returns the complete code.
  const codeLinesText = (pre) => {
    const lines = pre.querySelectorAll(".view-line");
    return lines.length ? [...lines].map((l) => l.textContent).join("\n") : "";
  };
  function snapshotCode(pre) {
    const live = codeLinesText(pre);
    if (!live) return;
    const prev = pre.dataset.zsCode || "";
    if (live.length > prev.length) pre.dataset.zsCode = live;
  }
  // Full code for a block: the cached snapshot if present/longer (survives
  // disposal), else the live view-lines, else raw textContent as a last resort.
  function codeText(pre) {
    const cached = pre.dataset.zsCode || "";
    const live = codeLinesText(pre);
    const best = cached.length >= live.length ? cached : live;
    return best || pre.textContent || "";
  }
  let _codeObs = null;
  function ensureCodeObserver() {
    if (_codeObs) return;
    const snapAll = () =>
      document.querySelectorAll(S.codeWrap).forEach(snapshotCode);
    _codeObs = new MutationObserver(snapAll);
    try {
      _codeObs.observe(document.body, { subtree: true, childList: true, characterData: true });
    } catch {}
    snapAll(); // seed any blocks already present
  }

  // ── Network tap (authoritative reply text) ─────────────────────────────────
  // providers/qwen-net.js (MAIN world) publishes the latest streamed assistant
  // reply - the RAW markdown, which Monaco's DOM cannot corrupt - into the
  // `#zs-qwen-net` node as JSON { rid, text, done, t }. netLatest() reads it.
  // This is the SOURCE OF TRUTH for the latest assistant turn's text: the DOM
  // (Monaco) disposes/partials code blocks, so a command read from the DOM can be
  // truncated, but the network text is always the model's verbatim output.
  function netLatest() {
    try {
      const n = document.getElementById("zs-qwen-net");
      if (!n || !n.textContent) return null;
      const o = JSON.parse(n.textContent);
      return o && typeof o.text === "string" ? o : null;
    } catch { return null; }
  }
  // rid (response_id) of the response we LAST replied to. The tap keeps holding a
  // finished response until Qwen opens the next one; if we read that stale text as
  // the NEW turn's reply we miss its command and finalize as a plain-text answer,
  // ending the loop early (rescued ~5s later by autoResume - the "tool frozen with
  // no timer/tokens for 15-20s" the user saw). We record the rid at send time and
  // treat the tap as STALE until its rid changes to a genuinely new response.
  let _sentRid = null;
  function rememberSentResponse() {
    const net = netLatest();
    if (net && net.rid) _sentRid = net.rid;
  }
  // The tap IFF it represents a response we have NOT already consumed. Returns null
  // (-> callers fall back to the DOM) while the tap still holds the just-replied
  // response, so a stale finished response is never attributed to the next turn.
  function netCurrent() {
    const net = netLatest();
    if (!net || !net.text) return null;
    if (_sentRid && net.rid === _sentRid) return null; // stale: already consumed
    return net;
  }
  // Network reply text for the LATEST turn (null for older turns / stale tap).
  // A/B "dual" turns: the tap interleaves BOTH candidates' deltas char-by-char, so
  // its TEXT is garbage - return null here and let the caller read candidate 1 from
  // the DOM (bodyEl). We deliberately do NOT gate this in netCurrent(): the tap's
  // streaming/`done` flag is still the most reliable GENERATION signal during an A/B
  // turn (Qwen may not render a `button.stop-button` for the comparison UI, and the
  // candidate-1 DOM text stalls while candidate 2 streams). Suppressing the tap for
  // gen-state too made netGenState fall back to flickery DOM signals, so the watcher
  // judged a still-streaming execute_luau "done but unclosed" and fired a premature
  // parse_error - sending an ERROR to Qwen mid-generation (validated live, 2026-06).
  function netReplyFor(item) {
    if (item !== lastAssistant()) return null;
    if (latestIsDual()) return null; // A/B: text interleaved - read DOM candidate 1
    const net = netCurrent();
    return net ? net.text : null;
  }

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.matches && item.matches(S.userItem);
  const isAssistantItem = (item) => !!item && item.matches && item.matches(S.assistantItem);

  // Qwen A/B "Which response do you prefer?" comparison turn. ONE assistant turn
  // (class `qwen-chat-message-dual-message`) carries TWO candidate replies, each
  // its own `.response-message-box` inside `.smulti-o-response-message`. The
  // network tap (qwen-net.js) folds BOTH candidates' answer-phase deltas into one
  // accumulator, so its text is the two replies interleaved char-by-char: a
  // command becomes garbage, parseToolCalls() returns nothing, and the loop
  // finalizes the turn as a plain-text answer - so a bogus/unknown command is
  // never even validated (the user-reported "non-existent tool, no error fed
  // back"). Per the product decision we use ONLY the first candidate (sending the
  // next message auto-selects it anyway) and READ IT FROM THE DOM, abandoning the
  // corrupted tap for these turns (see netCurrent() + bodyEl()).
  const isDualItem = (item) =>
    !!item && item.classList && item.classList.contains("qwen-chat-message-dual-message");
  const latestIsDual = () => isDualItem(lastAssistant());

  // Walk element text, skipping .zs-chip and any excluded selector.
  // Special-cases `pre.qwen-markdown-code`: Monaco editor lines are separate
  // sibling divs with no inter-line text nodes, so plain textContent collapses
  // the whole block onto one line. Uses codeText() so a DISPOSED block still
  // yields its full source from the dataset cache (see the cache section above).
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip" + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      if (n.matches && n.matches(S.codeWrap)) {
        const code = codeText(n);
        if (code) { t += "\n" + code; return; }
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  // Reply body: prefer the phase-answer div (excludes thinking-phase cards that
  // live outside it). Falls back to any .response-message-content, then the
  // whole item.
  const bodyEl = (item) => {
    if (!item) return null;
    // A/B turn: restrict every DOM read (text, code, generation) to the FIRST
    // candidate's box so we never mix in candidate 2's reply.
    const scope = isDualItem(item)
      ? item.querySelector(".response-message-box") || item
      : item;
    return (
      scope.querySelector(".response-message-content.phase-answer") ||
      scope.querySelector(S.reply) ||
      scope
    );
  };

  // Reply text for an assistant turn. For the LATEST turn we prefer the network
  // tap (verbatim markdown, immune to Monaco disposal); only fall back to the DOM
  // when the tap has nothing yet (e.g. before qwen-net.js has seen a stream). For
  // OLDER turns we use the DOM (the tap only holds the most recent response).
  function assistantReplyText(item) {
    if (item === lastAssistant()) {
      const net = netReplyFor(item);
      if (net) return net;
    }
    const bd = bodyEl(item);
    return bd ? textWithout(bd) : "";
  }
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) return assistantReplyText(item);
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    // excludeSel only matters for DOM walks (thinking/chip exclusion); the network
    // text is already answer-phase only, so it needs no exclusion.
    if (isAssistantItem(item)) {
      if (item === lastAssistant()) {
        const net = netReplyFor(item);
        if (net) return net;
      }
      const bd = bodyEl(item);
      return bd ? textWithout(bd, excludeSel) : "";
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;

  // Scope to the site's composer only; skip ZeroScript's own injected textarea
  // (#zs-set-text inside #zs-root) so login pages without a site editor return
  // null and the send-hook guards stay intact.
  const getEditor = () => {
    for (const e of document.querySelectorAll(S.editor)) {
      if (!e.closest("#zs-root")) return e;
    }
    return null;
  };
  const editorText = () => {
    const e = getEditor();
    return e ? (e.value || "") : "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-turn identity: each assistant turn carries
  // id="qwen-chat-message-assistant-<uuid>" (validated live, 2026-06). The core's
  // waitForResponse uses this for a virtualization-proof "a NEW reply turn exists"
  // test (curTok !== sendToken) instead of a raw count. CRITICAL: Qwen DOES
  // virtualize its message list (old turns detach as the chat grows), so
  // assistantCount() stops increasing and the count-based newReply test stayed
  // FALSE - which made `reliableCounts && !newReply` wait the full NO_TURN_GRACE
  // (~30s) on EVERY tool turn (the user-seen "tool result takes ~20-30s to inject
  // even though the arrow is back"; scrolling up re-attached old turns, bumped the
  // count past base, and temporarily fixed it). The per-turn id is immune to that.
  function lastAssistantId() {
    const last = lastAssistant();
    if (!last) return null;
    const m = (last.id || "").match(/assistant-([0-9a-f-]{8,})/i);
    return m ? m[1] : (last.id || null);
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () =>
    chatIsEmpty() && /^\/?$/.test(location.pathname) && !!getEditor();

  const composerFrame = () => {
    const ed = getEditor();
    return (ed && ed.closest(S.composer)) || document.querySelector(S.composer);
  };

  // Cover only the textarea row (not the whole wrapper) so mode-select / model
  // dropdowns stay reachable while the start gate is active.
  const gateTarget = () => {
    const ed = getEditor();
    return (ed && ed.closest(".message-input-container-area")) || composerFrame();
  };

  // Anchored bar (the integrated look as it was before the barMount experiment):
  // keep #zs-bar in #zs-root (position:fixed) and hug it to the composer's top
  // edge. We do NOT mount in-flow: `.message-input-container` (the rounded grey
  // card) is React-height-clamped + overflow:hidden, so a child clips the input.
  // The editor is not inside `.chat-message-input-fixed-container` (height:0), so
  // closest() falls through to `.message-input-wrapper` (S.composer), which is the
  // element the core's anchored branch hugs.
  function barAnchor() {
    const ed = getEditor();
    return (
      (ed && ed.closest(".chat-message-input-fixed-container")) ||
      (ed && ed.closest(S.composer)) ||
      null
    );
  }

  // ── Chip anchor ───────────────────────────────────────────────────────────
  // The turn's `.chat-response-message` is a flex ROW; placing the chip there
  // makes it a flex sibling laid out BESIDE the reply text. Redirect into the
  // content COLUMN `.chat-response-message-right` (display:block) so the chip
  // stacks under the text instead of next to it (validated live, 2026-06).
  function chipAnchor(item) {
    if (!item) return item;
    return (
      item.querySelector(".chat-response-message-right") ||
      item.querySelector(".chat-response-message") ||
      item
    );
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Real <textarea>: swap placeholder text and set readonly. No re-assert loop
  // needed -- React doesn't recreate this element between inject/clear cycles.
  const LOCK_MSG = "⏳ Agent working… please wait";
  let _origPlaceholder = null;

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (_origPlaceholder == null) _origPlaceholder = ed.placeholder || "";
      ed.setAttribute("placeholder", LOCK_MSG);
      ed.setAttribute("readonly", "");
      ed.setAttribute("data-zs-locked", "1");
    } else {
      ed.removeAttribute("readonly");
      ed.removeAttribute("data-zs-locked");
      if (_origPlaceholder != null) {
        ed.setAttribute("placeholder", _origPlaceholder);
        _origPlaceholder = null;
      }
    }
  }

  // ── Send / stop control ───────────────────────────────────────────────────
  // `button.send-button` PERSISTS in the DOM even when the textarea is empty, but
  // then it carries `disabled` (class `send-button disabled` + the `disabled`
  // attribute); React drops `disabled` once the box has text. CRITICAL: only
  // return the button when it is ENABLED. Returning the disabled placeholder made
  // typeAndSend's `waitFor(sendButton)` resolve INSTANTLY and click a dead button
  // the same tick the text was set - before React re-enabled it - so the message
  // never sent and the agent loop hung after a tool result (the "stuck on active,
  // tools never sent back" bug). Gating on enabled makes the wait block until the
  // real send control is clickable (same lesson as GLM's send-button re-enable).
  const sendButton = () => {
    const scope =
      document.querySelector(".message-input-right-button-send") ||
      document.querySelector(".chat-prompt-send-button");
    const btn =
      (scope ? scope.querySelector(S.sendBtn) : null) ||
      document.querySelector(S.sendBtn) ||
      null;
    if (!btn) return null;
    if (btn.disabled || btn.classList.contains("disabled")) return null;
    return btn;
  };

  // stop-button: present for the WHOLE generation (including the brief initial
  // frame where it carries class `disabled`). Click it regardless -- Ant Design
  // `disabled` is just a CSS class, not the HTML attribute.
  const stopButton = () => document.querySelector(S.stopBtn) || null;

  // ── Generation detection ──────────────────────────────────────────────────
  // For the latest turn, the network tap's growing text is the most reliable
  // growth signal (DOM/Monaco can re-render non-monotonically); fall back to DOM.
  function streamText(item) {
    if (item === lastAssistant()) {
      const net = netReplyFor(item);
      if (net) return net;
    }
    const bd = bodyEl(item);
    return bd ? textWithout(bd, ".zs-chip") : "";
  }
  const streamLen = (item) =>
    streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // Authoritative generation state from the network tap. Qwen's DOM stop-button
  // LINGERS ~6s after the stream actually finishes (measured live: stream done at
  // ~600ms, button gone at ~6.8s), which made every command take ~6s longer than
  // it should. The tap's `done` flag flips the instant the SSE stream ends, so we
  // trust it: 'streaming' (text, not done) or 'done' (finished). Guarded against a
  // STALE finished tap between turns (same rule as netReplyFor): a done tap only
  // counts as 'done' for the latest turn once that turn's DOM has begun rendering;
  // otherwise return null and fall back to the DOM signals.
  function netGenState() {
    const net = netCurrent();
    if (!net) return null; // no fresh tap -> let DOM signals decide
    if (net.done) return "done";
    // Streaming per the tap. Guard against a tap that never received its final
    // done flag (a missed [DONE]/finished, or an uncaptured request): if the DOM
    // shows no stop button AND the text has been frozen past the idle window, the
    // stream really ended - treat as done so the loop can't hang on a stuck tap.
    if (!stopButton() && !grewWithin(timings.GEN_IDLE_MS)) return "done";
    return "streaming";
  }

  function genActive() {
    sampleStream();
    const g = netGenState();
    if (g === "streaming") return true;
    if (g === "done") return false; // stream finished - ignore the lingering DOM stop button
    if (stopButton()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  // Hard signal: a true DOM stop button, but NOT once the tap says the stream is
  // done (the button lingers ~6s past the real end).
  const isHardGenerating = () => !!stopButton() && netGenState() !== "done";

  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const bd = bodyEl(lastAssistant());
      return { th: 0, rp: bd ? (bd.textContent || "").length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return {
      present: true,
      reply: assistantReplyText(item).trim(),
      thinking: "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // Native textarea setter drives React's synthetic event system. After setting
  // the value, wait for button.send-button to appear (React updates the button
  // asynchronously) before clicking.
  const _nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) throw new Error("Qwen input box not found");
    // Mark the response now in the tap as consumed: we are replying to it, so the
    // tap is stale until Qwen opens the next response (see netCurrent()).
    rememberSentResponse();
    const wasLocked = !!ed.getAttribute("data-zs-locked");
    if (wasLocked) ed.removeAttribute("readonly");
    try {
      if (_nativeSetter) { _nativeSetter.call(ed, text); }
      else { ed.value = text; }
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      ed.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => !!sendButton(), 2000);
      const btn = sendButton();
      if (btn) { btn.click(); return; }
      // Fallback: Enter key
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (wasLocked) ed.setAttribute("readonly", "");
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: !!getEditor() }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "qwen" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection ───────────────────────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && (RE.contextLimit.test(t) || RE.usageLimit.test(t))) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment ──────────────────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    const box = composerFrame();
    return await waitFor(
      () => !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']")),
      15000
    );
  }
  function clearAttachments() {
    try {
      const box = composerFrame();
      if (!box) return;
      box.querySelectorAll("[aria-label*='elete'], [aria-label*='emove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  const conversationKey = () =>
    /^\/?$/.test(location.pathname) ? "" : location.pathname;

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || (e.target !== ed && !ed.contains(e.target))) return;
        if ((ed.value || "").trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest(S.sendBtn);
        if (!btn) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block camouflage ─────────────────────────────────────────────────
  // Each fenced code block is `pre.qwen-markdown-code`. React re-renders the
  // markdown subtree on stream updates, so mark the assistant turn with
  // .zs-cmd-mask and let the CSS rule (overlay.css) re-hide recreated pre
  // elements with no flash.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    const bd = bodyEl(item);
    if (!bd) return null;
    let hidAny = null;
    // If the network tap shows this (latest) turn carries a command, the DOM code
    // block may be disposed/partial - hide EVERY code block in the turn so the raw
    // command never flashes even when codeText() can't see it in the DOM.
    let netHasCmd = false;
    if (item === lastAssistant()) {
      const net = netReplyFor(item);
      netHasCmd = !!(net && CMD_SHAPE.test(net));
    }
    bd.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      // codeText() prefers the dataset cache (survives Monaco disposal) and uses
      // Monaco view-lines otherwise (avoids the header "lang1" textContent prefix).
      const text = codeText(cw);
      if (netHasCmd || CMD_SHAPE.test(text)) {
        cw.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    [...bd.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.closest(S.codeWrap) || el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  // ── Version beacon + unstable-mode warning ────────────────────────────────
  // VERSION beacon: a content script shares the page DOM, so we stamp the loaded
  // build onto <html data-zs-qwen-ver>; read it from the page to confirm which
  // qwen.js is actually running (the isolated-world closure can't be read直接).
  // BUMP this whenever qwen.js changes in a way worth verifying live.
  const QWEN_VER = "2026-06_net-rid-ddwarn2-usagelimit-dualab-turnid-dualgen";
  function setVersionBeacon() {
    try { document.documentElement.setAttribute("data-zs-qwen-ver", QWEN_VER); } catch {}
  }

  // Qwen's "Auto" and "Think" thinking-modes are where the model most often fires
  // its OWN native tool-calls (web search / code runner / function calls) instead
  // of writing ZeroScript commands as text - it then answers in plain text or
  // loops on "Tool X does not exist" (model-side, like Kimi; not fixable from the
  // extension). Per the user, the warning belongs INSIDE the mode dropdown next to
  // those two options (not floating in the composer). When the thinking-mode
  // dropdown (`.qwen-select-thinking-dropdown`) is open we append a small amber
  // note to each unstable option. Cosmetic only.
  const MODE_WARN_CLASS = "zs-qwen-modewarn";
  const UNSTABLE_MODE_RE = /^(auto|think)/i; // "Auto", "Think"/"Thinking"
  function decorateModeDropdown() {
    const dd = document.querySelector(".qwen-select-thinking-dropdown");
    if (!dd) return;
    dd.querySelectorAll(".ant-select-item-option").forEach((opt) => {
      const label = (opt.getAttribute("title") || opt.textContent || "").trim();
      // Existing badge anywhere in the option (we insert into the option itself,
      // NOT into `.ant-select-item-option-content` - that content box is
      // display:block; overflow:hidden; white-space:nowrap, so a badge placed
      // inside it gets CLIPPED to a thin amber sliver. The option is a flex row
      // with overflow:visible, so the badge shows fully there.)
      const existing = opt.querySelector(":scope > ." + MODE_WARN_CLASS);
      if (UNSTABLE_MODE_RE.test(label)) {
        if (!existing) {
          const b = document.createElement("span");
          b.className = MODE_WARN_CLASS;
          b.textContent = "⚠ unstable";
          b.title =
            "In this mode Qwen tends to run its OWN tools instead of the ZeroScript " +
            'commands (plain-text answers or a "Tool X does not exist" loop). Pick a ' +
            "non-thinking mode for steadier Roblox Studio control. Model behavior, " +
            "not the extension.";
          b.style.cssText =
            "flex:none;margin-left:8px;padding:0 6px;border-radius:5px;" +
            "font-size:9px;font-weight:700;letter-spacing:.2px;line-height:18px;" +
            "white-space:nowrap;color:#fbbf24;background:rgba(251,191,36,0.14);" +
            "border:1px solid rgba(251,191,36,0.4);";
          // Sit just before the selected-state checkmark (right edge) when present.
          const state = opt.querySelector(".ant-select-item-option-state");
          opt.insertBefore(b, state || null);
        }
      } else if (existing) {
        existing.remove();
      }
    });
  }
  let _modeObs = null;
  function startModeWatch() {
    setVersionBeacon();
    if (_modeObs) return;
    // The Ant dropdown is created/destroyed on open/close and re-rendered on
    // hover; a body observer lets us (re)decorate it each time it appears. The
    // callback is cheap (one querySelector that no-ops when the dropdown is closed).
    _modeObs = new MutationObserver(decorateModeDropdown);
    try { _modeObs.observe(document.body, { childList: true, subtree: true }); } catch {}
    decorateModeDropdown();
  }

  return {
    id: "qwen",
    displayName: "Qwen",
    timings,
    // React re-renders the reply markdown subtree on every stream update,
    // wiping any chip placed inside it. Anchor chips at the turn-element level
    // (redirected into the reply column by chipAnchor).
    chipAtItemLevel: true,
    chipAnchor,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; ensureCodeObserver(); startModeWatch(); },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, gateTarget, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
