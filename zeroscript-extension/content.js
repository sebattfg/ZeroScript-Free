// content.js - runs on chat.deepseek.com. Drives the agentic loop in-page.
// Reads DeepSeek's DOM (textContent, render-independent), parses tool calls,
// asks background to execute them on the Roblox MCP, and feeds results back.
// Camouflages the system prompt ("Starting Up"), hides tool JSON (and its code
// header) behind animated chips, masks injected input, and exposes a Stop button.
// DeepSeek ALWAYS receives an output.
//
// DeepSeek notes (validated live):
//  - One turn = one .ds-message. User turns carry a hashed modifier class +
//    a `.fbb737a4` bubble; assistant turns carry a `.ds-markdown` body.
//  - DeepThink/R1 reasoning lives in .ds-think-content; the real answer is a
//    .ds-markdown OUTSIDE that container (so drafts inside reasoning are ignored).
//  - The input is a real <textarea> (not a contenteditable): we set its value via
//    the native setter + an input event, then click the primary send button.
//  - "generating" is detected from the primary footer button: it shows a <rect>
//    (stop square) while streaming and a <path> (send arrow) when idle; .ds-loading
//    covers the brief spin-up. Completion is generating-flag driven, with a
//    text-stability fallback for a stuck flag (DeepSeek virtualizes its list).

