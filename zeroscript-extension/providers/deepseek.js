// SPDX-License-Identifier: GPL-3.0-or-later
// providers/deepseek.js - the DeepSeek (chat.deepseek.com) provider.
// EVERYTHING that knows DeepSeek's DOM, quirks, and UI strings lives here; the
// core (core/main.js) only ever talks to the ZSProvider interface this file
// exports. To support another AI site, write a sibling file exporting the same
// interface and list it (instead of this one) in the manifest's content_scripts.
//
// DeepSeek notes (validated live):
//  - One turn = one .ds-message. User turns carry a hashed modifier class +
//    a `.fbb737a4` bubble; assistant turns carry a `.ds-markdown` body.
//  - DeepThink/R1 reasoning lives in .ds-think-content; the real answer is a
//    .ds-markdown OUTSIDE that container (so drafts inside reasoning are ignored).
//  - The input is a real <textarea> (not a contenteditable): we set its value via
//    the native setter + an input event, then click the primary send button.
//  - "generating" is detected from the primary footer button: while streaming it
//    shows a STOP glyph (a <rect> in old builds, a rounded-square <path> starting
//    "M2…" in V4) and when idle a SEND arrow (<path> starting "M8…"); see
//    isStopBtn(). .ds-loading covers the brief spin-up. During the DeepThink
//    REASONING phase there is NO stop button / spinner at all - only text growth
//    says "still alive".
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // DOM selectors for chat.deepseek.com. Grouped so a future site tweak is a
  // one-liner. DeepSeek ships hashed CSS-module class names (e.g. `d29f3d7d`);
  // where possible we lean on its stable design-system "ds-" classes instead.
  const S = {
    chatItem: ".ds-message",
    userMod: "d29f3d7d", // hashed modifier on user turns (one-liner to update if DeepSeek redeploys)
    userBubble: ".fbb737a4", // user text bubble (secondary signal)
    box: ".ds-markdown",
    editor: "textarea", // DeepSeek uses a real <textarea>, NOT a contenteditable
    thinking: ".ds-think-content",
    markdown: ".ds-markdown",
    generating: ".ds-loading",
    sendBtn: ".ds-button--primary",
    stopBtn: ".ds-button--primary",
    // surfaces where DeepSeek shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    // composer image-attachment area (best-effort; DeepSeek's image support is
    // limited, so the attach path degrades gracefully if these don't match).
    attachArea: ".ds-file-list, [class*='file-preview'], [class*='upload']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
    // ── Composer mode controls (empty chat only) ──────────────────────────
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: ".ds-toggle-button",
  };

  // Error / state regexes (English + French - DeepSeek's UI follows the locale).
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "session.{0,20}(expired|expir\\u00e9e)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    expertMode: /expert|专家|专业/i,
    deepThink: /pensée profonde|pensee profonde|profonde|réflexion|reflexion|deep ?think|深度思考|r1/i,
    searchMode: /recherche intelligente|smart search|search|web|搜索/i,
  };

  // Completion-detection windows, calibrated on DeepSeek's DeepThink behaviour.
  // Exposed so the core's response watcher uses the provider's tuning.
  const timings = {
    GEN_IDLE_MS: 800,        // answer phase: text unchanged this long ⇒ idle
    REASON_IDLE_MS: 12000,   // reasoning stalls of several seconds are NORMAL
    WARMUP_MS: 45000,        // empty turn container may precede the first token
    REASON_NOREPLY_MS: 90000, // reasoning written but no answer yet: keep waiting
    STABLE_MS: 9000,         // generating-flag stuck ON but text frozen → done
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification (multi-signal, virtualization-safe) ──────────────
  function isUserItem(item) {
    if (!item) return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // Text of an item for signature detection. For assistant turns we use ONLY
  // the non-thinking markdown, so tool blocks the model merely drafts inside
  // its reasoning are never detected, shown, or executed.
  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  // Text used by the core to CLASSIFY a turn for camouflage - excludes the
  // reasoning area AND any element matching `excludeSel` (the core's own chip),
  // so a recycled (virtualized) node wearing a stale chip is never mis-detected.
  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  // Scope to the SITE's composer only: never match ZeroScript's own injected
  // UI (e.g. the settings textarea #zs-set-text in #zs-root). Otherwise on the
  // login/OAuth pages - which have no site textarea - getEditor() would return
  // our own panel's textarea, defeating the "not on a chat page" guard in the
  // send hooks and letting them swallow the DeepSeek "Log in" click (which is
  // itself a .ds-button--primary, the same selector as the send button).
  const getEditor = () => {
    for (const e of document.querySelectorAll(S.editor)) {
      if (!e.closest("#zs-root")) return e;
    }
    return null;
  };
  // The composer is a <textarea>, so its live content is .value (NOT textContent).
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return (e.value != null ? e.value : e.textContent || "");
  };

  // Lock / unlock the user textarea during agent activity. `readonly` blocks
  // interactive typing but is IGNORED by the native prototype setter used in
  // setTextareaValue(), so the loop's own injections continue to work normally.
  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // A "blank" conversation = no chat turns rendered yet.
  const chatIsEmpty = () => allItems().length === 0;

  // A genuinely FRESH/new chat (not an existing conversation whose messages are
  // still loading): DeepSeek only shows the Expert/Rapide mode selector on a
  // brand-new empty chat.
  const isFreshChat = () => chatIsEmpty() && !!document.querySelector(S.modeRadioGroup);

  // The whole composer "box" = the smallest ancestor that contains the input, the
  // send button AND (on a blank chat) the Expert/Rapide mode selector. The core's
  // Start gate hides this entire frame at once. Returns null if no input yet.
  function composerFrame() {
    const ta = getEditor();
    if (!ta) return null;
    const sb = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    const targets = [sb, group].filter(Boolean);
    let n = ta;
    for (let i = 0; i < 14 && n && n.parentElement; i++) {
      if (targets.every((t) => n.contains(t))) return n;
      n = n.parentElement;
    }
    // Fallback: a fixed climb from the textarea.
    let f = ta;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  // Where the core inserts its in-flow status bar. The INPUT BOX = the lowest
  // ancestor of the textarea that also holds the send button but NOT the model
  // tabs (so the rounded composer box, excluding Instant/Expert/Vision). It is a
  // vertical flow container (textarea + the DeepThink/Search pill row), so adding
  // the bar as its FIRST child reflows cleanly and spans the full input width.
  function barMount() {
    const ta = getEditor();
    if (!ta) return null;
    const send = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    let box = ta.parentElement;
    while (box && box !== document.body) {
      const holdsSend = !send || box.contains(send);
      const holdsTabs = group && box.contains(group);
      if (holdsSend && !holdsTabs) break; // the input box, without the tabs
      box = box.parentElement;
    }
    if (!box || box === document.body) box = ta.parentElement;
    if (!box) return null;
    // Insert before the first REAL child (skip our own bar if already mounted,
    // otherwise we'd try to insert the bar before itself every frame).
    let before = box.firstElementChild;
    if (before && before.id === "zs-bar") before = before.nextElementSibling;
    return { parent: box, before, inside: true }; // lives INSIDE the input box
  }

  // ── Composer mode: pick Expert (most powerful) at startup, Search OFF ──
  // Driven once at session start only; the user can switch the model tab after.
  const nodeText = (n) => (n && (n.innerText || n.textContent || "").trim()) || "";
  const isPressedOn = (n) =>
    n && (n.getAttribute("aria-pressed") === "true" ||
          n.getAttribute("aria-checked") === "true" ||
          n.classList.contains("ds-toggle-button--selected"));
  const isPressedOff = (n) =>
    n && (n.getAttribute("aria-pressed") === "false" ||
          n.getAttribute("aria-checked") === "false");

  function findExpertRadio() {
    const group = document.querySelector(S.modeRadioGroup);
    const radios = group ? [...group.querySelectorAll(S.modeRadio)] : [...document.querySelectorAll(S.modeRadio)];
    return radios.find((r) => r.getAttribute("data-model-type") === "expert") ||
           radios.find((r) => RE.expertMode.test(nodeText(r))) ||
           null;
  }

  function findToggleBy(re) {
    return [...document.querySelectorAll(S.deepThinkToggle)].find((t) => re.test(nodeText(t))) || null;
  }

  function composerModeState() {
    const expert = findExpertRadio();
    const deepThink = findToggleBy(RE.deepThink);
    const search = findToggleBy(RE.searchMode);
    return {
      expertFound: !!expert,
      expertOn: !!expert && expert.getAttribute("aria-checked") === "true",
      deepThinkFound: !!deepThink,
      deepThinkOn: !!deepThink && isPressedOn(deepThink),
      searchFound: !!search,
      searchOff: !search || !isPressedOn(search),
      searchHiddenInExpert: !search && !!expert && expert.getAttribute("aria-checked") === "true",
    };
  }

  function enforceComposer(reason) {
    // We only DRIVE the composer when given a reason (i.e. at session startup).
    // Per-sweep calls pass no reason and are READ-ONLY: that leaves the user free
    // to switch the model tab afterwards (e.g. Expert → Instant to turn thinking
    // off) without ZeroScript reverting their choice every frame.
    if (!reason) return composerModeState();
    try {
      // Pick the most powerful model for the agent: Expert (deep reasoning). In
      // the current DeepSeek V4 UI, Expert IS the thinking model; the three tabs
      // are Instant / Expert / Vision and there is no separate DeepThink toggle.
      const expert = findExpertRadio();
      if (expert && expert.getAttribute("aria-checked") !== "true") {
        try { expert.click(); } catch (e) { diag("mode_fallback", { reason, target: "expert", error: String(e && e.message || e) }); }
      }

      // Legacy DeepSeek UI only: if a separate DeepThink toggle still exists, turn
      // it ON once. We do NOT hide it anymore, so thinking stays user-toggleable.
      const deepThink = findToggleBy(RE.deepThink);
      if (deepThink && isPressedOff(deepThink)) {
        try { deepThink.click(); } catch (e) { diag("mode_fallback", { reason, target: "deepThink", error: String(e && e.message || e) }); }
      }

      // Search must be off (it derails the agent). Best-effort; absent in Expert.
      const search = findToggleBy(RE.searchMode);
      if (search && isPressedOn(search)) {
        try { search.click(); } catch (e) { diag("mode_fallback", { reason, target: "search", error: String(e && e.message || e) }); }
      }

      const state = composerModeState();
      diag("mode_enforce", { reason, ...state });
      return state;
    } catch (e) {
      diag("mode_fallback", { reason, target: "composer", error: String(e && e.message || e) });
      return composerModeState();
    }
  }

  // Drive the composer into its required modes; returns the final state with
  // `.ready` (the core gates session start on it).
  async function ensureComposerReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 12; i++) {
      state = enforceComposer(reason);
      // Ready as soon as Expert is on and Search is off. DeepThink is only
      // required if a legacy toggle is actually present (V4 has none).
      if (state.expertOn && state.searchOff && (state.deepThinkOn || !state.deepThinkFound)) break;
      await sleep(120);
    }
    state = composerModeState();
    diag("mode_ready", { reason, ...state });
    return { ...state, ready: state.expertOn };
  }

  // DeepSeek's footer button doubles as SEND (an upward arrow) and STOP (a
  // filled rounded square). Older builds drew the stop glyph with a <rect>; the
  // current V4 build draws BOTH as a <path>: the send arrow's path starts
  // mid-glyph ("M8.31…"), the stop square's path starts at a corner near the
  // origin ("M2 …"). We treat the button as "stop" when it carries a <rect> OR a
  // square-ish path (leading move to x ≤ 3) - never the M8 arrow. One-liner to
  // update if DeepSeek reskins the footer button.
  function isStopBtn(btn) {
    if (!btn) return false;
    if (btn.querySelector("rect")) return true; // legacy stop square
    const p = btn.querySelector("path");
    if (!p) return false;
    return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "");
  }

  // ── Generation / completion detection ────────────────────────────────────
  // Everything DeepSeek is streaming for a turn: its reasoning + its answer.
  // Excludes the core's own chip so the live token meter can't masquerade as
  // model output.
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? think.textContent || "" : "";
    const replyTxt = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
      .map((m) => m.textContent)
      .join("");
    return thinkTxt + "\n" + replyTxt;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  // Stream-growth tracking - the ONLY "is it still streaming?" signal during the
  // reasoning phase (no <rect>, no spinner then). We track the MAXIMUM length the
  // current turn has reached and WHEN it last advanced; DOM flicker of a few
  // chars never counts - only a new maximum (see content history for the full
  // war story: counting churn as growth froze the loop).
  let _streamMax = -1, _streamAt = 0, _streamItem = null;

  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    // A new turn - a different node, or a big length drop (a virtualized node
    // recycled into a fresh turn) - starts tracking afresh and counts as active.
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; } // forward progress only
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // True iff `item` is an assistant turn that has begun REASONING but produced no
  // answer yet and has NOT been halted.
  function reasoningInProgress(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    if (!thinkTxt.trim().length) return false; // not reasoning
    const replyLen = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
      .reduce((n, m) => n + (m.textContent || "").length, 0);
    if (replyLen !== 0) return false; // already answering
    if (turnHalted(item)) return false; // halted (manual / forced stop)
    return true;
  }

  // The turn carries DeepSeek's "Arrêté/Stopped" UI marker (manual stop or a
  // forced interruption) - distinguished from the model merely WRITING such a
  // word in its reasoning by requiring the marker OUTSIDE the reasoning text.
  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return RE.stopped.test(item.textContent || "") && !RE.stopped.test(thinkTxt);
  }

  // Growth-tolerant "is a generation in progress?" - the response watcher's signal.
  function isGenerating() {
    if (document.querySelector(S.generating)) return true; // spin-up spinner
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;                       // answer phase: stop square
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(timings.REASON_IDLE_MS);
    return grewWithin(timings.GEN_IDLE_MS);
  }

  // STRICT "is a generation happening RIGHT NOW?" - the gate for SENDING (the send
  // button doubles as stop, so sending mid-generation aborts the turn). Does NOT
  // linger after the answer ends.
  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false; // answer present / stopped → free
    return grewWithin(timings.REASON_IDLE_MS); // reasoning: live only while it keeps growing
  }

  // HARD signal only (the visible stop-square): never true just because a
  // conversation (re)loads or the user scrolls. Used for the Stop button.
  function isHardGenerating() {
    return isStopBtn(document.querySelector(S.sendBtn));
  }

  // Lightweight turn snapshot for diagnostics (reasoning/reply lengths).
  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp };
    } catch { return {}; }
  }

  // ── Truncation "Continue" button ──────────────────────────────────────────
  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue; // not visible
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const th = item.querySelector(`${S.thinking} ${S.markdown}`);
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: th ? th.textContent.trim() : "",
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
  // DeepSeek's composer is a <textarea> driven by React. We must set .value via
  // the native prototype setter so React's onChange fires, then dispatch an input
  // event, then click the primary send button (Enter inserts a newline).
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  // Click DeepSeek's primary footer button to send. Send arrow and stop square
  // are the SAME button, so we refuse to click whenever a generation is live.
  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = document.querySelector(S.sendBtn);
    if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("DeepSeek input box not found");
    editor.focus();
    setTextareaValue(editor, text);
    // Wait for React to re-enable the send button (poll up to 800ms).
    await waitFor(() => {
      const btn = document.querySelector(S.sendBtn);
      return btn && btn.getAttribute("aria-disabled") !== "true" && !isStopBtn(btn);
    }, 800);
    if (!clickSendButton() && !isBusyNow()) {
      pressEnter(editor);
    }
  }

  // Click DeepSeek's stop only if it is actually in the stop state (<rect>), so
  // we never accidentally re-trigger a send.
  function stopGeneration() {
    const b = document.querySelector(S.stopBtn);
    if (isStopBtn(b)) try { b.click(); } catch {}
  }

  // ── Error / limit detection (site chrome only, never model output) ───────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.chatItem)) continue; // inside a chat turn ⇒ model content, not UI
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  // Short SYSTEM-message shapes the site renders as an assistant reply.
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (Studio captures → composer) ────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }

  const attachThumbs = () => {
    try { return [...document.querySelectorAll(`${S.attachArea} ${S.imageThumb}`)]; }
    catch { return []; }
  };

  // Remove any pending attachments from the composer (used to clean up a
  // failed upload so the feedback message still sends as clean text).
  function clearAttachments() {
    try {
      document.querySelectorAll(`${S.attachArea} [class*='delete'], ${S.attachArea} [class*='close'], ${S.attachArea} [class*='remove']`)
        .forEach((d) => ["mouseover", "mousedown", "mouseup", "click"]
          .forEach((t) => { try { d.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch {} }));
    } catch {}
  }

  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const before = attachThumbs().length;
    const want = before + images.length;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    // Try paste first; some builds wire uploads to a hidden <input type=file>.
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }
    // A thumbnail appearing is our success signal.
    return await waitFor(() => attachThumbs().length >= want, 15000);
  }

  // Stable identity of the current conversation (used to persist "started").
  // The root path = a fresh chat with no id yet → "" (transient, never persisted).
  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // ── User-send interception ────────────────────────────────────────────────
  // The core supplies callbacks; this provider wires them to DeepSeek's
  // composer events (Enter key, send-button click, native stop / continue).
  // handlers = {
  //   isBlocked():bool        - agent busy (injecting/running/starting)
  //   isStarted():bool        - a ZeroScript session exists in this chat
  //   onBlockedAttempt()      - user tried to send before starting (fresh chat)
  //   onUserMessage(base)     - a genuine user message is being sent
  //   onNativeStop()          - user clicked the site's own stop button
  //   onNativeContinue()      - user clicked the site's truncation Continue
  // }
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        const text = editorText().trim();
        if (text === "") return;

        if (handlers.isBlocked()) return;

        // No session yet → the user must click "Start session" first. ONLY on a
        // blank chat: an existing conversation isn't ours to gate.
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → let the site handle it
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }

        handlers.onUserMessage(assistantCount());
      },
      true
    );

    // Users also send by CLICKING the send button - handle that path too.
    document.addEventListener(
      "click",
      (e) => {
        // Not on a chat page (e.g. login / OAuth page) - never intercept anything.
        if (!getEditor()) return;
        const t = e.target;
        // The native "Continue" button = a clear intent to RESUME after a stop.
        const cont = t && t.closest && t.closest(".ds-button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        // DeepSeek's stop button shares the send button's spot (square = stop).
        if (isStopBtn(btn)) {
          handlers.onNativeStop();
          return;
        }
        if (btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Hide the raw tool call so nothing of it leaks beside the core's chip.
  // DeepSeek markdown often SPLITS a ###LUA### … ###END_LUA### block across
  // several <p> paragraphs, so we hide the whole CONTIGUOUS RUN of block-level
  // children from the start marker through the end marker. Returns where to
  // insert the chip: {parent, ref} - or null if no tool block was found.
  function findToolBlockSpot(item, chip) {
    const P = ZSParse;
    const hasStart = (t) => P.LUA_START_RE.test(t) || t.includes("###mcp_tool###");
    const hasEnd = (t) => P.LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
    const isJson = (t) => /\{\s*"(?:command|tool)"\s*:/.test(t);
    // The reply markdown containers (never the reasoning/think area).
    const containers = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    if (!containers.length) return null;
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children].filter((k) => k !== chip && !(chip && k.contains(chip)));
      let i = 0;
      while (i < kids.length) {
        const txt = (kids[i].textContent || "");
        const tLow = txt.toLowerCase();
        const startsBlock = hasStart(tLow);
        if (!startsBlock && !isJson(txt)) { i++; continue; }
        // Found the start of a tool block. Hide this child…
        const runStart = i;
        let runEnd = i;
        if (startsBlock && !hasEnd(tLow)) {
          // multi-element LUA/MCP block → extend until the end marker (or, if the
          // turn is still truncated, to the end of this container).
          let j = i + 1;
          runEnd = kids.length - 1;
          for (; j < kids.length; j++) {
            if (hasEnd((kids[j].textContent || "").toLowerCase())) { runEnd = j; break; }
          }
        }
        for (let k = runStart; k <= runEnd; k++) {
          // Prefer hiding the whole code-block wrapper (language label / Copy bar).
          let hide = kids[k];
          const wrap = hide.closest("[class*='code'], .md-code-block");
          if (wrap && container.contains(wrap) && wrap !== container) hide = wrap;
          hide.classList.add("zs-tool-hide");
          if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
        }
        i = runEnd + 1;
      }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: "deepseek",
    displayName: "DeepSeek",
    timings,
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
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
