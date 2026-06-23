// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js - the Kimi (www.kimi.com, Moonshot AI) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and gemini.js;
// the core (core/main.js) is provider-agnostic. To DISABLE Kimi support, remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS +
// main.js AI_SITES).
//
// Kimi DOM notes (validated live, 2026-06):
//  - Vue app. One exchange = a `.segment.segment-user` then a
//    `.segment.segment-assistant`. Each `.segment` is a flex ROW
//    [`.segment-avatar` | `.segment-container`]; the reply markdown lives in
//    `.markdown-container` inside the container column. Because the turn is a
//    flex row, the chip is anchored into `.segment-container` (chipAnchor) so it
//    is not laid out as the avatar's sibling.
//  - The composer is a LEXICAL contenteditable (`.chat-input-editor`,
//    `data-lexical-editor`, text in `<span data-lexical-text>`). select-all +
//    document.execCommand("insertText") drives Lexical's input pipeline (its
//    model updates and the send button enables) - validated live.
//  - The send control is a `<div class="send-button-container">` (NOT a
//    <button>): `disabled` when the box is empty, clickable when text is
//    present, and it gains a `stop` class for the WHOLE generation (the square
//    stop icon). So `.send-button-container.stop` == generating, start to end.
//  - Fenced code = an atomic `.segment-code` wrapper (a `.syntax-highlighter`
//    holding a `<pre class="language-…">`); textContent preserves newlines (no
//    CodeMirror virtualization), so the command JSON survives intact.
//  - New chat: a `.sidebar-new-chat` element. Conversation URL is /chat/<id>;
//    a fresh chat is exactly "/".
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: ".segment-user",
    assistantItem: ".segment-assistant",
    anyItem: ".segment",
    // The reply CONTENT box. A Kimi message is split into sibling blocks inside
    // `.segment-content-box`: prose renders in `.markdown-container` blocks and
    // fenced code in separate `.segment-code` wrappers (NOT inside the prose
    // container), so reading only `.markdown-container` MISSES code/tool calls.
    reply: ".segment-content-box",
    editor: ".chat-input-editor",
    composer: ".chat-box",
    sendBtn: ".send-button-container",
    codeWrap: ".segment-code",
    newChat: ".sidebar-new-chat",
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[class*="notification"]',
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
  };

  // Kimi streams with a hard stop-class signal for the WHOLE generation, so
  // completion windows can be tight like Gemini.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.matches && item.matches(S.userItem);
  const isAssistantItem = (item) => !!item && item.matches && item.matches(S.assistantItem);

  // Walk an element's text, skipping our own chip and any excluded subtree.
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".zs-chip" + (excludeSel ? ", " + excludeSel : "");
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

  // The reply body (assistant answer / user text): the content box that holds
  // EVERY block (prose + code) of the message. Falls back to the whole turn.
  const bodyEl = (item) =>
    item ? item.querySelector(S.reply) || item.querySelector(".segment-content") || item : null;

  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = bodyEl(item);
      return md ? textWithout(md) : "";
    }
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = bodyEl(item);
      return md ? textWithout(md, excludeSel) : "";
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
    for (const e of document.querySelectorAll(S.editor)) {
      if (!e.closest("#zs-root")) return e;
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
  // A genuinely fresh chat: the "/" route with the composer rendered and no
  // turns. (A real conversation has a /chat/<id> path, so it never gates.)
  const isFreshChat = () =>
    chatIsEmpty() && /^\/?$/.test(location.pathname) && !!getEditor();

  // The composer box the Start gate hides as one unit.
  const composerFrame = () => {
    const ed = getEditor();
    return (ed && (ed.closest(S.composer) || ed.closest(".chat-input"))) ||
      document.querySelector(S.composer);
  };

  // The element the Start-gate cover should hug. composerFrame() is `.chat-box`,
  // which is full page width AND tall enough to swallow the toolbar row (model
  // selector / Agent / send) that lives below the text box in `.chat-editor` -
  // covering it made the gate huge and blocked the user from picking a mode.
  // The text input box alone is `.chat-input`; cover only that so the toolbar
  // stays reachable. (Typing/sending is still gated by installSendHooks.)
  const gateTarget = () => {
    const ed = getEditor();
    return (ed && (ed.closest(".chat-input") || ed.closest(".chat-input-editor-container"))) ||
      composerFrame();
  };

  // ── Chip anchor ───────────────────────────────────────────────────────────
  // The turn is a flex ROW [avatar | container]; inserting the chip at the turn
  // root's firstChild would make it the avatar's flex sibling and shove the
  // message sideways. Redirect it into the content column.
  function chipAnchor(item) {
    if (!item) return item;
    return item.querySelector(".segment-container") || item;
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Lexical is a contenteditable: flipping contenteditable=false would also block
  // our own execCommand injection, so typeAndSend temporarily re-enables it.
  // Lexical has no `placeholder` attribute (unlike DeepSeek's textarea); its
  // placeholder is a sibling `.chat-input-placeholder` element shown while the
  // editor is empty - so we swap ITS text to surface the "Agent working" notice
  // (validated live: the text sticks, Lexical does not rewrite it).
  let _locked = false;
  const placeholderEl = () => {
    const ed = getEditor();
    const cont = ed && (ed.closest(".chat-input-editor-container") || ed.parentElement);
    return cont ? cont.querySelector(".chat-input-placeholder") : null;
  };
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    const ph = placeholderEl();
    if (on) {
      ed.setAttribute("data-zs-locked", "1");
      if (ph) {
        if (ph.dataset.zsPlaceholder == null) ph.dataset.zsPlaceholder = ph.textContent || "";
        ph.textContent = "⏳ Agent working… please wait";
      }
    } else {
      ed.removeAttribute("data-zs-locked");
      if (ph && ph.dataset.zsPlaceholder != null) {
        ph.textContent = ph.dataset.zsPlaceholder;
        delete ph.dataset.zsPlaceholder;
      }
    }
  }

  // ── Send / stop control ────────────────────────────────────────────────────
  // `.send-button-container` is a <div>: `disabled` when empty, `stop` while
  // generating, plain (clickable) when there is text to send.
  const sendControl = () => {
    const c = composerFrame();
    return (c && c.querySelector(S.sendBtn)) || document.querySelector(S.sendBtn);
  };
  const isStop = (el) => !!el && el.classList.contains("stop");
  const isDisabled = (el) => !!el && el.classList.contains("disabled");
  function sendButton() {
    const el = sendControl();
    return el && !isStop(el) && !isDisabled(el) ? el : null;
  }
  function stopButton() {
    const el = sendControl();
    return isStop(el) ? el : null;
  }

  // ── Generation detection ──────────────────────────────────────────────────
  function streamText(item) {
    const md = bodyEl(item);
    return md ? textWithout(md, ".zs-chip") : "";
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

  // The stop class is present for the ENTIRE generation and clears when it ends
  // (validated live), so we trust it; the growth check only covers the brief
  // tail right after it clears.
  function genActive() {
    sampleStream();
    if (stopButton()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  // No reliable per-turn "stopped" marker, no truncation "Continue" button.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const md = bodyEl(lastAssistant());
      return { th: 0, rp: md ? (md.textContent || "").length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const md = bodyEl(item);
    return {
      present: true,
      reply: md ? textWithout(md, ".zs-chip").trim() : "",
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
  // Lexical contenteditable: select-all then a single execCommand("insertText")
  // drives the native editing pipeline so Lexical's model updates and the send
  // control enables.
  function setEditorText(ed, text) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
  }

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) throw new Error("Kimi input box not found");
    const relock = _locked;
    if (relock) ed.setAttribute("contenteditable", "true"); // injection needs it editable
    try {
      setEditorText(ed, text);
      // Wait for the send control to enable (proof Lexical registered the text).
      await waitFor(() => !!sendButton(), 1500);
      const btn = sendButton();
      if (btn) { btn.click(); return; }
      // Fallback: Enter sends in Lexical's composer.
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

  // No site modes to enforce (model / thinking toggle left to the user).
  function enforceComposer() { return { ready: !!getEditor() }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "kimi" });
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
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
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

  // ── New chat navigation ───────────────────────────────────────────────────
  function findNewChatButton() {
    for (const b of document.querySelectorAll(S.newChat)) {
      if (b.offsetParent === null) continue;
      return b;
    }
    return null;
  }
  async function openNewChat() {
    const btn = findNewChatButton();
    if (!btn) return false;
    const prevPath = location.pathname;
    try { btn.click(); } catch {}
    await waitFor(() => location.pathname !== prevPath && chatIsEmpty() && !!getEditor(), 6000);
    await waitFor(() => chatIsEmpty() && !!getEditor(), 2000);
    return true;
  }

  // /chat/<id> = a real conversation. "/" = a fresh chat with no id yet → ""
  // (transient) so the core never persists it as "started".
  const conversationKey = () => (/^\/?$/.test(location.pathname) ? "" : location.pathname);

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
          e.preventDefault();
          e.stopImmediatePropagation();
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
        const ctrl = e.target && e.target.closest && e.target.closest(S.sendBtn);
        if (!ctrl) return;
        // Stop class = a native stop intent.
        if (isStop(ctrl)) { handlers.onNativeStop(); return; }
        if (isDisabled(ctrl)) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Each fenced code block is an atomic `.segment-code` wrapper (markers + JSON
  // survive in textContent). Vue re-renders the markdown subtree on stream
  // updates, so - like Gemini - hide every `.segment-code` in the reply carrying
  // a command shape AND mark the assistant turn (.segment-assistant, which keeps
  // its identity) with .zs-cmd-mask so the overlay.css rule re-hides recreated
  // wrappers with zero flash. Also catch a stray bare inline command paragraph.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const md = bodyEl(item);
    if (!md) return null;
    let hidAny = null;
    md.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    [...md.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.closest(S.codeWrap) ||
          el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "kimi",
    displayName: "Kimi",
    timings,
    // Vue re-renders the reply's markdown subtree on every update, wiping any
    // chip placed inside it. Anchor chips at the turn-element level instead
    // (redirected into the content column by chipAnchor).
    chipAtItemLevel: true,
    chipAnchor,
    // Turns accumulate and are not virtualized for normal lengths, so
    // assistantCount() reliably increases for every reply.
    reliableCounts: true,
    // Shown as a permanent, non-intrusive notice in the ZeroScript panel.
    // Kimi sometimes reaches for its OWN built-in/native tools (web search, code
    // runner, etc.) instead of emitting the ZeroScript command blocks that drive
    // Roblox Studio - model behavior, not something the prompt fully prevents.
    unstableWarning:
      "Kimi sometimes uses its own native tools instead of the Roblox commands (model behavior, not the extension). " +
      "If it stops acting in Roblox Studio and answers in plain text or runs its own tools, remind it to use the ZeroScript commands - or start a new session.",
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, gateTarget,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, openNewChat, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
