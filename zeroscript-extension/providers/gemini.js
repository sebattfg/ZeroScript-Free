// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js - the Google Gemini (gemini.google.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Gemini support, simply remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Gemini DOM notes (validated live, 2026-06):
//  - Angular app with SEMANTIC custom elements - far more stable than hashed
//    CSS classes: one exchange = <div.conversation-container> holding a
//    <user-query> AND a <model-response>. We treat each of those two elements
//    as one "turn item" (alternating, in DOM order), which maps 1:1 onto the
//    core's expectations.
//  - The reply markdown lives in <message-content>; thinking-model reasoning
//    lives in <model-thoughts> (absent on non-thinking models).
//  - The composer is a Quill contenteditable (.ql-editor) guarded by Trusted
//    Types CSP: innerHTML assignment THROWS. Inject text via select-all +
//    document.execCommand("insertText") - validated to update Angular state.
//  - The primary action button (in <input-area-v2>) is identified by its
//    <mat-icon fonticon>: "arrow_upward" = send (text present), "stop" =
//    generating (whole stream, start to end - no indicatorless reasoning
//    phase like DeepSeek), "mic" = idle empty. aria-labels are localized,
//    fonticon names are NOT - we anchor on fonticon.
//  - No truncation "Continue" button; no per-turn "stopped" marker we can
//    rely on → findContinueBtn/turnHalted return null/false.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: "user-query",
    assistantItem: "model-response",
    anyItem: "user-query, model-response",
    reply: "message-content",
    thinking: "model-thoughts",
    editor: ".ql-editor[contenteditable='true']",
    inputArea: "input-area-v2",
    codeWrap: "code-block",
    errorSurfaces: 'mat-snack-bar-container,[role="alert"],[class*="error-message"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "limite.{0,20}(de contexte|atteinte)",
        "please.{0,30}start.{0,20}new.{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|temporarily unavailable/i,
  };

  // Gemini streams continuously with a hard stop-icon signal for the WHOLE
  // generation (including thinking), so idle windows can be much tighter than
  // DeepSeek's. Thinking models still get generous reasoning windows.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.tagName === "USER-QUERY";
  const isAssistantItem = (item) => !!item && item.tagName === "MODEL-RESPONSE";

  // Gemini prefixes every turn's textContent with a screen-reader label
  // ("Vous avez dit" / "Gemini a dit", inside .cdk-visually-hidden). That
  // prefix broke the core's anchored matching (e.g. /^Output of '/), so ALL
  // text extraction walks the tree and skips those (and any excluded) subtrees.
  const SR_HIDDEN = ".cdk-visually-hidden, [class*='screen-reader']";
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = SR_HIDDEN + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  // Non-thinking reply text only (tool blocks drafted inside the model's
  // reasoning must never be detected or executed).
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      return md && !md.closest(S.thinking) ? textWithout(md) : "";
    }
    return textWithout(item);
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      if (!md || (excludeSel && md.closest(excludeSel))) return "";
      return textWithout(md, excludeSel);
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;
  // Scope to the SITE's composer only: skip ZeroScript's own injected UI (the
  // settings textarea #zs-set-text in #zs-root). On login/OAuth pages with no
  // site editor this returns null, keeping the "not on a chat page" guard in
  // the send hooks intact (otherwise our own textarea would defeat it and the
  // hooks could swallow the site's login button).
  const getEditor = () => {
    for (const sel of [S.editor, ".ql-editor"]) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.closest("#zs-root")) return e;
      }
    }
    return null;
  };
  const editorText = () => {
    const e = getEditor();
    return e ? e.textContent || "" : "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: the /app route without a conversation id, with the
  // composer rendered and no turns. (An existing conversation that is still
  // loading has an /app/<id> path, so it never gates.)
  const isFreshChat = () =>
    chatIsEmpty() && /\/app\/?$/.test(location.pathname) && !!getEditor();

  // The composer box the Start gate hides as one unit.
  const composerFrame = () => document.querySelector(S.inputArea);

  // Where the core mounts its in-flow status bar. The <input-area-v2> composer
  // sits inside a flex-COLUMN <fieldset.input-area-container>, so inserting the
  // bar right before the composer makes it span the full input width and push
  // the composer down (validated live). Returns {parent, before}.
  function barMount() {
    const ia = composerFrame();
    if (!ia) return null;
    const col = ia.parentElement; // fieldset.input-area-container (flex column)
    if (!col) return null;
    return { parent: col, before: ia };
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Quill is a contenteditable: flipping contenteditable=false would also block
  // our own execCommand injection, so typeAndSend temporarily re-enables it.
  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    const ph = ed.closest("rich-textarea") || ed;
    if (on) ph.setAttribute("data-zs-locked", "1");
    else ph.removeAttribute("data-zs-locked");
  }

  // ── Action button (send / stop / mic) ─────────────────────────────────────
  const iconName = (el) => {
    const i = el && el.querySelector("mat-icon");
    return i ? (i.getAttribute("fonticon") || i.getAttribute("data-mat-icon-name") || (i.textContent || "").trim()) : "";
  };
  function actionButtons() {
    const box = document.querySelector(S.inputArea);
    return box ? [...box.querySelectorAll("button")].filter((b) => b.offsetParent !== null) : [];
  }
  const findButtonByIcon = (name) => actionButtons().find((b) => iconName(b) === name) || null;
  const sendButton = () => findButtonByIcon("arrow_upward");
  const stopButton = () => findButtonByIcon("stop");

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop icon is present for the ENTIRE generation (validated live), which
  // makes detection far simpler than DeepSeek. Growth tracking remains as a
  // belt-and-braces fallback for the instants around start/end.
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return (think ? think.textContent || "" : "") + "\n" + (md ? textWithout(md, ".zs-chip") : "");
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

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

  // CRITICAL Gemini quirk (validated live): the stop button can WEDGE in the ON
  // state after a generation finishes - the icon stays "stop" with the text
  // frozen, forever. Trusting it blindly pinned isGenerating() permanently true,
  // which froze the loop (no send, no auto-resume, Stop button stuck on). So the
  // stop button is treated as "live" only while the stream is actually advancing
  // (or it only just appeared - generation spinning up). Frozen past WEDGE_MS ⇒
  // wedged ⇒ not generating.
  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  // Gemini exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;
  // No truncation Continue button on Gemini.
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      const md = it.querySelector(S.reply);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: md ? (md.textContent || "").length : 0,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return {
      present: true,
      reply: md ? textWithout(md, ".zs-chip").trim() : "",
      thinking: think ? (think.textContent || "").trim() : "",
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
  // Gemini's composer is a Quill editor wrapped by an Angular ControlValueAccessor.
  // We run in the extension's ISOLATED world, so the page's `window.Quill`
  // (and its instance API) is NOT reachable - we can only touch the shared DOM.
  // document.execCommand("insertText") drives the browser's native editing
  // pipeline, which fires the beforeinput/input events Quill's editor listens
  // to → its model updates, .ql-blank clears, the Angular CVA syncs and the send
  // button appears. This works reliably WHEN the composer is actually visible
  // (the Start gate is removed before the loop sends), which it always is during
  // the agentic loop. A selectAll first guarantees we replace any stale content.
  // PERF + FIDELITY (measured live, 2026): a single execCommand("insertText") of a
  // MULTI-LINE string is catastrophically slow in Gemini's Quill editor - every
  // "\n" makes Quill split the content into a new <p> block and re-normalise the
  // whole document, ~80ms PER LINE (linear). A ~90-line system prompt froze the
  // composer for ~7s under the "Working…" cover (big tool outputs stalled too).
  // We instead insert each line with insertText and join them with insertLineBreak
  // (a SOFT break, like Shift+Enter): the content stays in ONE block (~3ms/line,
  // ~430ms for 150 lines) yet Gemini STILL transmits the message as real, separate
  // lines (validated: the sent turn renders one query-text-line per line). Keeping
  // real line structure matters - an earlier attempt that flattened newlines to
  // U+2028 made the image-capable "Flash" model misfire into GENERATING AN IMAGE
  // at boot, because the prompt arrived as one mangled line. The first op runs over
  // the select-all so any stale content is replaced; empty lines skip insertText
  // (an empty insertText collapses the selection and breaks the following inserts).
  function setEditorText(ed, text) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
    }
  }

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) throw new Error("Gemini input box not found");
    const relock = _locked;
    if (relock) ed.setAttribute("contenteditable", "true"); // injection needs it editable
    try {
      setEditorText(ed, text);
      // Wait for Angular to render the send (arrow_upward) button - proof that
      // it registered the text. The Quill-API injection (see setEditorText)
      // fires text-change so this resolves; if it doesn't, the send won't work.
      await waitFor(() => !!sendButton(), 1500);
      const btn = sendButton();
      if (btn) { btn.click(); return; }
      // Fallback: Enter sends in Gemini's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (relock) { const e2 = getEditor(); if (e2) e2.setAttribute("contenteditable", "false"); }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // No site modes to enforce on Gemini (model picker is left to the user).
  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "gemini" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort: paste onto the composer) ──────────────
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
    // An upload preview appearing in the input area is the success signal.
    return await waitFor(() => {
      const box = document.querySelector(S.inputArea);
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    }, 15000);
  }
  function clearAttachments() {
    try {
      const box = document.querySelector(S.inputArea);
      if (!box) return;
      box.querySelectorAll("[aria-label*='upprimer'], [aria-label*='emove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }


  // /app without an id = a fresh chat whose conversation id is not assigned
  // yet → return "" (transient) so the core never persists it as "started".
  const conversationKey = () => (/\/app\/?$/.test(location.pathname) ? "" : location.pathname);

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
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
        const btn = e.target && e.target.closest && e.target.closest(`${S.inputArea} button`);
        if (!btn) return;
        const ic = iconName(btn);
        if (ic === "stop") {
          handlers.onNativeStop();
          return;
        }
        if (ic !== "arrow_upward") return;
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
  // Gemini wraps each fenced code block in a <code-block> element (markers and
  // JSON survive intact in textContent), and a whole ###LUA###…###END_LUA### or
  // ###MCP_TOOL### block is ONE atomic code-block. So hiding is simple and
  // robust: hide every <code-block> in the reply whose text carries a command
  // shape, plus any bare top-level paragraph that holds an inline command (the
  // model is told to use code blocks, but this catches a stray inline one).
  // The host-walk the DeepSeek provider uses is WRONG here - it descends inside
  // a code-block, so hiding the wrapper then fails. The core anchors the chip at
  // the turn level (chipAtItemLevel), so the returned position is unused; this
  // function's real job is applying the .zs-tool-hide classes correctly.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const replies = [...item.querySelectorAll(S.reply)].filter((m) => !m.closest(S.thinking));
    let hidAny = null;
    for (const mc of replies) {
      // 1. Fenced code blocks carrying a command.
      mc.querySelectorAll(S.codeWrap).forEach((cb) => {
        if (cb.closest(".zs-chip")) return;
        if (CMD_SHAPE.test(cb.textContent || "")) {
          cb.classList.add("zs-tool-hide");
          // Angular recreates <code-block> nodes (markdown settle at end of
          // stream + again when the next turn is sent), stripping the class
          // above and flashing the raw command until the next sweep. The
          // <message-content> element KEEPS its identity through those
          // re-renders (validated live), so also mark it: the overlay.css
          // rule `message-content.zs-cmd-mask code-block` keeps every
          // recreated block hidden with zero flash.
          mc.classList.add("zs-cmd-mask");
          hidAny = hidAny || { parent: cb.parentElement, ref: cb };
        }
      });
      // 2. Bare top-level blocks with an inline command (no code-block inside).
      [...mc.children].forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) {
          el.classList.add("zs-tool-hide");
          hidAny = hidAny || { parent: el.parentElement, ref: el };
        }
      });
    }
    return hidAny;
  }

  return {
    id: "gemini",
    displayName: "Gemini",
    timings,
    // Gemini (Angular) re-renders a turn's content subtree on every update,
    // wiping any chip placed inside it. Tell the core to anchor chips at the
    // turn-element level instead, where they survive those re-renders.
    chipAtItemLevel: true,
    // The "Working…" input cover overshoots the editor box by this many px on
    // each side. Gemini's Quill keeps typed text near the rounded corners, so a
    // few px of bleed hides the slivers that would otherwise peek (see placeBar /
    // inputCover). Providers with a native <textarea> omit this (default 0).
    coverPad: 8,
    // Gemini's .ql-editor rect sits a few px below the visual input-box centre,
    // so nudge the "Agent is working…" cover up to read as vertically centred.
    coverOffsetY: -6,
    // Gemini's turn elements are semantic and never virtualized away, so
    // assistantCount() reliably increases for every new reply. The core's
    // watcher uses this to refuse finalizing before this send's reply turn
    // exists (fixes premature loop.end on the previous turn's stable text).
    reliableCounts: true,
    // Shown as a permanent, non-intrusive notice in the ZeroScript panel.
    // Gemini drifts away from emitting tool blocks after a while in long
    // sessions - observed live, model behavior, not something the prompt fixes.
    unstableWarning:
      "Gemini tends to stop using the Roblox tools after a while in long sessions (model behavior, not the extension). " +
      "If it starts answering in plain text instead of acting, remind it to use the commands - or start a new session.",
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
