// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js - the Kimi (kimi.ai / www.kimi.com, Moonshot AI) provider.
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
//  - Conversation URL is /chat/<id>; a fresh chat is exactly "/".
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
    // K2.6 Thinking renders its reasoning in a `.thinking-container` (a
    // `.toolcall-container`) that sits INSIDE `.segment-content-box`, as a
    // SIBLING of the answer's `.markdown-container` (validated live). Without
    // excluding it, the reasoning text is read as part of the reply - so a
    // command the model merely DRAFTS while thinking would be detected and
    // executed, and its quoted command JSON keeps the chip flapping. All reply
    // reads (itemText/classifyText/readAssistant) and the camouflage exclude it.
    thinking: ".thinking-container",
    editor: ".chat-input-editor",
    composer: ".chat-box",
    sendBtn: ".send-button-container",
    // Kimi's own agentic mode. UPDATED for K3 (validated live 2026-07-30): the
    // old `.tool-switch` toggle next to the "+" is GONE - that slot is now a
    // `.toolkit-trigger-btn` menu - and the model dropdown no longer offers an
    // "Agent" entry at all. The three options are now `Instantané` / `K3` /
    // `K3 Swarm`, and K3 Swarm is the agentic one ("Recherche massive,
    // traitement…"), so the model LABEL is the only signal left worth reading.
    // Kept as a selector (not inlined) because the label node also moved: it is
    // `.current-model .model-name` now, with `.name` still matching on older
    // builds - we query both.
    currentModelName: ".current-model .model-name, .current-model .name",
    codeWrap: ".segment-code",
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
    // NB: the core no longer acts on isBusyMsg (a "busy" reply just ends the loop
    // as a normal terminal turn), but keep this matching the site's ACTUAL error
    // phrasing, not the model's prose: a bare "try again" / "réessayer" also fires
    // on normal answers that tell the USER to try again (e.g. "the Blender addon
    // isn't running... then try again"). Require "please try again" / "réessayer
    // plus tard".
    busy: /something went wrong|une erreur s.est produite|please try again|réessayer plus tard|server is busy|serveur est occup|rate.?limit|too many requests|系统繁忙|请稍后再试/i,
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

  // Combine the reasoning-area exclusion with any caller-supplied selector.
  const notThink = (excludeSel) => S.thinking + (excludeSel ? ", " + excludeSel : "");

  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = bodyEl(item);
      return md ? textWithout(md, S.thinking) : "";
    }
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = bodyEl(item);
      return md ? textWithout(md, notThink(excludeSel)) : "";
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
    const site = [...document.querySelectorAll(S.editor)].filter(
      (e) => !e.closest("#zs-root")
    );
    // Prefer the bottom composer over the inline message-EDIT box. Editing a turn
    // mounts a second .chat-input-editor up in the message list; it precedes the
    // composer in DOM order, so the old "first editor" pick returned it - and
    // barAnchor() then hugged the fixed ZeroScript bar over the editor. The real
    // composer lives inside the `.chat-editor` card; the edit box does not.
    return site.find((e) => e.closest(".chat-editor")) || site[0] || null;
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

  // Deliberately NO barMount(): an in-flow mount (as DeepSeek/Gemini do) is
  // unsafe on Kimi because every candidate parent is inside Vue's reconciled
  // subtree - inserting our foreign #zs-bar into `.chat-editor` makes Vue's next
  // diff reuse the bar node as a host and nest the composer editor INSIDE it,
  // breaking typing entirely (observed live). Instead we expose barAnchor():
  // the core keeps the bar in its own #zs-root (position:fixed) but positions it
  // to hug the composer card's top edge at full width and reserves that strip
  // with padding-top, giving the integrated DeepSeek look with zero DOM
  // insertion into Vue's tree. The element to hug is the rounded composer card
  // `.chat-editor` (holds the text box then the toolbar row).
  function barAnchor() {
    const ed = getEditor();
    return (ed && ed.closest(".chat-editor")) || null;
  }

  // ── Chip anchor ───────────────────────────────────────────────────────────
  // The turn is a flex ROW [avatar | container]; inserting the chip at the turn
  // root's firstChild would make it the avatar's flex sibling and shove the
  // message sideways. Redirect it into the content COLUMN `.segment-content` (a
  // block-flow column holding, in order, `.segment-content-box` (the reply),
  // an optional `.okc-cards-container`, then `.segment-assistant-actions` (the
  // copy/regenerate toolbar) - validated live). With chipAppend below the chip
  // stacks UNDER the reply there (parity with Qwen) instead of above the turn.
  function chipAnchor(item) {
    if (!item) return item;
    return (
      item.querySelector(".segment-content") ||
      item.querySelector(".segment-container") ||
      item
    );
  }

  // With chipAppend the chip trails the reply text - but the LAST child of
  // `.segment-content` is the action toolbar (`.segment-assistant-actions`), so
  // a plain append would sink the chip below the copy/regenerate buttons. Name
  // that toolbar as the fixed point the chip must stay just BEFORE (mirrors
  // Qwen's chipTrailRef). Returns null while streaming (toolbar not mounted yet),
  // so the chip simply appends after the reply until the toolbar appears, then
  // ensureOwnedChip's drift check re-seats it above the toolbar.
  function chipTrailRef(item) {
    const anchor = chipAnchor(item);
    return (anchor && anchor.querySelector(":scope > .segment-assistant-actions")) || null;
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Lexical is a contenteditable: flipping contenteditable=false would also block
  // our own execCommand injection, so typeAndSend temporarily re-enables it.
  // Lexical has no `placeholder` attribute (unlike DeepSeek's textarea); its
  // placeholder is a sibling `.chat-input-placeholder` element shown while the
  // editor is empty - so we swap ITS text to surface the "Agent working" notice.
  // IMPORTANT: Vue RECREATES that placeholder node after every inject/clear cycle
  // (validated live), dropping our text - so while locked we re-assert it on a
  // small interval rather than setting it once. The site's real placeholder text
  // is captured the first time we lock so we can restore it on unlock regardless
  // of which (recreated) node is current.
  const LOCK_MSG = "⏳ Agent working… please wait";
  let _locked = false, _phTimer = null, _phObs = null, _origPlaceholder = null;
  // Set true only for the brief window typeAndSend re-enables the editor to
  // inject text - so the self-healing lock below doesn't fight the injection.
  let _injecting = false;
  const placeholderEl = () => {
    const ed = getEditor();
    const cont = ed && (ed.closest(".chat-input-editor-container") || ed.parentElement);
    return cont ? cont.querySelector(".chat-input-placeholder") : null;
  };
  const lockContainer = () => {
    const ed = getEditor();
    return ed && (ed.closest(".chat-input") || ed.closest(".chat-input-editor-container") || ed.parentElement);
  };
  function applyLockedPlaceholder() {
    if (!_locked) return;
    // Self-heal the input lock: Vue re-renders the editor subtree (this observer
    // fires on exactly those mutations) and can reset contenteditable back to
    // true, letting the user type mid-run. Re-assert it - except while injecting,
    // when typeAndSend deliberately re-enables it.
    if (!_injecting) {
      const ed = getEditor();
      if (ed && ed.getAttribute("contenteditable") !== "false") {
        ed.setAttribute("contenteditable", "false");
      }
    }
    const ph = placeholderEl();
    if (!ph) return;
    const cur = ph.textContent || "";
    if (cur === LOCK_MSG) return;
    if (_origPlaceholder == null) _origPlaceholder = cur; // first real text seen
    ph.textContent = LOCK_MSG;
  }
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (on) {
      if (ed) { ed.setAttribute("contenteditable", "false"); ed.setAttribute("data-zs-locked", "1"); }
      applyLockedPlaceholder();
      // Vue recreates the placeholder node after each inject/clear cycle, so watch
      // the composer subtree and re-assert our text the instant it reappears (no
      // flash of the site's default text). A slow interval backstops the observer.
      const cont = lockContainer();
      if (cont && !_phObs) {
        _phObs = new MutationObserver(applyLockedPlaceholder);
        try { _phObs.observe(cont, { childList: true, subtree: true }); } catch {}
      }
      if (!_phTimer) _phTimer = setInterval(applyLockedPlaceholder, 400);
    } else {
      if (_phObs) { try { _phObs.disconnect(); } catch {} _phObs = null; }
      if (_phTimer) { clearInterval(_phTimer); _phTimer = null; }
      if (ed) { ed.setAttribute("contenteditable", "true"); ed.removeAttribute("data-zs-locked"); }
      // Restore the site's own placeholder text on whatever node is current now.
      const ph = placeholderEl();
      if (ph && _origPlaceholder != null) ph.textContent = _origPlaceholder;
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
      const item = lastAssistant();
      const md = bodyEl(item);
      const think = item && item.querySelector(S.thinking);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: md ? textWithout(md, S.thinking).length : 0,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const md = bodyEl(item);
    const think = item.querySelector(S.thinking);
    return {
      present: true,
      reply: md ? textWithout(md, notThink()).trim() : "",
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

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("Kimi input box not found");
    const relock = _locked;
    if (relock) { _injecting = true; ed.setAttribute("contenteditable", "true"); } // injection needs it editable
    try {
      if (editorText() !== text) setEditorText(ed, text);
      // Attach images LAST, right before the send click - see gemini.js's
      // typeAndSend for why (attaching before retyping the text can sever the
      // site's binding between the pending upload and the message being sent).
      // submitAndGetBase RETRIES this function; only attach if nothing is pending
      // yet, else each retry uploads ANOTHER duplicate copy.
      if (images && images.length && !hasPendingAttachment()) {
        try { await attachImages(images); } catch {}
      }
      // Wait for the send control to enable (proof Lexical registered the text).
      await waitFor(() => !!sendButton(), 1500);
      const btn = sendButton();
      if (btn) { btn.click(); return; }
      // Fallback: Enter sends in Lexical's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (relock) { const e2 = getEditor(); if (e2) e2.setAttribute("contenteditable", "false"); _injecting = false; }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // Kimi's own agentic mode (see S.currentModelName above) makes the model favor
  // its built-in tools over the ZeroScript command protocol. On K3 the only
  // remaining signal is the model-selector label.
  function nativeAgentModeOn() {
    const m = document.querySelector(S.currentModelName);
    // "K3 Swarm" (current) or "…Agent" (older builds). Both make Kimi reach for
    // its own tooling instead of emitting ZeroScript command blocks.
    return !!(m && /swarm|agent/i.test(m.textContent || ""));
  }
  // Visible mode guard for the ZeroScript bar (core renderBar reads this every
  // sweep, same mechanism as arena.js's modeWarning). Returns a warning string
  // while Kimi's native Agent mode is on, "" otherwise. The core turns this
  // into a red warning state and disables Start until the user switches it off.
  function modeWarning() {
    if (nativeAgentModeOn())
      return `Switch the model picker off <b>K3 Swarm</b> (pick <b>K3</b> or <b>Instantané</b>) - ` +
        `Kimi's own agentic mode replaces the ZeroScript commands with its native tools and breaks the agent loop.`;
    return "";
  }

  // A blocking modal is open over the page. Kimi renders these as full-screen
  // fixed masks - NOT a [role="dialog"], so the generic dialog probe used by other
  // providers misses them. Two kinds seen:
  //   .login-modal-mask - the login / sign-up card ("Continue with Google").
  //   .modal-mask       - mid-session nags (e.g. the "Too many people are chatting…
  //                       Subscribe to enter a priority queue" Tips popup on K3).
  // While one is up, our anchored bar (a real, full-width element hugging the
  // composer's top edge) sits ON TOP of the mask and the "⚠ unstable" pill floats
  // over the card - both intercept clicks meant for the modal's buttons. The core
  // hides the whole bar whenever this is true (it reappears the instant the mask
  // clears). The masks stay in the DOM when dismissed, so check real visibility,
  // not mere presence.
  const MODAL_MASK_SEL = ".login-modal-mask, .modal-mask";
  function overlayBlocking() {
    for (const mask of document.querySelectorAll(MODAL_MASK_SEL)) {
      if (mask.closest("#zs-root")) continue;
      const s = getComputedStyle(mask);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue;
      const r = mask.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return true;
    }
    return false;
  }

  // ── Default the model on a fresh chat ─────────────────────────────────────
  // Pick a model that actually speaks the ZeroScript command protocol, ONCE,
  // whenever we arrive on an empty chat (page load OR "New Chat"). Not enforced
  // every sweep: if the user deliberately switches afterwards on that same empty
  // chat, we leave it - we only re-arm on a transition INTO a new empty chat.
  //
  // UPDATED for K3 (validated live 2026-07-30). The old code hunted for a row
  // matching /^K2\.6/ and that model NO LONGER EXISTS: the picker now offers
  // `Instantané` / `K3` / `K3 Swarm`. The result was an infinite loop - the
  // target row was never found, so nothing ever disarmed the routine and every
  // sweep re-clicked the picker open (the "it keeps picking the mode at the
  // bottom right of the composer" report). Two fixes, one behavioural and one
  // structural:
  //   1. Accept any GOOD model (K3, or K2.6 on an older build) and treat the
  //      default landing model (Instantané) as acceptable too - it works fine
  //      with the protocol, so there is no reason to fight the user's UI for it.
  //      K3 Swarm is the ONLY one that must never be auto-selected (it is Kimi's
  //      agentic mode - see nativeAgentModeOn/modeWarning).
  //   2. A hard attempt cap, so the NEXT time Kimi renames a model this degrades
  //      into "gave up quietly" instead of a UI loop.
  const modelBtn = () => document.querySelector(".current-model");
  // LANGUAGE NOTE: test for the ONE model we must avoid, never for a list of
  // models we like. Kimi's UI is localized (the picker reads "Instantané" in
  // French, "Instant" in English, and Kimi is a Chinese product so other locales
  // exist), so an allow-list of good names fails open in every language it does
  // not happen to spell out - and "current model is not in my list" would send
  // this routine hunting for a replacement row that it also cannot name. Only
  // "Swarm" actually breaks the command protocol, so that is the only thing we
  // match. Anything else is left strictly alone, in any language.
  const SWARM_RE = /swarm|集群|蜂群/i;
  const currentModelIsUsable = () => !SWARM_RE.test((modelBtn() || {}).textContent || "");
  const MAX_PICKER_TRIES = 6;
  const visibleModelItems = () =>
    [...document.querySelectorAll(".model-item")].filter(
      (el) => !el.className.includes("content") && el.offsetParent !== null
    );
  let defaultArmed = false, lastDefaultKey = null, lastPickerOpen = 0, pickerTries = 0;
  function applyDefaultModel() {
    // Re-arm on every transition into a fresh/empty chat (landing or New Chat).
    const key = conversationKey();
    if (key !== lastDefaultKey) {
      lastDefaultKey = key;
      if (chatIsEmpty()) { defaultArmed = true; pickerTries = 0; }
    }
    if (!defaultArmed) return;
    // Only act on an empty composer with no modal in the way; never mid-turn.
    if (!chatIsEmpty() || !getEditor() || overlayBlocking() || isGenerating()) return;
    if (currentModelIsUsable()) { defaultArmed = false; return; } // already fine, no UI

    // Only reached when the CURRENT model is Swarm. The picker needs a click to
    // open, then its rows render a tick later, so this spans two sweeps: open the
    // dropdown on one, click the target on the next. "Any row that is not Swarm"
    // is language-independent, unlike naming the model we want.
    const target = visibleModelItems().find((el) => !SWARM_RE.test(el.textContent || ""));
    if (target) { target.click(); defaultArmed = false; return; } // picker auto-closes
    // Nothing usable on offer (Kimi renamed things again): give up rather than
    // re-opening the picker forever. modeWarning() still tells the user what to do.
    if (++pickerTries > MAX_PICKER_TRIES) {
      diag("kimi.defaultModel.giveUp", { tries: pickerTries, label: (modelBtn() || {}).textContent });
      defaultArmed = false;
      return;
    }
    if (Date.now() - lastPickerOpen > 400) {
      const b = modelBtn();
      if (b) { b.click(); lastPickerOpen = Date.now(); }
    }
  }

  // No other site modes to enforce (thinking toggle left to the user); the model
  // default is a one-shot per fresh chat, not a per-sweep enforcement.
  function enforceComposer() { applyDefaultModel(); return { ready: !!getEditor() }; }
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
  // The PENDING upload's thumbnail (`.image-thumbnail`, in the composer's
  // `.carousel-scroll`). Kimi ALSO keeps every SENT image's `.image-thumbnail`
  // in the conversation history (inside a `.segment-user` turn), so a plain
  // document-wide query would count a leftover from the PREVIOUS capture as if
  // an upload were already pending - which made the 2nd (and every later)
  // capture never attach: hasPendingAttachment() stayed true, so typeAndSend
  // skipped attachImages. Exclude history turns. Both the pending thumb and the
  // hidden <input> sit OUTSIDE `.chat-box` (a body-portalled popover / carousel),
  // so we can't scope to the composer - we filter out `.segment-user` instead.
  // (Validated live: pending thumb parent = `.carousel-scroll`; sent thumb is
  // under `.segment-user > .attachment-list`.)
  const pendingThumb = () => {
    for (const n of document.querySelectorAll(".image-thumbnail")) {
      if (!n.closest(S.userItem)) return n;
    }
    return null;
  };
  const hasPendingAttachment = () => !!pendingThumb();
  const fileInput = () =>
    document.querySelector("input.hidden-input") || document.querySelector('input[type="file"]');

  async function attachImages(images) {
    if (!images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    // Kimi's Lexical composer IGNORES a synthetic file-paste (validated live: the
    // paste event produced no preview at all). Uploads go exclusively through the
    // hidden <input type=file> that the "+" toolkit menu mounts on demand - it is
    // NOT in the DOM on a fresh load, so open the menu first when it's missing.
    let fi = fileInput();
    let opened = null; // the "+" trigger, set only if WE had to open the menu
    if (!fi) {
      opened = document.querySelector(".toolkit-trigger-btn");
      if (opened) { try { opened.click(); } catch {} } // opens menu → mounts the input
      await waitFor(() => !!fileInput(), 2500);
      fi = fileInput();
    }
    if (!fi) { diag("attach.noFileInput"); return false; }
    diag("attach.setFiles", { count: dt.items.length });
    try { fi.files = dt.files; fi.dispatchEvent(new Event("change", { bubbles: true })); }
    catch (e) { diag("attach.setFilesThrew", { msg: String((e && e.message) || e) }); return false; }
    // A real file pick closes the toolkit menu; our programmatic set doesn't, and
    // Escape does NOT dismiss it (validated live). Toggle the trigger to close it
    // so it doesn't sit open over the composer. The hidden input persists once
    // mounted, so later captures reuse it without reopening the menu.
    if (opened) { try { opened.click(); } catch {} }
    // The thumbnail mounts as `.image-thumbnail … loading` and flips to `… success`
    // once the upload to Kimi's backend completes (validated live: ~5.8s for a
    // 10MB image). Sending while still `loading` silently drops the attachment, so
    // wait for `success` - or bail on an `error` state.
    if (!(await waitFor(pendingThumb, 15000))) { diag("attach.noThumb"); return false; }
    await waitFor(() => {
      const c = (pendingThumb() && pendingThumb().className) || "";
      return /\bsuccess\b/.test(c) || /\berror\b/.test(c);
    }, 30000);
    const cls = (pendingThumb() && pendingThumb().className) || "";
    diag("attach.uploadDone", { cls });
    return /\bsuccess\b/.test(cls);
  }
  function clearAttachments() {
    try {
      // Kimi's per-thumbnail remove control (revealed on hover) is
      // `.image-delete-container`; click every one to drop pending uploads.
      document.querySelectorAll(".image-delete-container")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
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
        const ctrl = e.target && e.target.closest && e.target.closest(S.sendBtn);
        if (!ctrl) return;
        // Stop class = a native stop intent.
        if (isStop(ctrl)) { handlers.onNativeStop(); return; }
        if (isDisabled(ctrl)) return;
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
  // Each fenced code block is an atomic `.segment-code` wrapper (markers + JSON
  // survive in textContent). Vue re-renders the markdown subtree on stream
  // updates, so - like Gemini - hide every `.segment-code` in the reply carrying
  // a command shape AND mark the assistant turn (.segment-assistant, which keeps
  // its identity) with .zs-cmd-mask so the overlay.css rule re-hides recreated
  // wrappers with zero flash. Also catch a stray bare inline command paragraph.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  // A block whose text STARTS with a command (optionally behind a ```json fence).
  // Used to hide a command Kimi rendered as a nested <div class="paragraph"> at
  // ANY length - the length-capped direct-children pass misses those on two
  // counts (nesting + a big inline command over the cap).
  const STARTS_CMD = /^\s*(?:```(?:json)?\s*)?(?:\{?\s*"(?:command|tool)"\s*:|###\s*lua|###mcp_tool###)/i;
  function findToolBlockSpot(item /*, chip */) {
    const md = bodyEl(item);
    if (!md) return null;
    let hidAny = null;
    md.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip") || cw.closest(S.thinking)) return; // never a drafted-in-reasoning block
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    [...md.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.closest(S.codeWrap) ||
          el.matches(S.thinking) || el.querySelector(S.thinking) ||
          el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    // Nested inline-command paragraphs. Kimi sometimes renders a command as a
    // <div class="paragraph"> deep inside .markdown (not a code block and not a
    // direct child of md), so BOTH passes above miss it and the raw JSON leaks -
    // and a big execute_blender_code/multi_edit written this way (1868 chars, seen
    // live) also blows past the <600 cap. Scan such blocks anywhere in the reply
    // and hide any whose text STARTS with a command (so it IS the command, never a
    // prose answer that merely quotes one), at any length.
    md.querySelectorAll(".paragraph, p").forEach((el) => {
      if (el.classList.contains("zs-tool-hide") || el.closest(".zs-chip") ||
          el.closest(S.codeWrap) || el.closest(S.thinking)) return;
      if (STARTS_CMD.test((el.textContent || "").trim())) {
        el.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "kimi",
    displayName: "Kimi",
    // Confirmed live: Kimi (K2.6) reads attached images - it correctly described
    // a test screenshot's content. So screen_capture is exposed here (see main.js
    // BLOCKED_TOOLS gate); attachImages uploads via the toolkit file input, and
    // the capture is shown in the core's left-hand ZeroScript popup (ui.showImages).
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible probes
    // exclude it (same fix as DeepSeek/Gemini): K2.6 Thinking quotes the command
    // JSON in its reasoning, which the camouflage never hides - without this the
    // core reads it as "raw block still visible" forever and the chip flaps.
    thinkingSel: S.thinking,
    // Vue re-renders the reply's markdown subtree on every update, wiping any
    // chip placed inside it. Anchor chips at the turn-element level instead
    // (redirected into the content column by chipAnchor).
    chipAtItemLevel: true,
    chipAnchor,
    // Kimi writes narration THEN the tool call at the end of the turn, so trail
    // the chip after the reply text (chipAppend) rather than pinning it first -
    // it then reads in the model's actual order and sits BELOW the reply, like
    // Qwen. chipTrailRef keeps it just above the copy/regenerate action row
    // instead of sinking below it; ensureOwnedChip re-asserts both across Vue's
    // re-renders of the reply subtree.
    chipAppend: true,
    chipTrailRef,
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
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, gateTarget, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