(() => {
  "use strict";
  const S = ZS.SELECTORS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[zeroscript]", ...a);

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). When the user reports
  // "it stopped / a tool hung", read these back from the console (filter "[zs-diag]")
  // or from window.__zsDiag (also mirrored onto a hidden DOM node for the inspector
  // running in the page's main world). Each entry carries a turn snapshot so we can
  // see WHETHER a send landed during an active reasoning phase.
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diagSnap() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp,
               gen: typeof isGenerating === "function" ? isGenerating() : null,
               run: A.running };
    } catch { return {}; }
  }
  function diag(event, data) {
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap: diagSnap() };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...e.snap })); } catch {}
    // Mirror to a hidden DOM node so the main-world inspector can read it.
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }

  // Ko-fi tip link.
  const KOFI_URL = "https://ko-fi.com/sebattfg";
  // GitHub releases page - where users download the Bridge + start.bat.
  const GITHUB_URL = "https://github.com/sebattfg/ZeroScript-Free";
  // YouTube tutorial — how to set up the Bridge.
  const VIDEO_URL = "https://youtu.be/QaViHSqzy5Q";
  // Roblox "tip" Game Passes - the native currency for the audience.
  const ROBUX_PASSES = [
    { robux: 30, id: 1865342947 },
    { robux: 100, id: 1866782815 },
    { robux: 300, id: 1869176990 },
    { robux: 1000, id: 1865192973 },
  ];
  const passUrl = (id) => `https://www.roblox.com/game-pass/${id}`;

  const A = {
    running: false,
    stop: false,
    // userStopped: the user deliberately halted generation - either via our
    // "■ Stop" button OR DeepSeek's native stop button (same spot as send,
    // toggles to a <rect>). While set, the auto-resume watchdog must NOT relaunch
    // or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment DeepSeek was actively generating.
    // The auto-resume watchdog only acts on a tool call that came from a RECENT
    // live generation - never on a historical turn rendered by opening/scrolling
    // an existing conversation (which would otherwise re-execute old tools).
    lastGenAt: 0,
    started: false,
    starting: false,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    bridge: { connected: false, mcpAlive: false, tools: 0 },
  };

  // ── User vs assistant classification (multi-signal, virtualization-safe) ──
  // DeepSeek marks user turns with a hashed modifier class AND a `.fbb737a4`
  // bubble; assistant turns render a `.ds-markdown` body. We treat a turn as the
  // user's if either user signal is present - robust if one hashed class drifts.
  function isUserItem(item) {
    if (!item) return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // Text of an item for signature detection. For assistant turns we use ONLY
  // the non-thinking markdown, so tool blocks that DeepSeek merely drafts inside
  // its reasoning (.ds-think-content) are never detected, shown, or executed.
  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DOM PRIMITIVES
  // ════════════════════════════════════════════════════════════════════════
  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const getEditor = () => document.querySelector(S.editor);
  // The composer is a <textarea>, so its live content is .value (NOT textContent).
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return (e.value != null ? e.value : e.textContent || "");
  };

  // Lock / unlock the user textarea during agent activity. `readonly` blocks
  // interactive typing but is IGNORED by the native prototype setter used in
  // setTextareaValue(), so the loop's own injections continue to work normally.
  // Always called in try/finally pairs so a crash or Stop never leaves it locked.
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

  // A "blank" conversation = no chat turns rendered yet. This is the ONLY place
  // the session may be started ("Start session" / "Starting Up") and where the
  // Expert/Rapide mode selector is shown. Opening an EXISTING conversation has
  // turns, so we must not offer to start (or inject the system prompt) there.
  const chatIsEmpty = () => allItems().length === 0;

  // A genuinely FRESH/new chat (not an existing conversation whose messages are
  // still loading). DeepSeek only shows the Expert/Rapide mode selector on a
  // brand-new empty chat; an existing conversation never has it. Keying the gate
  // and onboarding on this avoids flashing the big "Start session" panel while an
  // existing conversation is still rendering its turns.
  const isFreshChat = () => chatIsEmpty() && !!document.querySelector(S.modeRadioGroup);

  // The whole composer "box" = the smallest ancestor that contains the input, the
  // send button AND (on a blank chat) the Expert/Rapide mode selector. We need it
  // as one unit so the Start gate can hide the ENTIRE frame at once (which also
  // sidesteps the mode selector's half-width selection highlight, since it is
  // never shown to the user). Returns null if the input isn't present yet.
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

  // ════════════════════════════════════════════════════════════════════════
  //  COMPOSER MODE ENFORCEMENT  (force Expert mode + hide DeepThink toggle)
  // ════════════════════════════════════════════════════════════════════════
  // On a blank chat DeepSeek shows a [role=radiogroup] with "Rapide" (fast,
  // default) and "Expert" (better results). We force Expert (the radio stays
  // hidden inside the gated composer, so we no longer hide the "Rapide" option
  // individually - that broke the sliding selection highlight). The "Pensée
  // profonde / Réflexion" DeepThink toggle (a single .ds-toggle-button) is
  // forced ON, then hidden so the user can't turn it off. Re-run every sweep so it
  // survives React re-renders and applies the instant a new chat appears.
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
           radios.find((r) => ZS.RE.expertMode.test(nodeText(r))) ||
           null;
  }

  function findToggleBy(re) {
    return [...document.querySelectorAll(S.deepThinkToggle)].find((t) => re.test(nodeText(t))) || null;
  }

  function composerModeState() {
    const expert = findExpertRadio();
    const deepThink = findToggleBy(ZS.RE.deepThink);
    const search = findToggleBy(ZS.RE.searchMode);
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
    try {
      const expert = findExpertRadio();
      if (expert && expert.getAttribute("aria-checked") !== "true") {
        try { expert.click(); } catch (e) { if (reason) diag("mode_fallback", { reason, target: "expert", error: String(e && e.message || e) }); }
      }

      // DeepThink ("Pensée profonde / Réflexion"): make sure it is ON, then hide
      // it so the user can't turn it off. DeepSeek currently uses aria-pressed,
      // while older notes expected aria-checked; handle both so locale/site
      // changes leave a breadcrumb instead of silently starting in fast mode.
      const deepThink = findToggleBy(ZS.RE.deepThink);
      if (deepThink) {
        if (isPressedOff(deepThink)) {
          try { deepThink.click(); } catch (e) { if (reason) diag("mode_fallback", { reason, target: "deepThink", error: String(e && e.message || e) }); }
        }
        deepThink.classList.add("zs-hide-el");
      } else if (reason) {
        diag("mode_fallback", { reason, target: "deepThink", error: "toggle not found" });
      }

      // Search is visible in Rapide and disappears after Expert is selected
      // (validated live). If present, force it off; if absent in Expert, OK.
      const search = findToggleBy(ZS.RE.searchMode);
      if (search) {
        if (isPressedOn(search)) {
          try { search.click(); } catch (e) { if (reason) diag("mode_fallback", { reason, target: "search", error: String(e && e.message || e) }); }
        }
      } else if (reason && (!expert || expert.getAttribute("aria-checked") !== "true")) {
        diag("mode_fallback", { reason, target: "search", error: "toggle not found before Expert was confirmed" });
      }

      const state = composerModeState();
      if (reason) diag("mode_enforce", { reason, ...state });
      return state;
    } catch (e) {
      if (reason) diag("mode_fallback", { reason, target: "composer", error: String(e && e.message || e) });
      return composerModeState();
    }
  }

  async function ensureComposerModesReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 12; i++) {
      state = enforceComposer(reason);
      if (state.expertOn && state.deepThinkOn && state.searchOff) break;
      await sleep(120);
    }
    state = composerModeState();
    diag("mode_ready", { reason, ...state });
    return state;
  }

  // Everything DeepSeek is streaming for a turn: its reasoning (.ds-think-content)
  // PLUS its answer (.ds-markdown outside the reasoning). Excludes our own chip so
  // the live token meter can't masquerade as model output. This is the basis for
  // the growth-based "generating" detection below.
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

  // "generating" detection. CRITICAL DeepSeek quirk (validated live): during the
  // DeepThink/R1 *reasoning* phase there is NO stop button and NO spinner - the
  // primary button still shows the send <path>, not a <rect>. So we combine three
  // signals: the <rect>/spinner fast-path (answer phase), "thinking-but-no-answer-
  // yet" (reasoning phase, ended only by an answer token or a native Continue
  // button), and text-growth windows. Getting this wrong makes the loop finalize
  // mid-reasoning, send a follow-up, and - since send IS stop - abort the turn.
  const GEN_IDLE_MS = 800;       // answer phase: text unchanged this long ⇒ idle (rect is the primary signal; 800ms is a safe fallback)
  // Reasoning phase tolerates MUCH longer pauses. DeepThink/R1 routinely stalls
  // for several seconds between thoughts (and longer when DeepSeek's servers are
  // busy). The old 2s window mistook such a pause for "done", so the loop sent a
  // follow-up message - and since the send button IS the stop button, that click
  // interrupted the still-running generation ("Arrêté" + "Continue"). This window
  // is the upper bound for a reasoning stall before we treat it as a server stall.
  const REASON_IDLE_MS = 12000;
  // Stream-growth tracking - the ONLY "is it still streaming?" signal during the
  // reasoning phase (no <rect>, no spinner then). We track the MAXIMUM length the
  // current turn has reached and WHEN it last advanced. DeepSeek's DOM flickers by a
  // few characters as it re-renders (a stalled, backgrounded turn was seen to
  // oscillate ±16 chars forever); counting that churn as "growth" pinned
  // isGenerating() permanently ON, which froze the tool chip in "run" and BLOCKED
  // the auto-resume watchdog so the queued tool never executed. Only true forward
  // progress (a new maximum) refreshes the timestamp.
  let _streamMax = -1, _streamAt = 0, _streamItem = null;

  // Sample the live turn's stream length (reasoning + answer). Called by both
  // detectors and continuously by the 200ms meter, so _streamAt is fresh to ~200ms.
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
  // The live turn made forward progress within the last `ms`. (>1 skips the "\n"
  // separator of an empty turn.) A few-char flicker never counts - only a new max.
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // True iff `item` is an assistant turn that has begun REASONING but produced no
  // answer yet and has NOT been halted. "Halted" is detected by the "Arrêté/Stopped"
  // marker DeepSeek renders as UI chrome on the stopped turn - NOT by the footer
  // "Continue" button (a single global control: a stale Continue from an earlier
  // truncated turn must never make us think the CURRENT, still-thinking turn has
  // stopped). The marker word can also legitimately appear in the model's reasoning
  // text (e.g. a script about a "stop" command), so we only count it as halted when
  // it is present in the turn but ABSENT from the reasoning text - i.e. it's UI
  // chrome, not reasoning content. Shared by isGenerating() and isBusyNow().
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

  // The turn carries DeepSeek's "Arrêté/Stopped" UI marker (manual stop or a forced
  // interruption) - distinguished from the model merely WRITING such a word in its
  // reasoning by requiring the marker outside the reasoning text.
  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return ZS.RE.stopped.test(item.textContent || "") && !ZS.RE.stopped.test(thinkTxt);
  }

  // Completion detection for the response watcher. Uses growth WINDOWS so a brief
  // lull mid-stream isn't mistaken for "done" (2s in the answer phase; the longer
  // REASON_IDLE_MS while reasoning, since DeepThink pauses for several seconds).
  function isGenerating() {
    if (document.querySelector(S.generating)) return true; // spin-up spinner
    const btn = document.querySelector(S.sendBtn);
    if (btn && btn.querySelector("rect")) return true;     // answer phase: stop square
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(REASON_IDLE_MS);
    return grewWithin(GEN_IDLE_MS);
  }

  // STRICT "is a generation happening RIGHT NOW?" - the gate for SENDING (the send
  // button doubles as stop, so sending mid-generation aborts the turn). We block on
  // the spin-up spinner, the answer-phase <rect>, or a reasoning turn whose text is
  // still GROWING (within the reasoning idle window). Crucially it does NOT linger
  // after the answer ends - once a turn has an answer (or has stopped/frozen), this
  // returns false so the loop's very next message can be sent. Growth is the sole
  // reasoning-phase signal, so a stale footer "Continue" can never cause a spurious
  // send into an actively-thinking turn.
  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (btn && btn.querySelector("rect")) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false; // answer present / stopped → free
    return grewWithin(REASON_IDLE_MS); // reasoning: live only while it keeps growing
  }
  // DeepSeek truncates long outputs/reasoning and shows a "Continue" button to
  // resume the SAME turn. Find the visible one (matched by text, locale-robust).
  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue; // not visible
      if (ZS.RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }

  // Click DeepSeek's native "Continue" button to resume the SAME truncated turn.
  // Cleaner than sending a continuation message (no extra turn). Returns true if a
  // button was found and clicked - the caller verifies generation actually resumed.
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

  // DeepSeek's composer is a <textarea> driven by React. We must set .value via
  // the native prototype setter so React's onChange fires, then dispatch an input
  // event, then click the primary send button (Enter on a textarea inserts a
  // newline, so we never rely on it).
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("DeepSeek input box not found");
    editor.focus();
    setTextareaValue(editor, text);
    // Wait for React to re-enable the send button. 150ms was sometimes not enough
    // (heavy page / long tool result / React 18 batched update) — poll up to 800ms
    // so we click the instant it is actually ready, rather than a fixed delay.
    await waitFor(() => {
      const btn = document.querySelector(S.sendBtn);
      return btn && btn.getAttribute("aria-disabled") !== "true" && !btn.querySelector("rect");
    }, 800);
    if (!clickSendButton() && !isBusyNow()) {
      pressEnter(editor);
    }
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  // Click DeepSeek's primary footer button to send. The send arrow and the stop
  // square are the SAME button (.ds-button--primary), so clicking it during a
  // generation STOPS the turn. The <rect> guard alone is NOT enough: during the
  // reasoning phase the button still shows the send <path> (no rect), so we must
  // also refuse to click whenever a generation is live (isBusyNow). We use the
  // STRICT check, not isGenerating(), so the ~2s post-turn growth window can't
  // block the very next message. We only ever send when DeepSeek is at rest.
  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = document.querySelector(S.sendBtn);
    if (btn && !btn.querySelector("rect") && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  async function submitAndGetBase(text) {
    diag("send", { text: String(text).slice(0, 60), busy: isBusyNow() });
    A.injecting = true;
    ui.inputCover(true);
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      // This replaces the old "if (isGenerating()) wait 4s" which fired on EVERY
      // send because diagSnap() refreshes _streamAt right before this point,
      // making isGenerating() always return true for the next 2s even when the
      // stream had long since finished.
      const _settleItem = lastAssistant();
      const _settleLen0 = _settleItem ? streamText(_settleItem).length : 0;
      await sleep(200);
      if (_settleItem && _settleItem === lastAssistant() &&
          streamText(_settleItem).length > _settleLen0) {
        await waitFor(() => !isGenerating(), 4000);
      }
      const base = assistantCount();
      const preUser = userCount();
      // "Landed" = a new turn appeared in the DOM.
      // In long chats, DeepSeek's list virtualisation evicts old turns as new ones
      // arrive — userCount/assistantCount can stay flat even when our message landed
      // (one eviction + one addition = net zero). The textarea-cleared signal below
      // is the primary fast gate; these counts serve only as a backup.
      const landed = () => userCount() > preUser || assistantCount() > base;
      // CRITICAL: never type/send while the tab is HIDDEN. Background tabs throttle
      // rendering, which made the landed-check unreliable and caused the SAME
      // feedback to be sent several times - DeepSeek then saw "duplicate outputs"
      // and the command↔result pairing desynced. So we send ONLY while visible:
      // if hidden, pause until the user returns, then send once.
      let tries = 0;
      let messageSent = false;
      while (!messageSent && !landed() && tries < 4 && !A.stop) {
        if (document.hidden) {
          diag("send.waitVisible", { tries });
          if (!(await waitFor(() => !document.hidden || A.stop, 600000)) || A.stop) break;
        }
        await typeAndSend(text);
        // React clears the textarea as soon as the send is accepted — faster and
        // more reliable than waiting for a DOM turn count change (which virtuali-
        // sation can mask by evicting an equal number of old turns).
        await waitFor(() => {
          if (editorText().trim() === "") messageSent = true;
          return messageSent || landed();
        }, 3500);
        tries++;
      }
      if (messageSent) diag("send.cleared", { tries });
      return base;
    } finally {
      ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (which is paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ERROR / LIMIT DETECTION
  // ════════════════════════════════════════════════════════════════════════
  function scanContextLimit(d) {
    // NEVER scan the assistant's own reply text: the model legitimately writes
    // things like `SESSION_EXPIRED = 4` or "token limit" in the code/scripts it
    // produces, which would falsely trip a "context limit" and kill the loop
    // mid-generation. Only DeepSeek's own UI chrome (toasts / modals / alerts),
    // which live OUTSIDE the chat turns, is a real signal.
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.chatItem)) continue; // inside a chat turn ⇒ model content, not UI
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && ZS.RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL PARSING  (validated against live K2.6 rendering)
  // ════════════════════════════════════════════════════════════════════════
  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const LUA_START = "###LUA###";
  const LUA_START_ALT = "###LUA---"; // models sometimes write --- instead of ###
  const LUA_END = "###END_LUA###";
  // Whitespace-tolerant markers: DeepSeek's markdown can insert spaces around the
  // hashes (e.g. "### LUA ###") or render END_LUA with a dash. These regexes match
  // those variants so a marker mangled by markdown still parses.
  const LUA_START_RE = /###\s*lua\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*###/i;

  // Find the first LUA start marker at or after `from`.
  // Returns { pos, len } where len is the marker's own length to skip past it.
  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(text.slice(from));
    return m ? { pos: from + m.index, len: m[0].length } : { pos: -1, len: 0 };
  }

  // Find the first LUA end marker at or after `from`. Returns its start index or -1.
  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(text.slice(from));
    return m ? from + m.index : -1;
  }

  // A command is `{"command":"name", ...}` (or "tool"). The params/arguments
  // object is OPTIONAL: paramless commands like list_commands are written as
  // `{"command":"list_commands"}`, so requiring "params" too would MISS them
  // (they'd be shown raw and never executed). We key on the `"command":"…"` /
  // `"tool":"…"` shape instead - a string-valued key, which prose almost never
  // contains - so paramless calls are detected without false-positiving on text.
  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;
  function hasToolSignature(r) {
    return (
      r.includes(START_M) ||
      r.includes("MCP_TOOL") ||
      LUA_START_RE.test(r) ||
      CMD_KEY_RE.test(r)
    );
  }

  // True if the reply contains a tool block that has STARTED but not yet CLOSED
  // (a ###LUA### / ###MCP_TOOL### opener with no matching end marker). Used by the
  // response watcher to avoid finalizing a command that is still being streamed.
  function hasOpenToolBlock(r) {
    if (!r) return false;
    const { pos: ls, len } = findLuaStart(r);
    if (ls !== -1 && findLuaEnd(r, ls + len) === -1) return true;
    const sm = r.indexOf(START_M);
    if (sm !== -1) {
      const low = r.toLowerCase();
      if (low.indexOf("###end_mcp_tool###", sm) === -1 && low.indexOf("###end-mcp_tool###", sm) === -1) return true;
    }
    // An inline JSON command ({"command"/"tool": …}) whose object has NOT closed yet
    // is still being streamed (a big multi_edit can take many seconds). Treat it as
    // open so the watcher keeps waiting instead of finalizing - and failing to parse -
    // half a command, which would drop the tool and end the turn as plain text.
    for (const key of ['"command"', '"tool"']) {
      const k = r.indexOf(key);
      if (k === -1) continue;
      const open = r.lastIndexOf("{", k);
      if (open !== -1 && matchBrace(r, open) === -1) return true;
    }
    return false;
  }

  // Normalise a parsed JSON object into { tool, arguments }, accepting both the
  // new ZeroScript schema ("command"/"params") and the legacy/function-calling
  // schema ("tool"/"arguments"/"name"/"args"). Returns null if not a valid call.
  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
    let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
    if (typeof name !== "string" || !name) return null;
    if (!args || typeof args !== "object") args = {};
    return { tool: name, arguments: args };
  }

  // String-aware matching-brace finder: index of the "}" that closes the "{" at
  // `start`, SKIPPING braces inside JSON string literals (escaped quotes handled).
  // A naive depth counter miscounts the braces embedded in code passed as a string
  // value (e.g. multi_edit's edits / a Lua snippet), grabs the wrong end, and makes
  // JSON.parse fail - which silently dropped the command, so the tool never ran and
  // the turn was treated as a plain-text answer. Returns -1 if unbalanced.
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  function extractJson(raw) {
    raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(raw, s);            // string-aware: not the last "}" in code
    if (e === -1) return null;
    try {
      return JSON.parse(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  function extractToolAnywhere(text) {
    for (const key of ['"command"', '"tool"']) {
      let pos = 0;
      while (true) {
        const s = text.indexOf(key, pos);
        if (s === -1) break;
        const start = text.lastIndexOf("{", s);
        if (start === -1) { pos = s + 1; continue; }
        const end = matchBrace(text, start); // string-aware brace matching
        if (end === -1) { pos = s + 1; continue; }
        try {
          const call = normalizeCall(JSON.parse(text.slice(start, end + 1)));
          if (call) return call;
        } catch {}
        pos = s + 1;
      }
    }
    return null;
  }

  function parseToolCalls(r) {
    // Lowercase for case-insensitive end-marker search.
    // Kimi writes: ###end_mcp_tool### (underscore) or ###end-mcp_tool### (dash).
    const rLow = r.toLowerCase();
    const findEndM = (from) => {
      const a = rLow.indexOf("###end_mcp_tool###", from);
      const b = rLow.indexOf("###end-mcp_tool###", from);
      if (a === -1 && b === -1) return -1;
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    };
    const out = [];
    let from = 0;
    while (true) {
      const sm = r.indexOf(START_M, from);
      if (sm === -1) break;
      const em = findEndM(sm);
      if (em === -1) break;
      const body = r.slice(sm + START_M.length, em);
      const { pos: ls, len: luaLen } = findLuaStart(body);
      const le = findLuaEnd(body, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: body.slice(ls + luaLen, le).trim() } });
        from = em + END_M.length;
        continue;
      }
      for (const sub of body.split(START_M)) {
        const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
        if (!cleaned) continue;
        const p = normalizeCall(extractJson(cleaned));
        if (p) out.push(p);
      }
      from = em + END_M.length;
    }
    if (out.length === 0) {
      const { pos: ls, len: luaLen } = findLuaStart(r);
      const le = findLuaEnd(r, ls === -1 ? 0 : ls + luaLen);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: r.slice(ls + luaLen, le).trim() } });
      }
    }
    if (out.length === 0) {
      const f = extractToolAnywhere(r);
      if (f) out.push(f);
    }
    return out;
  }

  function toolNameFromText(txt) {
    // Match the name even BEFORE its closing quote (`[^"]*`), so the chip shows
    // the real command name AS IT IS TYPED instead of a generic "command"
    // placeholder until the JSON closes. A still-empty value falls through.
    const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
    if (m && m[1]) return m[1];
    if (txt.includes("execute_luau") || LUA_START_RE.test(txt)) return "execute_luau";
    return "command";
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    const TIMEOUT = 300000;
    const STABLE_MS = 9000; // generating-flag stuck ON but text frozen → treat as done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now();
    let preStartSilent = 0; // when DeepSeek has produced nothing AND isn't generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up" tracking
    let reasonSince = 0; // when the turn has reasoning but no answer yet (loading phase)
    const WARMUP_MS = 45000; // a turn may show its empty container (+ a brief spinner) this long before the first token
    // While DeepSeek has written reasoning but not its answer yet, keep waiting up
    // to this long for the reply before accepting an "empty". The generating flag
    // can briefly read false during the loading pause between reasoning and the
    // reply; without this guard the loop finalized "empty" and abandoned the turn
    // mid-think (no Continue button - it just stopped).
    const REASON_NOREPLY_MS = 90000;

    while (Date.now() - t0 < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      const gen = isGenerating();
      const d = readAssistant();
      // DeepSeek virtualizes its list, so the absolute assistant count can DROP
      // (older turns evicted) even as a new reply is added at the bottom. A count
      // increase still proves a new turn appeared (no false positive), but we
      // must NOT depend on it - the generating flag is the reliable "reply has
      // begun" signal. Either one starts us; we never gate on d.reply alone
      // (before the new turn exists, lastAssistant() is the PREVIOUS answer).
      const newReply = assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the turn
      // node changes (so the PREVIOUS turn's content never counts toward the new
      // one). DeepSeek shows the empty turn container - and a brief .ds-loading
      // spinner - up to a few seconds before the first reasoning/answer token,
      // worse on a big context. Latching "started" off that spinner and then
      // finalizing "empty" ~1s later is what made the loop interrupt its own turn.
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;

      if (!started) {
        // CRITICAL: a bare count increase (newReply) is NOT enough to consider the
        // turn started. DeepSeek creates the empty turn CONTAINER up to a couple of
        // seconds before it streams the first reasoning/answer token (worse on a
        // big context, e.g. right after a page reload). If we latched "started" on
        // the empty container, the loop concluded "empty" ~1.1s later and fired a
        // retry that interrupted the turn as it began thinking. So we require actual
        // CONTENT (or the generating flag) - an empty container keeps us waiting.
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        if (gen || (newReply && hasText)) { started = true; }
        else {
          // DeepSeek can be slow to even CREATE/START the reply turn (server queue,
          // a long "thinking" phase, a big answer). Keep waiting - only give up if
          // it stays silent (nothing produced, not generating) for a long window.
          if (!preStartSilent) preStartSilent = Date.now();
          if (Date.now() - preStartSilent > 60000) return { kind: "empty" };
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag).
      if (d.reply !== lastText) { lastText = d.reply; lastChangeAt = Date.now(); }

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = scanContextLimit(d);
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) - even if the growth detector briefly lulls - so we
      // never parse/finalize half a command. Bounded: if the text hasn't grown for
      // a while, stop treating the open block as active (Continue/parse_error path).
      const blockActive = hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;

      if (gen || blockActive) {
        doneSince = 0;
        // Fallback: if DeepSeek's "generating" flag gets stuck but the text has
        // not changed for a while and we already have content, stop waiting.
        if (d.reply && Date.now() - lastChangeAt > STABLE_MS) {
          log("generating flag stuck - falling back to text stability");
        } else {
          await sleep(160);
          continue;
        }
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 500) {  // 500ms settle (was 1100) – rect gone means DOM is stable
        await sleep(120);
        continue;
      }

      // A turn that has produced NOTHING yet (no reasoning, no answer) is still
      // warming up - never finalize it as empty/truncated/text. A premature retry
      // here lands as the turn begins to think and interrupts it (send == stop).
      // A stale global "Continue" button (left by an earlier manual stop) would
      // otherwise even make this look "truncated". Wait for real content; only
      // after a long warm-up with nothing at all do we accept a genuine empty.
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize (the generating flag dips to false during the loading pause) -
      // wait for the reply, bounded so a genuinely stuck turn still resolves. A
      // manually-stopped turn (Arrêté marker) is exempt so a real stop still ends.
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      const r = d.reply;
      // DeepSeek's "conversation too long" / "server is busy" notices are always
      // SHORT system messages. Gating on a short reply stops the model's own long
      // output (which may quote "too long"/"please try again" in code or prose) from
      // tripping these and killing the loop mid-generation.
      if (r.length < 400 && ZS.RE.tooLong.test(r)) return { kind: "too_long" };
      if (hasToolSignature(r)) {
        const calls = parseToolCalls(r);
        if (calls.length) return { kind: "tool", calls, item: d.item };
        // A half-written command + DeepSeek's "Continue" button means the command
        // was truncated mid-stream → resume it (see "truncated" below) rather than
        // telling the model its JSON was malformed.
        if (findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present, not just
        // "tool"/"arguments" keywords mentioned in an explanation.
        if (r.includes(START_M) || LUA_START_RE.test(r)) return { kind: "parse_error", raw: r };
      }
      if (r.length < 400 && ZS.RE.busy.test(r)) return { kind: "busy" };
      // DeepSeek caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop, falling back
      // to sending a continuation message.
      if (findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") return { kind: "empty" };
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for Kimi)
  // ════════════════════════════════════════════════════════════════════════
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, kind: "disconnected", error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
          }
        });
      } catch (e) {
        resolve({ ok: false, kind: "disconnected", error: String(e) });
      }
    });
  }

  // Tools we never expose to DeepSeek: 'subagent' (long-running, hangs the loop)
  // and 'screen_capture' (returns an image DeepSeek can't see - it isn't
  // multimodal). They are filtered out of the advertised command list AND refused
  // in runTool if the model invokes one anyway (belt-and-braces).
  const BLOCKED_TOOLS = new Set(["subagent", "screen_capture"]);
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  const isBlockedTool = (name) => BLOCKED_TOOLS.has(bareToolName(name));

  async function ensureTools() {
    const r = await bg({ type: "list_tools" });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools.filter((t) => !isBlockedTool(t.name));
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
    }
    return A.toolList;
  }

  // ── Send images (Studio captures) to DeepSeek ────────────────────────────
  // Best-effort: we synthesise a paste event carrying the file(s) onto the
  // composer and wait for an upload thumbnail to appear. DeepSeek's image support
  // is more limited than Kimi's, so this path degrades gracefully - if no
  // thumbnail shows, we report that the model can't see the image (the user
  // still sees it in our own panel via ui.showImages).
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

  async function attachImagesToChat(images) {
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
    // A thumbnail appearing is our success signal (DeepSeek doesn't expose a
    // reliable per-file success/error class, so we just wait for it to render).
    return await waitFor(() => attachThumbs().length >= want, 15000);
  }

  async function runTool(call) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return ZS.FEEDBACK.parseError;
    // Blocked commands (also filtered out of the advertised list). If the model
    // calls one anyway, refuse it up-front with a clear, tailored error so it
    // abandons it and continues on its own instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (bareName === "screen_capture") {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    // Virtual command: list all available Roblox commands with full parameter details.
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      if (!A.toolList.length) return "No commands available - the bridge or Roblox Studio may be offline.";
      const lines = A.toolList.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        const params = Object.entries(props)
          .map(([k, v]) => `    ${k}${req.has(k) ? "" : "?"}: ${v.type || "any"}${v.description ? " - " + v.description : ""}`)
          .join("\n");
        return `${t.name}: ${(t.description || "").split("\n")[0]}${params ? "\n" + params : ""}`;
      });
      return `Output of '${name}':\nAvailable commands (${A.toolList.length}):\n\n${lines.join("\n\n")}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name)) {
      return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers (SW crash,
    // chrome.runtime hiccup), the loop gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    const r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout }), hardCap]);
    if (!r) return ZS.FEEDBACK.bridgeOffline;
    if (r.ok) {
      if (r.images && r.images.length) {
        ui.showImages(r.images, name);
        let attached = false;
        try { attached = await attachImagesToChat(r.images); } catch (e) { log("attach failed", e); }
        if (!attached) { try { clearAttachments(); } catch {} } // drop a broken upload
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return attached
          ? `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`
          : `Output of '${name}':\n${caption}\n(The image was shown to the user, but could not be attached for you to see.)`;
      }
      const text = r.text && r.text.length ? r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    if (r.kind === "disconnected") return ZS.FEEDBACK.bridgeOffline;
    if (r.kind === "timeout") {
      return `ERROR: tool '${name}' timed out after ${name === "execute_luau" ? 20 : 120}s.\n${r.error}\nTry a shorter/simpler call or check that Roblox Studio is open and responsive.`;
    }
    if (name === "execute_luau") {
      const err = r.error || "";
      const hint = err.includes("Failed to parse command code")
        ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
        : err.includes("attempt to") || err.includes("nil value")
          ? "Lua runtime error. Check that the API you are calling exists (use game:GetService() to access services). Make sure you use 'return' to output values, not 'print()'."
          : "Check your Lua syntax, make sure you use 'return' to output values (not 'print()'), and that all APIs you call exist in the current Roblox Studio context.";
      return `ERROR in execute_luau: ${err}\n\n${hint}\n\nFix the code and retry.`;
    }
    return `ERROR calling '${name}': ${r.error}\nRead the error carefully, fix the call or try a different approach.`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "execute_luau") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedback.startsWith("ERROR");
    const body = feedback.replace(/^Output of '[^']*':\n?/, "").trim();
    if (!body) return "";
    const lines = body.split("\n").filter((l) => l.trim()).length;
    const first = body.split("\n")[0].slice(0, 44);
    if (isErr) return first;
    return lines > 1 ? `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "execute_luau") return (a.code || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  async function agentLoop(base) {
    if (A.running) return;
    A.running = true;
    A.stop = false;
    let truncCount = 0;
    const MAX_TRUNC = 6;
    ui.showStop(true);
    setInputLock(true); // prevent user from typing while the agent is active
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", "DeepSeek reached its context limit",
            (res.detail || "") + "  -  click “New session” to start fresh.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "Conversation too long",
            "DeepSeek reports the conversation is getting too long. Start a new session.");
          break;
        }
        if (res.kind === "timeout") {
          ui.banner("warn", "No response from DeepSeek",
            "DeepSeek did not respond in time. The loop has stopped.");
          break;
        }
        if (res.kind === "busy") {
          ui.toast("DeepSeek is busy - retrying in 4s…");
          await sleep(4000);
          base = await submitAndGetBase(ZS.FEEDBACK.continue);
          continue;
        }
        // DeepSeek effectively never returns a genuinely empty turn (the warm-up
        // guard already waits out its slow start), so we no longer retry/banner on
        // "empty" - that only risked a spurious send. Just end the loop quietly.
        if (res.kind === "empty") { diag("empty.end"); break; }

        // The turn stopped with DeepSeek's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the "Arrêté" marker (a stop - user OR a DeepSeek
          // self-halt), respect it and do NOT auto-resume. Self-interruptions are
          // rare; never relaunching keeps the user's Stop button reliable.
          if (turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise DeepSeek truncated by length / was writing too long → continue
          // the SAME turn. Prefer clicking its native Continue button (no extra turn);
          // fall back to a continuation message only if the click doesn't resume.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (clickContinueBtn() && await waitFor(() => isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("Reply was cut off, resuming…");
            base = await submitAndGetBase(ZS.FEEDBACK.truncated);
            continue;
          }
          if (res.text) break; // give up resuming; keep what we have as the answer
          ui.banner("warn", "Reply kept getting cut off",
            "DeepSeek repeatedly hit its length limit. Try a shorter request or start a new session.");
          break;
        }
        truncCount = 0;

        if (res.kind === "parse_error") {
          base = await submitAndGetBase(ZS.FEEDBACK.parseError);
          continue;
        }
        if (res.kind === "text") break; // final answer

        if (res.kind === "tool") {
          const calls = res.calls;
          if (calls.length > 1) {
            base = await submitAndGetBase(ZS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?")));
            continue;
          }
          const call = calls[0];
          const category = ZS.toolCategory(call.tool);

          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          diag("tool.start", { name: call.tool });
          const feedback = await runTool(call);
          A.toolRunning = false;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) break;
          const isErr = feedback.startsWith("ERROR");
          decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
            true, feedback.replace(/^Output of '[^']*':\n?/, ""), category);
          base = await submitAndGetBase(feedback);
        }
      }
    } catch (e) {
      diag("loop.error", { msg: String((e && e.message) || e) });
      ui.banner("warn", "Internal loop error", String((e && e.message) || e));
    } finally {
      A.running = false;
      A.stop = false;
      A.toolRunning = false;
      ui.showStop(false);
      setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
  }

  function stopLoop() {
    diag("stopLoop");
    A.stop = true;
    A.userStopped = true; // suppress auto-resume until the next user message
    // Click DeepSeek's stop only if it is actually in the stop state (<rect>), so
    // we never accidentally re-trigger a send.
    const b = document.querySelector(S.stopBtn);
    if (b && b.querySelector("rect")) try { b.click(); } catch {}
    ui.toast("Loop stopped.");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession(opts) {
    if (A.running || A.starting) return;
    // "Start session" / "Starting Up" are allowed ONLY on a blank conversation.
    // Opening an EXISTING conversation must never trigger the bootstrap (which
    // would inject the system prompt into someone else's chat and show a stray
    // "Starting Up" chip). The explicit "New session" recovery button passes
    // force:true (it already confirms with the user).
    if (!chatIsEmpty() && !(opts && opts.force) && !A.started) {
      ui.toast("Open a new, empty conversation to start a session.");
      return;
    }
    A.userStopped = false;
    A.starting = true;
    ui.setStarting(true);
    ui.updateStartGate(); // reveal the composer + send the panel back to the corner now
    setInputLock(true); // block user input during bootstrap
    try {
      await ensureTools();
      if (!A.toolList.length) {
        ui.banner("warn", "Bridge or Studio offline",
          "Could not fetch Roblox tools. Start the ZeroScript bridge and make sure Roblox Studio is open, then try again.");
        return;
      }
      const modeState = await ensureComposerModesReady("startup");
      if (!modeState.expertOn) {
        ui.banner("warn", "DeepSeek mode not ready",
          "Could not switch DeepSeek to Expert mode. Start a new chat or reload DeepSeek, then try again.");
        return;
      }
      const prompt = ZS.buildSystemPrompt(A.toolList);
      const base = await submitAndGetBase(prompt);
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      // If DeepSeek calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        decorate.toolBox(startRes.item, "Loading commands", "done", `${A.toolList.length} commands`, true);
        const base2 = await submitAndGetBase(toolFeedback);
        await waitForResponse(base2); // wait for "I'm ready" reply
      }
      A.started = true;
      rememberSession(location.pathname); // remember this conversation (survives virtualization AND reloads)
      ui.setStarted(true);
      ui.toast("Agent ready. Ask DeepSeek to build something in Roblox.");
    } catch (e) {
      ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      A.starting = false;
      ui.setStarting(false);
      setInputLock(false); // always unlock after bootstrap
      decorate.sweep(); // flip the chip from animated → settled
    }
  }

  // DeepSeek's "New chat" button (top of the sidebar). Identified as the topmost,
  // smallest element whose WHOLE text is the new-chat label, with an icon and NO
  // href (history items linking to existing chats carry an href / sit lower).
  function findNewChatButton() {
    let best = null, bestArea = Infinity;
    for (const e of document.querySelectorAll('a,div,button,[role="button"]')) {
      const t = (e.textContent || "").trim();
      if (!ZS.RE.newChat.test(t)) continue;
      if (e.getAttribute("href")) continue;     // skip sidebar history links
      if (!e.querySelector("svg")) continue;     // the button carries an icon
      const r = e.getBoundingClientRect();
      if (r.top > 300 || r.width === 0) continue; // sidebar header only, visible
      const area = r.width * r.height;
      if (area < bestArea) { best = e; bestArea = area; } // tightest = the button itself
    }
    return best;
  }

  // Explicit "New session": open a FRESH DeepSeek conversation and bootstrap it
  // there - rather than re-injecting the system prompt into the current chat
  // (which bloats it and, after a context limit, would be useless). Falls back to
  // an in-place start only if the New-chat button can't be found.
  async function newSessionClick() {
    if (A.running || A.starting) {
      ui.toast("Please wait - ZeroScript is busy.");
      return;
    }
    const btn = findNewChatButton();
    if (btn) {
      const prevPath = location.pathname;
      try { btn.click(); } catch {}
      // Wait for DeepSeek to switch to a blank conversation (SPA route change).
      await waitFor(() => location.pathname !== prevPath && chatIsEmpty() && !!getEditor(), 6000);
      await waitFor(() => chatIsEmpty() && !!getEditor(), 2000);
      // Fresh conversation → reset session state before bootstrapping it.
      A.started = false;
      ui.setStarted(false);
    }
    startSession({ force: true });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  USER-TURN DETECTION
  // ════════════════════════════════════════════════════════════════════════
  function hookUserSend() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        const text = editorText().trim();
        if (text === "") return;

        if (A.injecting || A.running || A.starting) return;

        // No session yet → the user must click "Start session" first. We block
        // the send and point them at the Start button instead of auto-starting,
        // so a non-technical user can't skip the (mandatory) bootstrap step.
        // ONLY on a blank chat: an existing conversation isn't ours to gate.
        if (!A.started) {
          if (!chatIsEmpty()) return; // existing conversation → let DeepSeek handle it
          e.preventDefault();
          e.stopImmediatePropagation();
          ui.nudgeStart();
          return;
        }

        // A fresh user message = fresh intent: clear any previous manual stop so
        // the loop is allowed to run again.
        A.userStopped = false;
        const base = assistantCount();
        setTimeout(() => { if (!A.running) agentLoop(base); }, 300);
      },
      true
    );

    // The keydown hook only catches Enter inside the editor. Users also send
    // by CLICKING the send button (mouse) - handle that path too so the loop
    // always runs.
    document.addEventListener(
      "click",
      (e) => {
        // Not on a chat page (e.g. login / OAuth page) - never intercept anything.
        if (!getEditor()) return;
        const t = e.target;
        // DeepSeek's native "Continue" button = a clear intent to RESUME after a
        // stop/truncation. Clear the manual-stop latch so the loop's auto-resume
        // can pick the (resumed) turn's tool call back up cleanly.
        const cont = t && t.closest && t.closest(".ds-button");
        if (cont && ZS.RE.continueBtn.test((cont.innerText || "").trim())) {
          A.userStopped = false;
          A.stop = false;
          diag("nativeContinue");
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        // DeepSeek's stop button shares the send button's spot, toggling to a
        // <rect>. A click on it is a deliberate manual stop → suppress auto-resume.
        if (btn.querySelector("rect")) {
          A.userStopped = true;
          A.stop = true;
          diag("nativeStop");
          return;
        }
        if (btn.getAttribute("aria-disabled") === "true") return;
        if (A.injecting || A.running || A.starting) return;
        if (!A.started) {
          if (!chatIsEmpty()) return; // existing conversation → let DeepSeek handle it
          e.preventDefault();
          e.stopImmediatePropagation();
          ui.nudgeStart();
          return;
        }
        A.userStopped = false;
        const base = assistantCount();
        setTimeout(() => { if (!A.running) agentLoop(base); }, 300);
      },
      true
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    screen:  SVG('<rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    roblox:  SVG('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    read:    SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    edit:    SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    generate: SVG('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>'),
    tool:    SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result:  SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    check:   SVG('<polyline points="20 6 9 17 4 12"/>'),
    error:   SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    gear:    SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 11h.1a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z"/>'),
  };
  const SPIN = '<span class="zs-spin"></span>';

  function iconFor(category, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return ICONS.error;
    if (phase === "done") return ICONS.check;
    if (phase === "result") return ICONS.result;
    if (phase === "sys") return ICONS.gear;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (operates on .ds-message)
  //  Chips are real "tool cards": header (icon/label/detail) + an expandable
  //  body (real args / output), themed by tool category and execution state.
  // ════════════════════════════════════════════════════════════════════════

  // Text used to CLASSIFY a turn - deliberately excludes our own .zs-chip. A chip
  // carries a tool name in its label ("name", "execute_luau", …); if that leaked
  // back into classification, a recycled (virtualized) node still wearing a stale
  // chip would be mis-detected (this is exactly how a parse-error NOTE that quotes
  // {"command": "name"} got turned into a bogus command card).
  function classifyText(item) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (n.nodeType === 1 && n.classList && n.classList.contains("zs-chip")) continue;
      t += n.textContent || "";
    }
    return t;
  }

  // A turn the EXTENSION injected (always sent as a user turn): a tool result, an
  // ERROR, or a "(System note: …)" control message. Matched ONLY by the fixed
  // shapes we emit - never by command-like keywords, since a parse-error note
  // quotes a {"command": …} example that must NOT be read as a real command.
  function isInjectedFeedback(txt) {
    return /^\s*Output of '/.test(txt) ||
           /^\s*ERROR\b/.test(txt) ||
           /^\s*\(System note:/.test(txt);
  }

  // The assistant emitted a ZeroScript command (JSON or a ###LUA### block).
  function hasCommandShape(txt) {
    return txt.includes(START_M) ||
           LUA_START_RE.test(txt) ||
           CMD_KEY_RE.test(txt); // command/tool with OR without params (e.g. list_commands)
  }

  // Strip every trace of our decoration from a node. Needed because DeepSeek
  // virtualizes (recycles) .ds-message nodes: a node that was a command/result
  // card can be reused to render unrelated text, and our chip + data flags + hidden
  // paragraphs would otherwise persist and hide real content.
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
  }

  const decorate = {
    // Hide the raw tool call so nothing of it leaks beside the chip. DeepSeek
    // markdown often SPLITS a ###LUA### … ###END_LUA### block across several
    // <p> paragraphs (start marker in one, code lines in the next, end marker in
    // the last) - hiding only the paragraphs that literally contain a marker
    // would leave the code lines visible. So we hide the whole CONTIGUOUS RUN of
    // block-level children from the start marker through the end marker. A fenced
    // code block (start+end in one <pre>) and an inline JSON command are handled
    // as a single-element run. Returns where to insert the chip: {parent, ref}.
    _findToolEl(item, chip) {
      const hasStart = (t) => LUA_START_RE.test(t) || t.includes("###mcp_tool###");
      const hasEnd = (t) => LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
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
    },

    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      let chip = item.querySelector(".zs-chip");
      if (!chip) chip = document.createElement("div");
      chip.className = `zs-chip cat-${category} ${cls || ""}`;
      const hasBody = !!body;
      chip.innerHTML =
        `<div class="zs-chip-head">` +
          `<span class="zs-chip-ic">${iconFor(category, phase)}</span>` +
          `<span class="zs-chip-tx"></span>` +
          `<span class="zs-chip-dt"></span>` +
          (hasBody ? `<span class="zs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>` : "") +
        `</div>` +
        (hasBody ? `<div class="zs-chip-body"><pre></pre></div>` : "");
      chip.querySelector(".zs-chip-tx").textContent = label;
      if (detail) chip.querySelector(".zs-chip-dt").textContent = detail;
      if (hasBody) {
        chip.querySelector(".zs-chip-body pre").textContent = body;
        const head = chip.querySelector(".zs-chip-head");
        head.style.cursor = "pointer";
        head.onclick = () => chip.classList.toggle("open");
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (!chip.parentElement) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        const spot = this._findToolEl(item, chip);
        if (spot) spot.parent.insertBefore(chip, spot.ref);
        else if (!chip.parentElement) item.insertBefore(chip, item.firstChild);
      }
      item.dataset.zs = cls || "1";
      return chip;
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item) {
      if (item.dataset.zloop) return; // loop owns it (live tool execution)
      const txt = classifyText(item); // excludes thinking AND our own chip text

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent, keyed
      //    off our fixed output shapes (never command keywords). Re-applied even if
      //    a stale chip from a recycled node is present (signature-gated).
      if (isUserItem(item) && isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden")) {
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
        }
        return;
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      //    ONLY the assistant writes commands, so a user note quoting {"command":…}
      //    can never land here. Includes execute_luau (###LUA###…) so its block is
      //    hidden behind the chip AS IT IS WRITTEN, not only once parsed.
      if (isAssistantItem(item) && hasCommandShape(txt)) {
        const live = item === lastAssistant() && (isGenerating() || A.running);
        const phase = live ? "run" : "done";
        if (item.dataset.zphase !== phase) this.toolBox(item, toolNameFromText(txt), phase, "", false);
        return;
      }

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node, or a command turn whose text has since changed), strip
      //    it so we never hide genuine content behind a stale/wrong chip.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        resetDecoration(item);
      }
    },

    sweep() {
      for (const it of document.querySelectorAll(S.chatItem)) this.classify(it);
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, dot, stopBtn, cover, coverRaf, startBtn, hintEl, ctaEl, activeEl, activeTxtEl, stateEl;
    let panel, gateRaf, bridgeOk = false;
    let wasConnected = false, bridgeBannerEl = null;

    function build() {
      root = document.createElement("div");
      root.id = "zs-root";
      root.innerHTML = `
        <div id="zs-panel">
          <div class="zs-row">
            <span id="zs-dot" class="off"></span>
            <span id="zs-title">ZeroScript <span class="zs-free">Free</span></span>
            <button id="zs-kofi" title="Support ZeroScript ♥">♥ Tip</button>
          </div>
          <div id="zs-tip-menu" hidden></div>
          <div class="zs-row zs-sub"><span id="zs-state">Bridge: …</span></div>
          <div id="zs-cta">
            <button id="zs-start">▶  Start session</button>
            <div id="zs-hint">Click <b>Start</b>, then type what you want to build - DeepSeek will drive Roblox Studio for you.</div>
          </div>
          <div id="zs-active" hidden>
            <span class="zs-active-txt"><span class="zs-live-dot"></span>Session active - just type your request in DeepSeek</span>
            <button id="zs-new" title="Open a fresh DeepSeek conversation and start a new agent session there">⟳ New session</button>
          </div>
          <button id="zs-stop" hidden>■ Stop</button>
        </div>
      `;
      document.documentElement.appendChild(root);
      panel = root.querySelector("#zs-panel");
      dot = root.querySelector("#zs-dot");
      stopBtn = root.querySelector("#zs-stop");
      startBtn = root.querySelector("#zs-start");
      hintEl = root.querySelector("#zs-hint");
      ctaEl = root.querySelector("#zs-cta");
      activeEl = root.querySelector("#zs-active");
      activeTxtEl = root.querySelector(".zs-active-txt");
      stateEl = root.querySelector("#zs-state");
      startBtn.addEventListener("click", () => startSession());
      root.querySelector("#zs-new").addEventListener("click", newSessionClick);
      buildTipMenu();
      stopBtn.addEventListener("click", stopLoop);
    }

    // Support menu: Ko-fi + Roblox Game Pass "tips" (native currency).
    function buildTipMenu() {
      const menu = root.querySelector("#zs-tip-menu");
      const kofiBtn = root.querySelector("#zs-kofi");
      const open = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} menu.hidden = true; };
      let html = `<div class="zs-tip-h">Support ZeroScript ♥</div>`;
      html += `<button class="zs-tip-opt zs-tip-kofi" data-u="${KOFI_URL}">☕ Ko-fi - any amount</button>`;
      html += `<div class="zs-tip-sep">or tip in Robux</div>`;
      for (const p of ROBUX_PASSES) {
        html += `<button class="zs-tip-opt zs-tip-rbx" data-u="${passUrl(p.id)}">⬡ ${p.robux} Robux</button>`;
      }
      menu.innerHTML = html;
      menu.querySelectorAll(".zs-tip-opt").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      kofiBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      // Close when clicking anywhere else.
      document.addEventListener("click", (e) => {
        if (menu.hidden) return;
        if (!menu.contains(e.target) && e.target !== kofiBtn) menu.hidden = true;
      }, true);
    }

    // ── First-time onboarding card (bridge missing) ─────────────────────────
    // Shown once, above the panel, when the bridge has never been connected.
    // Dismissed via "Got it" → stored in chrome.storage.local → never shown again.
    let setupCard = null, setupSeen = false, setupRaf = null;
    try {
      chrome.storage.local.get("zsSetupSeen", (r) => {
        if (r && r.zsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "zs-setup";
      setupCard.hidden = true;
      const videoBtn = VIDEO_URL
        ? `<a id="zs-setup-video" href="${VIDEO_URL}" target="_blank" rel="noopener">▶ Watch tutorial</a>`
        : "";
      setupCard.innerHTML =
        `<div id="zs-setup-title">👋 Welcome to ZeroScript!</div>` +
        `<div id="zs-setup-sub">You need the <b>Bridge</b> to connect to Roblox Studio. Download it from GitHub:</div>` +
        videoBtn +
        `<div class="zs-setup-copy-row">` +
          `<input type="text" id="zs-setup-link" readonly value="${GITHUB_URL}">` +
          `<button id="zs-setup-copy">Copy</button>` +
        `</div>` +
        `<div id="zs-setup-steps">1. Download the Bridge &amp; start.bat<br>2. Run start.bat<br>3. Come back here and click <b>Start session</b></div>` +
        `<button id="zs-setup-dismiss">Got it ✓</button>`;
      document.documentElement.appendChild(setupCard);

      setupCard.querySelector("#zs-setup-copy").addEventListener("click", () => {
        try { navigator.clipboard.writeText(GITHUB_URL); } catch {
          const inp = setupCard.querySelector("#zs-setup-link");
          inp.select(); try { document.execCommand("copy"); } catch {}
        }
        const btn = setupCard.querySelector("#zs-setup-copy");
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      });

      setupCard.querySelector("#zs-setup-dismiss").addEventListener("click", () => {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
        hideSetup();
      });
    }

    function placeSetup() {
      if (!setupCard || setupCard.hidden || !panel) return;
      const r = panel.getBoundingClientRect();
      setupCard.style.top = (r.bottom + 10) + "px";
      setupRaf = requestAnimationFrame(placeSetup);
    }

    function showSetup() {
      if (!setupCard) buildSetup();
      if (setupCard.hidden) {
        setupCard.hidden = false;
        cancelAnimationFrame(setupRaf);
        placeSetup();
      }
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
      cancelAnimationFrame(setupRaf);
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      showSetup();
    }

    // Decide what the corner panel shows:
    //  • a FRESH blank chat, not started → onboarding CTA (big "Start session").
    //  • anything else (a started session OR an existing conversation the user
    //    came back to) → the compact "active" row with the "New session" button,
    //    so returning to an existing chat lets you just continue (no red nag, no
    //    forced new-chat). The label adapts to whether an agent is actually live.
    function syncPanel() {
      if (!ctaEl) return;
      // Show the onboarding CTA on a fresh chat OR throughout the bootstrap (so the
      // "Starting session…" spinner stays visible even as the chat fills in).
      const showCta = A.starting || (isFreshChat() && !A.started);
      ctaEl.hidden = !showCta;
      activeEl.hidden = showCta;
      if (!showCta && activeTxtEl) {
        activeTxtEl.innerHTML = A.started
          ? `<span class="zs-live-dot"></span>Session active. Just type your request in DeepSeek.`
          : `<span class="zs-live-dot idle"></span>No active agent in this chat. Type to continue it, or click “New session” for a fresh agent.`;
      }
    }

    // Kept for callers that flip A.started; the actual decision lives in syncPanel.
    function setStarted() {
      syncPanel();
      updateStartGate(); // reflect the new state on the input gate immediately
    }

    function setStarting(on) {
      if (!startBtn) return;
      startBtn.disabled = on;
      startBtn.innerHTML = on
        ? `<span class="zs-spin"></span><span>Starting session…</span>`
        : "▶  Start session";
      if (on && hintEl) hintEl.textContent = "Connecting the agent to Roblox Studio… a few seconds.";
    }

    function setStatus(s) {
      A.bridge = s;
      if (!dot) return;
      const servers = s.servers || [];
      const up = servers.filter((x) => x.alive).length;
      const ok = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
      dot.className = s.connected ? (ok ? "on" : "warn") : "off";
      let txt;
      if (!s.connected) txt = "Bridge offline - run the ZeroScript bridge";
      else if (!ok) txt = "Bridge OK - open Roblox Studio";
      else txt = `Connected · ${s.tools} Roblox tools ready`;
      stateEl.textContent = txt;
      bridgeOk = ok;
      // Bridge-drop alert for non-technical users: a clear, persistent red
      // banner the moment a previously-connected bridge goes offline. It clears
      // itself automatically when the bridge reconnects.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      refreshStart();
      refreshSetup(s.connected);
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) {
      if (!on) {
        if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
        return;
      }
      if (bridgeBannerEl) return; // already shown
      const b = document.createElement("div");
      b.className = "zs-banner limit";
      b.innerHTML = `<div class="zs-banner-t">⚠ Lost connection to ZeroScript</div>
        <div class="zs-banner-m">The ZeroScript bridge stopped on your PC. Restart it (and keep Roblox Studio open): the agent will reconnect automatically as soon as it is detected again.</div>
        <div class="zs-banner-acts"><button class="zs-banner-x">Close</button></div>`;
      b.querySelector(".zs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Gate the Start button on BOTH a usable bridge AND a blank conversation, so
    // it can only ever bootstrap a fresh chat (never inject into an existing one)
    // and never fail silently. The hint explains whatever is missing.
    function refreshStart() {
      if (!startBtn || A.starting) return;
      // The CTA only ever shows on a fresh blank chat (see syncPanel), so the only
      // thing left to gate Start on is a usable bridge.
      const ready = bridgeOk;
      startBtn.disabled = !ready;
      if (!hintEl) return;
      hintEl.innerHTML = ready
        ? `Click <b>Start</b>, then type what you want to build - DeepSeek will drive Roblox Studio for you.`
        : (!A.bridge.connected
            ? `⚠ Start the <b>ZeroScript bridge</b> on your PC first.`
            : `⚠ Open <b>Roblox Studio</b> so the tools become available.`);
      // A blocking warning is shown in red so a non-technical user can't miss it.
      hintEl.classList.toggle("zs-hint-warn", !ready);
    }

    function showStop(v) { if (stopBtn) stopBtn.hidden = !v; }

    // Briefly draw the user's eye to the Start button when they try to type/send
    // before a session exists.
    function nudgeStart() {
      toast("Click “▶ Start session” first to enable the agent.");
      if (!startBtn) return;
      startBtn.classList.add("zs-flash");
      setTimeout(() => startBtn.classList.remove("zs-flash"), 1200);
    }

    // Restore the control panel to its normal bottom-right corner.
    function ungate() {
      document.querySelectorAll(".zs-frame-hidden").forEach((e) => e.classList.remove("zs-frame-hidden"));
      if (root) root.classList.remove("zs-gate-on", "zs-gate-starting");
      if (panel) { panel.style.left = panel.style.top = panel.style.width = panel.style.minHeight = ""; }
      cancelAnimationFrame(gateRaf);
    }

    // Input gate: on a BLANK, not-yet-started conversation we hide the ENTIRE
    // composer frame (input + send + mode selector) and bring the control panel
    // up OVER it, enlarged, so a non-technical user can't miss the mandatory
    // "Start session" step. It only ever shows on a blank chat (never on an
    // existing one). The moment the session starts (A.starting), the frame is
    // revealed and the panel slides back to the bottom-right corner. The
    // extension still types/sends programmatically (visibility:hidden doesn't
    // block scripted value-setting or .click()).
    function updateStartGate() {
      syncPanel();
      refreshStart();
      const frame = composerFrame();
      // Gate ONLY on a genuinely FRESH chat before the session is started. Using
      // isFreshChat() (mode selector present) instead of chatIsEmpty() means an
      // existing conversation whose turns are still loading never flashes the big
      // "Start session" panel. The moment the user clicks Start (A.starting) we
      // collapse back to the corner (the composer re-lays-out during the bootstrap,
      // which looked buggy with the big panel tracking it).
      const show = !A.started && !A.starting && isFreshChat() && !!frame && !!panel;
      if (!show) { ungate(); return; }
      document.querySelectorAll(".zs-frame-hidden").forEach((e) => {
        if (e !== frame) e.classList.remove("zs-frame-hidden");
      });
      frame.classList.add("zs-frame-hidden");
      root.classList.add("zs-gate-on");
      const place = () => {
        if (!root.classList.contains("zs-gate-on")) return;
        const f = composerFrame();
        if (!f) return;
        const r = f.getBoundingClientRect();
        // Sit the panel exactly over the composer box so it visually replaces it.
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.width = r.width + "px";
        panel.style.minHeight = Math.max(r.height, 120) + "px";
        gateRaf = requestAnimationFrame(place);
      };
      place();
    }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    function opaqueBg(el) {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor || "#ffffff";
    }

    function inputCover(on) {
      const ed = getEditor();
      if (!on) {
        if (cover) cover.style.display = "none";
        if (ed) ed.classList.remove("zs-typing");
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      ed.classList.add("zs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "zs-input-cover";
        cover.innerHTML = `<span class="zs-spin"></span><span>Working…</span>`;
        document.documentElement.appendChild(cover);
      }
      cover.style.display = "flex";
      const place = () => {
        const e = getEditor();
        if (!e || cover.style.display === "none") return;
        const r = e.getBoundingClientRect();
        cover.style.left = r.left + "px";
        cover.style.top = r.top + "px";
        cover.style.width = r.width + "px";
        cover.style.height = Math.max(r.height, 36) + "px";
        cover.style.background = opaqueBg(e);
        coverRaf = requestAnimationFrame(place);
      };
      place();
    }

    function toast(msg) {
      const t = document.createElement("div");
      t.className = "zs-toast";
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => t.classList.add("show"), 10);
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function banner(kind, title, msg) {
      const b = document.createElement("div");
      b.className = `zs-banner ${kind}`;
      b.innerHTML = `<div class="zs-banner-t"></div><div class="zs-banner-m"></div>
        <div class="zs-banner-acts">
          <button class="zs-banner-new">⟳ New session</button>
          <button class="zs-banner-x">Close</button>
        </div>`;
      b.querySelector(".zs-banner-t").textContent = title;
      b.querySelector(".zs-banner-m").textContent = msg;
      b.querySelector(".zs-banner-x").addEventListener("click", () => b.remove());
      b.querySelector(".zs-banner-new").addEventListener("click", () => { b.remove(); newSessionClick(); });
      root.appendChild(b);
    }

    function showImages(images, toolName) {
      const wrap = document.createElement("div");
      wrap.className = "zs-img-wrap";
      const hdr = document.createElement("div");
      hdr.className = "zs-img-hdr";
      hdr.textContent = `📷 ${toolName} · ${images.length} image${images.length > 1 ? "s" : ""}`;
      const close = document.createElement("button");
      close.textContent = "✕";
      close.addEventListener("click", () => wrap.remove());
      hdr.appendChild(close);
      wrap.appendChild(hdr);
      for (const img of images) {
        const el = document.createElement("img");
        el.src = `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
        el.className = "zs-img";
        wrap.appendChild(el);
      }
      root.appendChild(wrap);
    }

    build();
    return { setStatus, setStarted, setStarting, showStop, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail (never on
  //    thinking or a plain answer). Updates text only, so the chip's spinner
  //    animation never restarts. The elapsed-time ANCHOR is stored on the chip's
  //    DOM node (dataset) rather than in a JS variable, so the timer keeps a
  //    correct value when the user switches conversations / DeepSeek re-renders
  //    the turn (a JS-only anchor was reset to 0 on every re-mount). ───────────
  const TOKEN_CHARS = 4;

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".zs-chip .zs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node). `key` lets
  // the tool-execution timer and the streaming timer use separate anchors.
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  setInterval(() => {
    const gen = isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Use the growth-tolerant isGenerating() (not just
    // the <rect>): a SHORT command written right after a long reasoning phase shows
    // its stop-square for only a frame or two - too briefly for this 200ms sampler
    // to ever catch - so a <rect>-only clock left lastGenAt stale and the watchdog
    // never recovered the (unrun) command. isGenerating()'s 2s window catches it.
    if (gen) A.lastGenAt = Date.now();
    // The "■ Stop" button, by contrast, uses a STRICT signal: the footer button's
    // stop-square (<rect>). That is never present just because a conversation
    // (re)loads or the user scrolls back through it, so Stop doesn't flash on
    // reload / scroll. The loop-active case is covered by A.running.
    const sb = document.querySelector(S.sendBtn);
    const liveGen = !!(sb && sb.querySelector("rect"));
    ui.showStop(A.running || A.toolRunning || liveGen);

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // DeepSeek is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = lastAssistant();
      const reply = item ? itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && hasToolSignature(reply)) {
        // Live-correct the label: the chip is first created with the generic
        // "command" placeholder (the name hasn't streamed yet); as soon as the real
        // name appears (e.g. "multi_edit", "execute_luau") swap it in - text only.
        const name = toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `~${tokens.toLocaleString()} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════


  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, tools: msg.tools, servers: msg.servers });
    }
  });

  bg({ type: "status" }).then((s) => s && ui.setStatus(s));
  setInterval(() => bg({ type: "status" }).then((s) => s && ui.setStatus(s)), 5000);

  // Session state is derived from the ACTUAL chat, but DeepSeek VIRTUALIZES its
  // message list: the system-prompt turn (the very first message) is dropped from
  // the DOM once it scrolls out of the virtual window in a long session. A naive
  // "marker present?" scan would then wrongly flip the panel back to "Start" and
  // risk re-injecting the prompt. So we key "started" by conversation (the URL
  // path): once we have seen the marker for a path, we remember it. A fresh /
  // different chat (path not remembered, no marker) correctly shows "Start".
  // We never flip while busy, so an in-flight start/loop isn't disturbed.
  const startedSessions = new Set();
  let lastSyncPath = null;
  // Remember a started conversation by URL path, PERSISTED to extension storage so
  // it survives a page reload. Without this, after a reload the in-memory set is
  // empty and the system-prompt marker is virtualized far up the (long) chat, so
  // the panel wrongly shows "No active agent". Capped so it can't grow forever.
  function rememberSession(path) {
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ zsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync (the very first sync ran before
  // storage resolved, so it may have shown "Start"/"No agent" momentarily).
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS a ZeroScript session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, one of our injected tool-result
  // / system-note turns ("Output of '…'", "(System note:"), or a ZeroScript
  // command an assistant wrote. This content-based signal works even after a full
  // cold start (when in-memory + stored state can be gone) and regardless of how
  // far up the user has scrolled - the conversation is full of these artefacts.
  function domHasZsSignal() {
    for (const it of document.querySelectorAll(S.chatItem)) {
      const txt = it.textContent || "";
      if (txt.includes(ZS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      if (isAssistantItem(it) && hasCommandShape(txt)) return true;
    }
    return false;
  }
  function syncSessionState() {
    if (A.starting || A.injecting || A.running) return;
    const path = location.pathname;
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path === lastSyncPath) {
      // SAME conversation: never downgrade a known-started session just because
      // virtualization scrolled the system-prompt turn out of the DOM while the
      // user reads back through history. "started" is sticky until the path
      // actually changes (a different conversation).
      has = A.started || markerInDom || startedSessions.has(path);
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || startedSessions.has(path);
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so if we only ever scheduled via rAF, a result/note injected while the
  // user is on another tab would render raw (uncamouflaged) until they return.
  // When the tab is hidden we fall back to a timer (still throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      enforceComposer();   // force Expert + hide Rapide + hide DeepThink toggle
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  const mo = new MutationObserver(scheduleSweep);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // Belt-and-braces: a low-frequency sweep that runs regardless of tab visibility
  // or mutation timing, so camouflage always converges even if a rAF is dropped.
  setInterval(scheduleSweep, 1500);
  // When the user returns to the tab, immediately refresh camouflage/state (rAF
  // was paused in the background, so the panel/chips can be stale on return).
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();
  hookUserSend();

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call that is merely
  // PRESENT in the DOM without a fresh live generation - i.e. when the user opens
  // or scrolls back through an existing conversation, DeepSeek (re)renders old
  // assistant turns whose tool JSON would otherwise be re-executed. Two guards:
  //   • A.userStopped - the user halted (our Stop or DeepSeek's native stop); we
  //     never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn that came from a generation in the
  //     last few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries DeepSeek's "Arrêté/Stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  const RESUME_FRESH_MS = 8000;
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (A.userStopped) return;                          // user halted → never relaunch
    if (isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn → skip historical DOM
    const item = lastAssistant();
    if (!item || item.dataset.zloop) return;
    if (turnHalted(item)) return;                       // this turn was stopped → leave it
    const txt = itemText(item);
    if (!hasToolSignature(txt)) return;
    // Resume only when a COMPLETE, parseable command is present - not a half-streamed
    // one - and re-attempt if the turn has GROWN since our last try.
    if (!parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    diag("autoResume", { len });
    agentLoop(assistantCount() - 1);
  }, 1000);

  log("ZeroScript content script ready (DeepSeek detection)");
})();
