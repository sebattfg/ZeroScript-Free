// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js - the Arena (arena.ai) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Arena support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Arena DOM notes (validated live, 2026-06, on /text/direct):
//  - Next.js / React + Tailwind app. The message list is a single
//    <ol class="… flex-col-reverse …">; each turn is a direct child
//    <div class="mx-auto max-w-[800px] …"> holding a <div class="prose"> body.
//    A trailing <div class="h-0"> spacer is also a child (skipped).
//  - CRITICAL: the list is flex-col-reverse, so DOM order is NEWEST-FIRST.
//    allItems() REVERSES the DOM children so the rest of the provider/core sees
//    the usual chronological (oldest-first) order and lastAssistant() = last.
//  - A user turn's container carries `justify-end`; an assistant turn's does not
//    and its header reads "Response provided by <vendor>" ABOVE the .prose body
//    (we read ONLY .prose, so that header never counts as model output).
//  - Fenced code is a REAL <pre> (textContent preserves newlines - no
//    CodeMirror/Monaco), wrapped in a <div class="not-prose">. ZeroScript's
//    command markers/JSON survive intact in textContent.
//  - The composer is a real <textarea> inside a <form> (the ONLY form textarea;
//    other page textareas are recaptcha/aria-hidden). We set its .value via the
//    native setter + input event, then click the submit button.
//  - The primary button carries aria-label "Send message" (idle) and is replaced
//    by an aria-label "Stop generation" button for the WHOLE generation.
//  - Conversation URL is /c/<uuid>; a fresh chat is /text/direct (no id yet).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    list: "ol.flex-col-reverse",
    box: ".prose",                 // markdown body (both user + assistant turns)
    // A/B comparison CAROUSEL: some replies render not as a normal mx-auto turn
    // but as an Embla carousel (region) holding TWO candidate slides side by side
    // (slide A = first in DOM, slide B = second). The container is a `w-full`
    // direct child of the <ol> WITHOUT `mx-auto`, so domTurns() used to skip it
    // entirely - the reply turn was never counted and the core waited out the full
    // NO_TURN_GRACE (≈30s) for nothing. We detect the carousel by its stable ARIA
    // and always read candidate A's .prose (matches the "Continuer avec A" commit).
    carousel: '[role="region"][aria-roledescription="carousel"]',
    slide: '[aria-roledescription="slide"]',
    codeWrap: "div.not-prose",     // fenced-code wrapper inside .prose
    sendAria: /send message|envoyer/i,
    stopAria: /stop generation|arr[êe]ter/i,
    errorSurfaces:
      '[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[data-sonner-toast]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|rate limit|too many requests/i,
  };

  // Arena streams with a hard stop-button signal for the WHOLE generation, so
  // idle windows can be tight (mirrors Gemini, not DeepSeek's reasoning phase).
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  // A turn = a direct child of the message <ol> that carries `mx-auto` and a
  // .prose body (the trailing .h-0 spacer has neither). User turns are right-
  // aligned (`justify-end`); everything else is an assistant turn.
  const listEl = () =>
    document.querySelector(S.list) ||
    [...document.querySelectorAll("ol")].find((o) => o.querySelector(S.box)) ||
    null;

  // True when a turn is an A/B comparison carousel (two candidate slides). Such a
  // turn carries no `mx-auto` but holds the carousel region, so we must accept it
  // explicitly or it is never counted as a reply.
  const isCarouselItem = (c) => !!c && !!c.querySelector(S.carousel);

  function domTurns() {
    const ol = listEl();
    if (!ol) return [];
    return [...ol.children].filter(
      (c) =>
        (c.classList.contains("mx-auto") || isCarouselItem(c)) &&
        c.querySelector(S.box)
    );
  }

  // The markdown body we read for a turn. For a comparison carousel we ALWAYS read
  // candidate A = the FIRST slide's .prose (deterministic and consistent with the
  // "Continuer avec A" commit the loop performs); for a normal turn it is just the
  // turn's .prose. Routing every read through this keeps stream/parse/mask aligned
  // on a single candidate so a 2-slide carousel can never desync the loop.
  function proseOf(item) {
    if (!item) return null;
    const slide = item.querySelector(S.slide);
    return slide ? slide.querySelector(S.box) : item.querySelector(S.box);
  }

  // A carousel container is never right-aligned, so it classifies as assistant.
  const isUserItem = (item) => !!item && item.classList.contains("justify-end");
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // ── A/B "battle" resolution ───────────────────────────────────────────────
  // Arena periodically turns a reply into an A/B comparison: TWO candidates
  // stream side by side with "Continuer avec A / Ignorer / Continuer avec B"
  // controls. We always commit candidate A ("Continuer avec A"): the chosen reply
  // then lands in the message <ol> as a normal turn, and the rest of the loop
  // parses it with zero special-casing (chip / masking just work).
  // We do NOT use "Ignorer" (skip): skip is a flaky, heavily rate-limited backend
  // call ("Too many requests" → "Failed to skip battle") that stalled the loop.
  // Exact label match only, so a control that merely contains the words isn't hit.
  const CONT_A_RE = /^\s*(continuer avec a|continue with a)\s*$/i;
  // Any committing click is a backend call that can be throttled. enforceComposer
  // runs this every sweep (mutations + the 1.5s tick), so we (1) click at most
  // once per BATTLE_COOLDOWN_MS and (2) never click while a throttle toast shows —
  // clicking again only deepens the limit. The cooldown still retries a genuinely
  // pending battle, but slowly enough never to trip the limiter.
  const THROTTLE_RE =
    /too many requests|trop de requ[êe]tes|rate.?limit|failed to (skip|continue|vote)|impossible/i;
  const BATTLE_COOLDOWN_MS = 6000;
  let _battleAt = 0, _battleClicks = 0, _throttleLogged = false;
  function actionThrottled() {
    for (const el of document.querySelectorAll(S.errorSurfaces)) {
      if (el.offsetParent === null) continue;
      if (THROTTLE_RE.test(el.innerText || "")) return true;
    }
    return false;
  }
  function resolveBattle() {
    if (Date.now() - _battleAt < BATTLE_COOLDOWN_MS) return false;
    if (actionThrottled()) {
      // Log the back-off only on the rising edge so the breadcrumb log isn't
      // flooded every sweep while the throttle toast lingers.
      if (!_throttleLogged) { _throttleLogged = true; diag("arena.battle_throttled", { clicks: _battleClicks }); }
      return false;
    }
    _throttleLogged = false;
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      if (CONT_A_RE.test(b.textContent || "") || CONT_A_RE.test(ariaOf(b))) {
        _battleAt = Date.now();
        _battleClicks++;
        diag("arena.battle_pick_a", { n: _battleClicks, label: (b.textContent || "").trim().slice(0, 24) });
        try { b.click(); } catch {}
        return true;
      }
    }
    return false;
  }

  // Walk the tree skipping the core's chip (and any extra excluded subtree).
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

  // Assistant signature text = ONLY the .prose body (excludes the "Response
  // provided by …" header so a vendor name can never look like model output).
  function itemText(item) {
    if (!item) return "";
    const md = proseOf(item);
    return md ? textWithout(md) : "";
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const md = proseOf(item);
    if (!md || (excludeSel && md.closest(excludeSel))) return "";
    return textWithout(md, excludeSel);
  }

  // ── DOM primitives ──────────────────────────────────────────────────────
  // The list is flex-col-reverse (newest-first in the DOM); reverse so the core
  // sees the usual chronological order and lastAssistant() = the latest reply.
  const allItems = () => domTurns().reverse();
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  // The composer textarea = the ONLY <textarea> inside a <form> (other page
  // textareas are recaptcha/aria-hidden). Scope away ZeroScript's own settings
  // textarea (#zs-root) so the send hooks' "not on a chat page" guard holds on
  // login/OAuth pages that have no site composer.
  const getEditor = () => {
    for (const e of document.querySelectorAll("form textarea")) {
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

  // Stable per-NODE identity for the latest assistant turn. The core prefers this
  // over assistantCount() to decide a fresh reply exists: count-based detection is
  // unreliable across an A/B battle (the reply renders in a carousel and the count
  // doesn't cleanly cross the send-time baseline), so without an id the core fell
  // back to counts and waited out the full 30s NO_TURN_GRACE after every battle.
  // A WeakMap assigns each turn element a monotonic id the first time it's seen;
  // a genuinely new reply node therefore yields a new id immediately.
  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: the /text/* route with the composer rendered and no
  // turns. An existing conversation is /c/<id>, so it never gates.
  const isFreshChat = () =>
    chatIsEmpty() && /^\/text\//.test(location.pathname) && !!getEditor();

  // The whole composer the Start gate hides as one unit = the <form>.
  const composerFrame = () => {
    const ed = getEditor();
    return ed ? ed.closest("form") : null;
  };

  // Arena is a React app that reconciles the composer subtree, so we must NOT
  // insert #zs-bar into it (the diff could nest the composer inside the bar, as
  // seen on Kimi/GLM). barAnchor() returns the rounded composer CARD; the core
  // (placeBar anchored branch) keeps the bar in #zs-root, hugs the card's top
  // edge at full width and reserves the strip with padding-top.
  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++) {
      if ([...n.classList].some((c) => c.startsWith("rounded"))) return n;
      n = n.parentElement;
    }
    return ed.closest("form");
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // The textarea is real: `readonly` blocks the user but is IGNORED by the
  // native prototype setter used in setTextareaValue(), so our own injections
  // keep working. getEditor() keys off the <form>, not the placeholder, so the
  // placeholder swap below is safe.
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

  // ── Action button (send / stop) ───────────────────────────────────────────
  const ariaOf = (b) => b.getAttribute("aria-label") || "";
  const allButtons = () => [...document.querySelectorAll("button")];
  const sendButton = () =>
    allButtons().find((b) => S.sendAria.test(ariaOf(b)) && b.offsetParent !== null) || null;
  const stopButton = () =>
    allButtons().find((b) => S.stopAria.test(ariaOf(b)) && b.offsetParent !== null) || null;

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop button is present for the entire generation (validated). Growth
  // tracking is a belt-and-braces fallback for the start/end instants and a
  // guard against a wedged stop button (same defensive pattern as Gemini).
  function streamText(item) {
    if (!item) return "";
    const md = proseOf(item);
    return md ? textWithout(md, ".zs-chip") : "";
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
  const isHardGenerating = () => !!stopButton();

  // Arena exposes no reliable per-turn "stopped" marker → never halted; and no
  // truncation Continue button.
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const md = proseOf(it);
      return { th: 0, rp: md ? (md.textContent || "").length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const md = proseOf(item);
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
  // Arena's composer hard-caps the message at 120000 chars: past that the submit
  // button stays disabled forever (validated live 2026-06), so a large tool
  // result (e.g. a 144 KB http_get dump) silently wedges the loop in the input
  // box. We truncate outgoing text to a safe margin below the cap, keeping the
  // head AND tail so neither the start nor the end of a result is lost, and we
  // mark the gap so the model knows content was dropped. Arena-only: other
  // providers have their own (or no) limits and are left untouched.
  const SEND_CAP = 120000;   // composer hard limit
  const SEND_MAX = 118000;   // leave margin for the truncation marker
  function truncateForSend(text) {
    if (!text || text.length <= SEND_CAP) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[…ZeroScript: result truncated to fit Arena's input limit — ` +
      `${omitted} of ${text.length} characters omitted…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  // React-controlled <textarea>: set .value via the native prototype setter so
  // React's onChange fires, dispatch an input event, wait for the submit button
  // to re-enable, then click it (Enter would insert a newline).
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
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Arena input box not found");
    editor.focus();
    setTextareaValue(editor, truncateForSend(text));
    // Wait for React to enable the submit button (proof it registered the text).
    await waitFor(() => {
      const btn = sendButton();
      return btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
    }, 1500);
    if (!clickSendButton() && !isBusyNow()) {
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent("keydown", o));
      editor.dispatchEvent(new KeyboardEvent("keyup", o));
    }
  }

  // Arena shows "Generating…" for a beat BEFORE the native "Stop generation"
  // button mounts (it only appears once the stream starts). A Stop click landing
  // in that window found no button to click, so the native generation ran on
  // (the loop halted, but the model kept streaming a turn). Click now if present;
  // otherwise poll briefly and click the instant the button appears, so the stop
  // is never swallowed by that gap.
  let _stopPoll = null;
  function stopGeneration() {
    if (_stopPoll) { clearInterval(_stopPoll); _stopPoll = null; }
    const b = stopButton();
    if (b) { try { b.click(); } catch {} return; }
    const t0 = Date.now();
    _stopPoll = setInterval(() => {
      const btn = stopButton();
      if (btn) { try { btn.click(); } catch {} clearInterval(_stopPoll); _stopPoll = null; return; }
      // Hard cap so the timer never lingers (a fresh Stop click restarts it). We
      // do NOT gate on genActive() here: during the pre-stream "Generating…" gap
      // there's no stop button AND no grown text yet, so genActive() is false -
      // the very window we must keep polling through.
      if (Date.now() - t0 > 8000) { clearInterval(_stopPoll); _stopPoll = null; }
    }, 120);
  }

  // ── Chat-mode gate (Direct only) ──────────────────────────────────────────
  // Arena has four chat modes (the conversation-mode dropdown): Direct (1 model),
  // Battle Mode (2 anonymous models → always an A/B comparison), Side by Side
  // (2 chosen models → also A/B), and Agent Mode (autonomous, single model).
  // ZeroScript only supports DIRECT. Battle / Side by Side force a fresh A/B
  // comparison on EVERY turn. Agent Mode is a SEPARATE app (route /agent, a
  // TipTap/ProseMirror contenteditable composer with NO <form>, and NO <ol>
  // message list) on which every DOM assumption here breaks - getEditor() returns
  // null so the bar can't even anchor; supporting it would be a full port, so it
  // stays gated. The mode dropdown's trigger is a `button[role="combobox"]` whose
  // visible text IS the current mode name; we read it to gate Start. Detection
  // fails OPEN (unknown → allow) so a DOM reskin never wrongly blocks the default.
  const MODE_RE = /\b(direct|battle|agent|side by side)\b/i;
  const SUPPORTED_MODES = new Set(["direct"]);
  function currentMode() {
    for (const c of document.querySelectorAll('button[role="combobox"]')) {
      if (c.offsetParent === null) continue;
      const m = (c.textContent || "").trim().toLowerCase().match(MODE_RE);
      if (m) return m[1];
    }
    return null; // unknown
  }
  // True unless we POSITIVELY detect an unsupported mode (Battle / Side by Side).
  const isSupportedMode = () => {
    const m = currentMode();
    return m === null || SUPPORTED_MODES.has(m);
  };

  // Visible mode guard for the ZeroScript bar (core renderBar reads this every
  // sweep). Returns a warning string while an unsupported mode (Battle / Side by
  // Side / Agent) is selected, "" when Direct (or mode unknown → fail open so a
  // DOM reskin never nags on the supported default). The core turns this into a
  // red warning state and disables Start until the user switches to Direct.
  function modeWarning() {
    if (isSupportedMode()) return "";
    const m = currentMode();
    const name = m ? m.charAt(0).toUpperCase() + m.slice(1) : "another mode";
    return `Switch the mode dropdown to <b>Direct</b> — ZeroScript only works in ` +
      `Direct mode (current: <b>${name}</b>).`;
  }

  // A bot-check challenge is on screen (Cloudflare Turnstile / hCaptcha /
  // reCAPTCHA). We NEVER interact with it — the core reads this only to move the
  // ZeroScript bar out of the way: the anchored bar is transparent but still a
  // real, full-width element over the composer's top edge, so it silently eats
  // clicks on the challenge's "Valider" button even though nothing is visible.
  const CAPTCHA_SEL =
    'iframe[src*="challenges.cloudflare.com"],' +
    'iframe[src*="hcaptcha.com"],' +
    'iframe[src*="recaptcha"],' +
    '.cf-turnstile,.h-captcha,.g-recaptcha';
  // Truly on-screen? offsetParent ignores visibility:hidden / opacity:0, so we
  // must walk ancestors. This is what excludes Arena's ALWAYS-present reCAPTCHA
  // v3 badge (a 256x60 .grecaptcha-badge kept at visibility:hidden), which used
  // to false-positive and hide the bar on every page. An actual interactive
  // challenge (Turnstile / hCaptcha checkbox) is visible, sized, and in-viewport.
  function reallyVisible(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false; // tiny badge, not a challenge
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function captchaPresent() {
    for (const el of document.querySelectorAll(CAPTCHA_SEL)) {
      if (reallyVisible(el)) return true;
    }
    return false;
  }

  // A modal dialog (login / create-account / consent) is open over the page.
  // Arena renders these as Radix dialogs = a visible [role="dialog"]. While one is
  // up, the anchored ZeroScript bar (a real, full-width element hugging the
  // composer's top edge) sits ON TOP of the modal and silently intercepts clicks
  // on its buttons - e.g. "Continue with Google" at sign-in. The core hides the
  // bar whenever this is true (same get-out-of-the-way path as captchaPresent).
  // reallyVisible() ignores display:none / detached closed dialogs, so a chat page
  // with no open modal never matches. Our own UI lives in #zs-root and is skipped.
  function overlayBlocking() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.closest("#zs-root")) continue;
      if (reallyVisible(d)) return true;
    }
    return false;
  }

  // No model/tier to enforce (Direct/Max + model picker left to the user); the
  // only requirement is a supported chat mode (Direct or Agent). Also resolve any
  // A/B battle the instant its "Continuer avec A" button appears (this runs every
  // sweep), so the comparison commits to candidate A and the loop reads a single
  // normal reply.
  function enforceComposer() {
    resolveBattle();
    return { ready: isSupportedMode() };
  }
  async function ensureComposerReady(reason) {
    const supported = isSupportedMode();
    diag("mode_ready", { reason, provider: "arena", mode: currentMode(), supported });
    // Gate on a supported mode AND a present composer. An unsupported mode (Battle
    // / Side by Side) makes the core show its "mode not ready" banner instead of
    // starting - the light prevention the user asked for.
    return { ready: supported && !!getEditor() };
  }

  // ── Error / limit detection (site chrome only, never model output) ───────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.list)) continue; // inside a chat turn ⇒ model content
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
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
    const frame = composerFrame();
    return await waitFor(
      () => !!(frame && frame.querySelector("img, [class*='preview'], [class*='thumbnail']")),
      15000
    );
  }
  function clearAttachments() {
    try {
      const frame = composerFrame();
      if (!frame) return;
      frame.querySelectorAll("[aria-label*='emove'], [aria-label*='upprimer'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  // /text/* = a fresh chat with no conversation id yet → "" (transient, never
  // persisted as "started"). A real conversation is /c/<uuid>.
  const conversationKey = () => (/^\/text\//.test(location.pathname) ? "" : location.pathname);

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
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
        const btn = e.target && e.target.closest && e.target.closest("button");
        if (!btn) return;
        if (S.stopAria.test(ariaOf(btn))) { handlers.onNativeStop(); return; }
        if (!S.sendAria.test(ariaOf(btn))) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
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
  // Arena renders each fenced code block as a real <pre> wrapped in a
  // <div class="not-prose"> (markers/JSON intact in textContent). Hide every
  // such wrapper carrying a command shape, plus any bare top-level block holding
  // an inline command. React recreates the rendered subtree on stream settle and
  // on the next send (wiping per-element .zs-tool-hide), so also mark the turn
  // (its identity survives - the chip is anchored at item level) with
  // .zs-cmd-mask; the overlay.css rule keeps recreated code wrappers hidden.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const md = proseOf(item);
    if (!md) return null;
    let hidAny = null;
    // 1. Fenced code wrappers carrying a command.
    md.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    // 2. Bare top-level blocks with an inline command (no code wrapper inside).
    [...md.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if (t.length < 600 && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        item.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "arena",
    displayName: "Arena",
    timings,
    // React reconciles a turn's content subtree on every update, wiping a chip
    // placed inside it. Anchor chips at the turn-element level instead.
    chipAtItemLevel: true,
    // No unstableWarning chip: the live mode guard (modeWarning) already shows a
    // visible, reactive warning + disables Start whenever a non-Direct mode is
    // selected, which covers the only Arena caveat that chip used to flag.
    // Turn elements are not virtualized away here, so assistantCount() reliably
    // increases for every new reply - the core's watcher uses this to refuse
    // finalizing before this send's reply turn exists.
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
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
