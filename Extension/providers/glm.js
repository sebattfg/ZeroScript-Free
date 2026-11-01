// SPDX-License-Identifier: GPL-3.0-or-later
// providers/glm.js - the GLM / Z.ai (chat.z.ai) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and gemini.js;
// the core (core/main.js) is provider-agnostic. To DISABLE GLM support, remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Z.ai (GLM) DOM notes (validated live, 2026-06):
//  - Svelte app. One exchange = a `.user-message` div followed by a
//    `.chat-assistant` div (the assistant reply root, also `.markdown-prose`).
//    The assistant root is wrapped by `div.message-<uuid>`; that uuid is a
//    stable per-turn identity we expose as lastAssistantId (virtualization-proof).
//  - Reasoning ("Thought Process") renders as a `.thinking-chain-container`
//    INSIDE `.chat-assistant`, so all reply-text extraction strips that subtree
//    (tool blocks drafted inside reasoning are never detected or executed).
//  - The composer is a real <textarea id="chat-input">: set .value via the native
//    prototype setter + input event (React/Svelte both read it), WAIT for the
//    send button to re-enable, then click it. Typing + clicking in the same tick
//    fails because `#send-message-button` is still `disabled` for a frame.
//  - Idle: `button#send-message-button` is present (disabled when the box is
//    empty). While generating it is REPLACED by a round black stop button
//    (`button.rounded-full.bg-black` holding a small square <span>), so
//    "send button gone / stop button present" == generating for the WHOLE
//    stream (thinking included) - no indicatorless reasoning phase like DeepSeek.
//  - Fenced code = an atomic wrapper `div[class*="rounded-xl"]` carrying a
//    `.copy-code-button`; the command JSON survives in textContent.
//  - Conversation URL is /c/<uuid>; a fresh chat is exactly "/".
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: ".user-message",
    assistantItem: ".chat-assistant",
    anyItem: ".user-message, .chat-assistant",
    thinking: ".thinking-chain-container",
    editor: "#chat-input",
    composer: ".messageInputContainer",
    sendBtn: "#send-message-button",
    // code-block wrapper carries a copy button; the JSON survives in textContent.
    copyCodeBtn: ".copy-code-button",
    codeWrap: 'div[class*="rounded-xl"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[class*="modal"]',
    // A SENT image renders as an attachment card (its filename + "JPG · NN KB")
    // as the FIRST child div of `.chat-user`, BEFORE the message text. Its
    // filename text would otherwise prefix the turn's classifyText - which broke
    // the result-chip: the core anchors on /^Output of '/ (isInjectedFeedback),
    // so "zeroscript_….jpg JPG 179 KB Output of 'screen_capture'…" failed to match
    // and the screen_capture feedback turn stayed un-chipped (visible raw output,
    // unlike Kimi). Strip it from every text read. Precise: only the child holding
    // the attachment image, never the sibling text block.
    attachment: '.chat-user > div:has(img[data-cy="image"])',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "\\u4e0a\\u4e0b\\u6587.{0,10}(\\u8d85\\u51fa|\\u8fc7\\u957f|\\u9650\\u5236)",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|server is busy|系统繁忙|请稍后再试/i,
  };

  // GLM streams with a hard stop-button signal for the WHOLE generation
  // (reasoning + answer), so completion windows can be tight like Gemini.
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

  // Walk an element's text, skipping the reasoning subtree, our own chip, and any
  // excluded selector. Used everywhere a turn's "real" text is needed so tool
  // blocks drafted inside reasoning are never detected, shown, or executed.
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = S.thinking + ", .zs-chip, " + S.attachment + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      // GLM renders fenced code in a CodeMirror editor whose lines are separate
      // <div class="cm-line"> with NO newline text nodes, so textContent collapses
      // the whole block onto ONE line - which breaks Lua (a `--` then comments out
      // the rest) and any multi-line command. Rebuild the real source by joining
      // the cm-line elements with "\n" (and skip the .cm-announced a11y duplicate).
      if (n.matches && n.matches(".cm-editor, .cm-content")) {
        const lines = n.querySelectorAll(".cm-line");
        if (lines.length) { t += "\n" + [...lines].map((l) => l.textContent).join("\n"); return; }
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  const itemText = (item) =>
    isAssistantItem(item) ? textWithout(item) : textWithout(item);
  const classifyText = (item, excludeSel) => textWithout(item, excludeSel);

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
    if (!e) return "";
    return e.value != null ? e.value : e.textContent || "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-turn identity: the `message-<uuid>` class on the assistant turn's
  // wrapper (survives Svelte re-renders / list virtualization). null if absent.
  function lastAssistantId() {
    let n = lastAssistant();
    while (n) {
      const m = (n.className || "").toString().match(/message-([0-9a-f-]{20,})/);
      if (m) return m[1];
      n = n.parentElement;
    }
    return null;
  }

  // ── Chip anchor ───────────────────────────────────────────────────────────
  // The turn's inner reply lives in a `.markdown-prose` div (NOTE the turn root
  // `.chat-assistant` ALSO carries a `markdown-prose` class, so querySelector -
  // descendants only - returns the inner one). Its parent is the content COLUMN
  // (`.flex.flex-col.w-full`, a vertical stack holding the reply then an
  // `aria-hidden` spacer; the copy/regenerate action bar lives OUTSIDE the turn,
  // validated live). Anchoring the chip there + chipAppend stacks it UNDER the
  // reply (parity with Qwen/Kimi) instead of pinned above the whole turn.
  function chipAnchor(item) {
    if (!item) return item;
    const mp = item.querySelector(".markdown-prose");
    return (mp && mp.parentElement) || item;
  }
  // With chipAppend the chip trails the reply. The column's last child is a bare
  // `aria-hidden` spacer; name it as the fixed point the chip stays just BEFORE
  // so it hugs the reply text rather than sinking below the spacer. null when
  // absent -> the chip simply appends after the reply (still below it).
  function chipTrailRef(item) {
    const anchor = chipAnchor(item);
    return (anchor && anchor.querySelector(':scope > div[aria-hidden="true"]')) || null;
  }

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: the "/" route with the composer rendered and no turns.
  const isFreshChat = () =>
    chatIsEmpty() && /^\/?$/.test(location.pathname) && !!getEditor();

  // The composer box the Start gate hides as one unit.
  const composerFrame = () =>
    document.querySelector(S.composer) ||
    (getEditor() ? getEditor().closest("form, .relative") : null);

  // Integrated status bar (same approach as Kimi): GLM is a Svelte app that
  // reconciles the composer subtree, so we must NOT insert our #zs-bar into it
  // (a foreign node in a framework-managed parent risks the diff nesting the
  // composer inside the bar). barAnchor() returns the rounded composer CARD - the
  // `flex flex-col … rounded-xl` ancestor of the textarea, which holds the input
  // box then the toolbar row - and the core (placeBar anchored branch) keeps the
  // bar in #zs-root, positions it to hug that card's top edge at full width, and
  // reserves the strip with padding-top. Validated live: full width, hugs top,
  // pushes the input down with no overlap.
  function barAnchor() {
    const ed = getEditor();
    return (ed && ed.closest('.flex-col[class*="rounded"]')) || null;
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // The textarea is a real <textarea>: `readonly` blocks the user but is ignored
  // by the native prototype setter used in setTextareaValue(), so our own
  // injections still work.
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

  // ── Send / stop buttons ────────────────────────────────────────────────────
  const sendButton = () => {
    const c = composerFrame();
    return (c && c.querySelector(S.sendBtn)) || document.querySelector(S.sendBtn);
  };
  // While generating, the send button is replaced by a round stop button inside
  // the composer (a submit button with `rounded-full`/`bg-black` and no id).
  function stopButton() {
    const c = composerFrame();
    if (!c) return null;
    return [...c.querySelectorAll("button")].find(
      (b) => b.id !== "send-message-button" &&
             /rounded-full/.test(b.className) &&
             /bg-black|bg-white/.test(b.className) &&
             // z.ai added round `bg-white rounded-full` SCROLL-TO-BOTTOM arrows to
             // the composer (an <svg> down-arrow in an `absolute` overlay). They
             // matched the old criteria, so genActive()/isGenerating latched TRUE
             // forever on a static page - the Stop button showed red with no loop
             // running and finalisation/camouflage stalled. The real stop button is
             // a round button holding a small square <span> (NO svg), so exclude any
             // svg-bearing button.
             !b.querySelector("svg")
    ) || null;
  }

  // ── Generation detection ──────────────────────────────────────────────────
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    return (think ? think.textContent || "" : "") + "\n" + textWithout(item);
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

  // GLM's stop button is present for the ENTIRE generation and reliably clears
  // when it ends (validated live), so we TRUST it directly. We must NOT gate it
  // on stream growth the way Gemini's wedge guard does: GLM renders the answer
  // in a CodeMirror editor that VIRTUALIZES its lines, so a long script's
  // measured text length PLATEAUS mid-stream. The growth guard then wrongly
  // declared the still-active generation "done", the watcher finalized a
  // half-written command, and the feedback we sent aborted GLM mid-reply - the
  // parse_error / truncation loop. Trusting the button avoids that entirely;
  // the growth check only covers the brief tail right after the button clears.
  function genActive() {
    sampleStream();
    if (stopButton()) return true;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  // GLM exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: textWithout(it).length,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    return {
      present: true,
      reply: textWithout(item).trim(),
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

  // ── Sending ─────────────────────────────────────────────────────────────────
  // Real <textarea> driven by Svelte: set .value via the native prototype setter
  // so the framework's input handler fires, dispatch an input event, then click
  // the send button ONCE it re-enables (a fresh value disables it for a frame).
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = sendButton();
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("GLM input box not found");
    editor.focus();
    setTextareaValue(editor, text);
    // Attach images LAST, right before the send click - see gemini.js's
    // typeAndSend for why (attaching before retyping the text can sever the
    // site's binding between the pending upload and the message being sent).
    // submitAndGetBase RETRIES this function; only attach if nothing is staged
    // yet, else each retry uploads ANOTHER duplicate copy.
    if (images && images.length && !hasPendingAttachment()) { try { await attachImages(images); } catch {} }
    // Wait for Svelte to re-enable the send button (proof it registered the text),
    // then click the instant it's clickable. In a LONG conversation the message
    // list is heavy, so Svelte's reactivity to the input event can take well over
    // a second - the old 1500ms cap expired with the button still `disabled`, the
    // click no-opped, and only the core's retry loop eventually landed it (the
    // user's "message sits in the input then sends after a long time"). We now wait
    // up to 8s AND re-dispatch the input event every ~700ms so a slow/queued Svelte
    // cycle keeps getting nudged until it re-enables the button.
    let lastNudge = Date.now();
    const enabled = await waitFor(() => {
      const b = sendButton();
      if (b && !b.disabled) return true;
      if (Date.now() - lastNudge > 700) {
        lastNudge = Date.now();
        // Re-assert the value (a heavy re-render can drop it) and re-fire input.
        if (editorText() !== text) setTextareaValue(editor, text);
        else editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return false;
    }, 8000);
    diag("glm.send", { enabled, busy: isBusyNow() });
    if (!clickSendButton() && !isBusyNow()) {
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent("keydown", o));
      editor.dispatchEvent(new KeyboardEvent("keyup", o));
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // No site modes to enforce (model / reasoning toggle left to the user).
  function enforceComposer() { return { ready: !!getEditor() }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "glm" });
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

  // ── Image attachment (best effort) ────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  // The PENDING attachment chip. z.ai mounts each staged upload as a
  // `.chip-scroll > button` inside the composer card (barAnchor). A SENT image
  // renders separately in its `.user-message` turn, so scoping the probe to the
  // composer card excludes history - which stops a leftover chip from a PREVIOUS
  // capture reading as "already pending" and skipping the next attach (the
  // 2nd-capture-never-attaches bug seen on Kimi). Validated live on chat.z.ai.
  const pendingChip = () => {
    const host = barAnchor() || document;
    return host.querySelector(".chip-scroll > button");
  };
  const hasPendingAttachment = () => !!pendingChip();
  // Upload done = the chip's <img data-cy="image"> src has flipped from its local
  // placeholder to the remote CDN url (https://z-cdn-media.chatglm.cn/…). Sending
  // before that goes out text-only, so we WAIT for the http(s) src.
  const attachmentReady = () => {
    const host = barAnchor() || document;
    const im = host.querySelector('.chip-scroll img[data-cy="image"]') || host.querySelector(".chip-scroll img");
    return !!(im && /^https?:\/\//.test(im.getAttribute("src") || ""));
  };
  async function attachImages(images) {
    if (!images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    // z.ai keeps a single always-mounted <input type=file> in the composer
    // (accepts png/jpg among others); setting .files + change stages the upload -
    // no "+" menu to open (unlike Kimi). A synthetic paste is NOT needed.
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) { diag("attach.noFileInput"); return false; }
    diag("attach.setFiles", { count: dt.items.length });
    try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); }
    catch (e) { diag("attach.setFilesThrew", { msg: String((e && e.message) || e) }); return false; }
    if (!(await waitFor(pendingChip, 15000))) { diag("attach.noChip"); return false; }
    const ok = await waitFor(attachmentReady, 30000);
    diag("attach.uploadDone", { ok });
    return ok;
  }
  function clearAttachments() {
    try {
      const host = barAnchor() || document;
      host.querySelectorAll(".chip-scroll > button").forEach((chip) => {
        // The per-chip remove control is the small button revealed on hover
        // (`invisible text-icon-…`); fall back to the chip's last inner button.
        const inner = [...chip.querySelectorAll("button")];
        const rm = inner.find((b) => /invisible|text-icon/.test(b.className)) || inner[inner.length - 1];
        if (rm) try { rm.click(); } catch {}
      });
    } catch {}
  }

  // /c/<uuid> = a real conversation. "/" = a fresh chat with no id yet → ""
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
        const t = e.target;
        // Stop button (round, in the composer) = a native stop intent.
        const stop = t && t.closest && t.closest("button");
        if (stop && composerFrame() && composerFrame().contains(stop) &&
            stop.id !== "send-message-button" &&
            /rounded-full/.test(stop.className) && /bg-black|bg-white/.test(stop.className) &&
            !stop.querySelector("svg")) { // exclude the scroll-to-bottom arrows (see stopButton)
          handlers.onNativeStop();
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        if (btn.disabled) return;
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
  // GLM wraps each fenced code block in an atomic `div[class*="rounded-xl"]`
  // carrying a `.copy-code-button` (markers + JSON survive in textContent), and
  // Svelte re-renders the markdown subtree on stream updates / next send. So,
  // like Gemini: hide every code wrapper in the reply whose text carries a
  // command shape AND mark the reply root (`.chat-assistant`, which keeps its
  // identity) with .zs-cmd-mask so a CSS rule re-hides recreated wrappers with
  // zero flash. Also catch a stray bare inline command paragraph.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    if (!item) return null;
    let hidAny = null;
    // 1. Fenced code blocks carrying a command (skip ones inside the reasoning).
    for (const cc of item.querySelectorAll(S.copyCodeBtn)) {
      if (cc.closest(S.thinking)) continue;
      const wrap = cc.closest(S.codeWrap);
      if (!wrap || wrap.closest(".zs-chip")) continue;
      if (CMD_SHAPE.test(wrap.textContent || "")) {
        wrap.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: wrap.parentElement, ref: wrap };
      }
    }
    // 2. Bare top-level blocks with an inline command (no code wrapper inside).
    const reply = item.querySelector(".markdown-prose") || item;
    [...reply.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.closest(S.thinking) ||
          el.querySelector(S.copyCodeBtn)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "glm",
    displayName: "GLM",
    // GLM-5.2 is multimodal and z.ai's composer accepts image uploads (png/jpg via
    // the always-mounted file input; chip staged in .chip-scroll, upload complete
    // when its <img> src flips to the z-cdn-media CDN url - see attachImages). So
    // screen_capture is exposed here (main.js BLOCKED_TOOLS gate). Confirm the
    // model actually READS the image via provider-test-checklist step 9 (incl. two
    // captures in a row) - flip back to false if a live read ever fails.
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible probes
    // exclude it (same fix as DeepSeek/Gemini/Kimi): GLM's "Thought Process"
    // renders in .thinking-chain-container and quotes the command JSON, which the
    // camouflage never hides - without this the core reads it as "raw block still
    // visible" forever and the chip flaps done→run→done.
    thinkingSel: S.thinking,
    // Shown as a permanent, non-intrusive "⚠ unstable" notice in the bar. The
    // z.ai free endpoint is frequently at capacity: its backend returns an HTML
    // error page instead of JSON, so the reply shows "No response, please try
    // again later" (a z.ai server issue, NOT the extension). Prefer the GLM-5.2
    // model and retry off-peak.
    unstableWarning:
      "GLM (z.ai) can be unstable: when its servers are busy a turn fails with " +
      "\"No response, please try again later\" - that's a z.ai issue, not the extension. " +
      "Prefer the GLM-5.2 model and retry in a moment (or off-peak) if it happens.",
    // Svelte re-renders the reply's markdown subtree on every update, wiping any
    // chip placed inside it. Anchor chips at the turn-element level instead
    // (redirected into the reply column by chipAnchor).
    chipAtItemLevel: true,
    chipAnchor,
    // GLM writes narration THEN the tool call at the end of the turn, so trail
    // the chip after the reply text (chipAppend) rather than pinning it first -
    // it then sits BELOW the reply, like Qwen/Kimi. chipTrailRef keeps it just
    // above the trailing aria-hidden spacer; ensureOwnedChip re-asserts both
    // across Svelte's re-renders of the reply subtree.
    chipAppend: true,
    chipTrailRef,
    // Assistant turns expose a stable message-<uuid> identity (lastAssistantId),
    // so the core's watcher can refuse finalizing before this send's reply exists.
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
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
