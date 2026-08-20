// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses ZeroScript commands (ZSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = P.timings;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[zeroscript]", ...a);

  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[zs-diag]") or window.__zsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    const snap = { ...P.snapshot(), gen: P.isGenerating(), run: A.running };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }
  P.init({ diag });

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  // Ko-fi tip link.
  const KOFI_URL = "https://ko-fi.com/sebattfg";
  // GitHub releases page - where users download the Bridge + start.bat.
  const GITHUB_URL = "https://github.com/sebattfg/ZeroScript-Free";
  // Shown in the panel instead of a static "Free" label, so a user's screenshot
  // alone tells us which build they're on for debugging. Pulled from
  // manifest.json (single source of truth) rather than duplicated here.
  const EXT_VERSION = chrome.runtime.getManifest().version;
  // YouTube tutorial - how to set up the Bridge.
  const VIDEO_URL = "https://youtu.be/kPKiZLZ9_Ps";
  // Work.ink locked link - free "watch an ad" support option. Set once the
  // locker is created at https://work.ink; the button is hidden until then.
  const WORKINK_URL = "https://work.ink/2JXi/zeroscript-free-roblox-ai-coding-tool";
  // Roblox "tip" Game Passes - the native currency for the audience.
  const ROBUX_PASSES = [
    { robux: 30, id: 1865342947 },
    { robux: 100, id: 1866782815 },
    { robux: 300, id: 1869176990 },
    { robux: 1000, id: 1865192973 },
  ];
  const passUrl = (id) => `https://www.roblox.com/game-pass/${id}`;
  // AI chat sites ZeroScript works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const AI_SITES = [
    { name: "DeepSeek", url: "https://chat.deepseek.com/" },
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.ai/" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/text/direct" },
    { name: "Meta AI", url: "https://www.meta.ai/" },
  ];

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see sinceLastSys / sysResendDue).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN Roblox vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
    // Timestamp of the last successful tool-catalogue refresh (see ensureTools).
    toolsAt: 0,
  };

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // Park until the AI tab is the FOREGROUND tab of its window again (or the user
  // halts). Deliberately has NO time cap: a tab minimized/backgrounded for an
  // hour must resume cleanly, not silently time out into a "could not send /
  // not run" failure. (A plain waitFor with a finite timeout returned false on a
  // long minimize, which broke the send loop and ended the agent loop.) Returns
  // false ONLY if the user stopped while we were parked, so callers can break.
  // EVENT-DRIVEN, not polled. A chained setTimeout loop is subject to Chrome's
  // "intensive throttling": once a tab has been hidden >5 min, chained timers are
  // clamped to ONE tick per minute, so a sleep(300) poll could take up to a full
  // minute to notice the tab came back - the user sees the bar sit on "Paused"
  // long after they returned. visibilitychange fires immediately on unhide, so we
  // race it against a slow stop-poll (the stop path is not latency-critical).
  async function waitVisible() {
    if (!document.hidden || A.stop) return !A.stop;
    A.parked = true;
    try { ui.setStarting(); } catch {}
    try {
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = () => { if (!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        // Safety net only: covers a stop click while parked, and the (unlikely)
        // case of a missed visibilitychange event.
        const iv = setInterval(() => { if (A.stop || !document.hidden) done(); }, 1000);
      });
    } finally {
      A.parked = false;
      try { ui.setStarting(); } catch {}
    }
    return !A.stop;
  }

  // Park while the tab is hidden and report how long we were parked, so callers
  // can slide their timers forward by that amount. Without this, every deadline
  // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
  // ticking while nothing can be read - which is what turned "user switched to
  // Studio for 5 minutes" into "No response from <site>, the loop has stopped"
  // and left the pending command showing a grey "not run".
  async function parkHidden() {
    if (!document.hidden || A.stop) return 0;
    const t0 = Date.now();
    await waitVisible();
    const parked = Date.now() - t0;
    diag("park.resumed", { parkedMs: parked });
    // Give the site a beat to repaint: a tab that was hidden has no layout, so
    // the first reads after unhide can come back stale/blank.
    if (!A.stop) await sleep(400);
    return parked;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
  }

  async function submitAndGetBase(text, images) {
    captureSendToken();
    diag("send", { text: String(text).slice(0, 60), busy: P.isBusyNow() });
    A.injecting = true;
    ui.inputCover(true);
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      const _settleItem = P.lastAssistant();
      const _settleLen0 = _settleItem ? P.streamLen(_settleItem) : 0;
      await sleep(200);
      if (_settleItem && _settleItem === P.lastAssistant() &&
          P.streamLen(_settleItem) > _settleLen0) {
        await waitFor(() => !P.isGenerating(), 4000);
      }
      const base = P.assistantCount();
      const preUser = P.userCount();
      // Arm the optimistic pre-hide for the result turn we're about to inject:
      // the very next NEW user turn is ours, so preHideWholeItems can mask it on
      // creation instead of waiting for its "Output of '…'" caption to render
      // (which lands a tick after the node - especially with an attached image -
      // and would otherwise flash the raw output for the 200/700ms until a sweep
      // nudge catches it). See preHideWholeItems.
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      // "Landed" = a new turn appeared in the DOM. In long chats, list
      // virtualisation can keep counts flat even when our message landed - the
      // textarea-cleared signal below is the primary fast gate.
      const landed = () => P.userCount() > preUser || P.assistantCount() > base;
      // CRITICAL: never type/send while the tab is HIDDEN. Background tabs throttle
      // rendering, which made the landed-check unreliable and caused the SAME
      // feedback to be sent several times. Send ONLY while visible.
      let tries = 0;
      let messageSent = false;
      while (!messageSent && !landed() && tries < 4 && !A.stop) {
        if (document.hidden) {
          diag("send.waitVisible", { tries });
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
        }
        await jitterBeforeSend();
        diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
        await P.typeAndSend(text, images);
        // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
        // was just clicked, so our result turn is about to render). The initial
        // arm above can EXPIRE during an image upload - typeAndSend blocks ~3-6s
        // uploading the capture before the turn appears, past the 2.5s window - so
        // without this re-arm the raw "Output of…" + a still-loading (0-byte)
        // thumbnail flash for image feedbacks until a sweep chip lands. Safe: the
        // input is covered and the loop owns this send, so no user turn can slip
        // into the window, and the pre-hide is one-shot (consumes the first turn).
        A.injectHideUntil = Date.now() + 2500;
        // The site clears the textarea as soon as the send is accepted - faster
        // and more reliable than waiting for a DOM turn count change.
        await waitFor(() => {
          if (P.editorText().trim() === "") messageSent = true;
          return messageSent || landed();
        }, 3500);
        tries++;
      }
      if (messageSent) diag("send.cleared", { tries });
      // All retries exhausted with NO evidence the message landed (textarea never
      // cleared, no new turn). Silently returning here left the loop waiting for
      // a reply that will never come (~60s "empty" timeout) with zero explanation
      // - the reported "the tool result just never gets injected" symptom. Tell
      // the user what actually happened so they can nudge the conversation
      // themselves instead of watching a stuck bar.
      if (!messageSent && !landed() && !A.stop) {
        diag("send.failed", { tries });
        ui.banner("warn", "Message could not be sent",
          `${P.displayName} did not accept the injected message after ${tries} attempts. ` +
          `Send a short message yourself (e.g. "continue") to resume the agent.`);
      }
      return base;
    } finally {
      // During Starting Up / the agent loop, the bootstrap or loop owns the cover
      // for the whole phase, so don't lift it here between an injection and the
      // next waitForResponse - it stays up until the loop / bootstrap ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
    // long with NO streaming AND no text change. lastActiveAt is refreshed every
    // tick the model is generating or the reply text grows, so an arbitrarily
    // LONG but still-active response never trips it (the old total-elapsed cap
    // wrongly fired "No response" while the model was still writing past 300s).
    const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
    let lastActiveAt = Date.now();
    const STABLE_MS = T.STABLE_MS; // generating-flag stuck ON but text frozen → done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
    // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
    // genOffFirstAt: the FIRST moment gen went false after streaming began (does
    // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
    // flipped back true after having been false - a high count means post-stop DOM
    // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
    // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
    // gen was (re)true. These pinpoint which gate causes any tail latency.
    let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
    let waitedBlock = 0, waitedFlicker = 0;
    const finalizeDiag = (kind) => {
      const now = Date.now();
      diag("stopGoneToResp", {
        kind,
        stopGoneToRespMs: genOffFirstAt ? now - genOffFirstAt : null,
        genStableForMs: genFalseSince ? now - genFalseSince : null,
        lastChangeAgoMs: now - lastChangeAt,
        genFlickers, waitedBlock, waitedFlicker,
        totalMs: now - t0,
      });
    };
    let preStartSilent = 0; // nothing produced AND not generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
    // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
    // subtree (React/Monaco churn) and a read can come back "" for a frame at
    // the exact moment the watcher finalizes - the turn then ended as
    // kind:"empty" even though a (possibly cut-off) command was sitting there a
    // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
    // autoResume dedupe (zResume) blocks any later retry (validated live on a
    // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
    // declaring empty. Reset whenever the turn NODE changes so a new turn can
    // never inherit the previous turn's text.
    let lastGoodReply = "";
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    let unsettledSince = 0; // command-shaped reply whose read is not yet stable
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Upper bound on holding off a parse verdict while a provider reports its
    // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
    // read still resolves after this and is parsed as-is.
    const UNSETTLED_GRACE_MS = 8000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached.
    const GEN_STOP_GRACE_MS = 2500;

    while (Date.now() - lastActiveAt < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      // NEVER let a deadline expire while the tab is in the background. A hidden
      // tab has no layout (innerText reads come back "", getBoundingClientRect is
      // 0x0) and Chrome throttles its timers, so every read here is unreliable -
      // and the site may legitimately keep streaming for as long as the user is
      // away in Studio. Park until the tab is foreground again, then slide EVERY
      // deadline forward by the time we were parked so nothing that was mid-flight
      // when the user switched away expires the moment they come back. This is the
      // fix for "I switched to Studio, came back and the command says 'not run'":
      // the loop used to burn its 5-minute inactivity budget off-screen, end with
      // "No response from <site>", and orphan the pending command.
      if (document.hidden && !A.stop) {
        const parked = await parkHidden();
        if (A.stop) return { kind: "stopped" };
        if (parked) {
          lastActiveAt += parked; lastChangeAt += parked;
          if (doneSince) doneSince += parked;
          if (genFalseSince) genFalseSince += parked;
          if (preStartSilent) preStartSilent += parked;
          if (warmSince) warmSince += parked;
          if (reasonSince) reasonSince += parked;
          if (noTurnSince) noTurnSince += parked;
          if (unsettledSince) unsettledSince += parked;
          if (genOffFirstAt) genOffFirstAt += parked;
        }
        continue; // re-read everything now that the tab has layout again
      }
      const gen = P.isGenerating();
      if (gen) lastActiveAt = Date.now(); // actively generating ⇒ never time out
      const d = P.readAssistant();
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // a provider's list virtualisation can keep assistantCount() <= base for a
      // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
      // A NULL token means the provider could not read an identity for the
      // CURRENT last turn (not that the provider lacks ids - that's undefined).
      // Treating null as "no new reply" wedged the watcher on Qwen: a
      // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
      // carry, so curTok stayed null, `started` never latched, and the loop
      // sat in the pre-start branch for the full 60s before ending "empty" -
      // the regenerated command (complete in the net tap) was never run and
      // zResume then blocked any retry (validated live via empty.why, 2026-07).
      // Fall back to the count test instead, exactly as for a provider with no
      // lastAssistantId at all.
      const newReply = (curTok !== undefined && curTok !== null)
        ? (curTok !== A.sendToken)
        : P.assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;
      if (d.reply && d.reply.length) lastGoodReply = d.reply;

      if (!started) {
        // CRITICAL: a bare count increase is NOT enough - the empty turn
        // CONTAINER can appear seconds before the first token. Require actual
        // CONTENT (or the generating flag).
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        if (gen || (newReply && hasText)) { started = true; }
        else {
          // The site can be slow to even CREATE the reply turn. Keep waiting -
          // only give up after a long fully-silent window.
          if (!preStartSilent) preStartSilent = Date.now();
          // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
          // on Qwen kept ending "empty" with a complete command in the net tap,
          // and without the branch name the cause was unfindable from the log.
          if (Date.now() - preStartSilent > 60000) { diag("empty.why", { branch: "preStart", rep: (d.reply||"").length }); return { kind: "empty" }; }
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag). Compare the
      // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
      // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
      // copy-bar text churn - don't count as real "changes" and keep resetting
      // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
      // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
      // reduce false changes, so short replies / other providers are unaffected.
      const replyNorm = (d.reply || "").replace(/\s+/g, " ").trim();
      if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); lastActiveAt = Date.now(); }
      // How long the generating flag has been OFF. A mid-stream flicker resets
      // this the instant growth resumes and gen flips back on.
      if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
      // DIAG: first gen-off, and count flickers back to true after a gen-off.
      if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if (prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = P.scanError();
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) so we never parse/finalize half a command.
      const blockActive = ZSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
      // ...but once generation has clearly stopped (stop indicator gone past the
      // grace window), stop honoring an "open block" - it is DOM churn, not live
      // streaming. Lets a finished big block finalise in seconds instead of
      // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
      // live on Gemini after a mid-write halt) but the text has been frozen for
      // a while → stop waiting and finalize. This must BYPASS the gen branch
      // below entirely: falling through while gen stays true used to reset
      // doneSince every iteration, so the watcher never finalized at all.
      // ...but NEVER treat a still-OPEN command block as "done" while the site is
      // genuinely still generating. A model writing a big command (a 3799-char
      // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
      // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
      // here parsed the half-written JSON and stamped a false "bad JSON" error
      // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
      const stuckDone = started && d.reply && Date.now() - lastChangeAt > STABLE_MS &&
        !(gen && ZSParse.hasOpenToolBlock(d.reply));
      if ((gen || effectiveBlock) && !stuckDone) {
        // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
        // so any wait here is tail latency: either gen flickered back on, or an
        // (effective) open-block reading is holding us.
        if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
        doneSince = 0;
        await sleep(160);
        continue;
      }
      if (stuckDone && gen) log("generating flag stuck - falling back to text stability");

      // On providers whose turn counts are RELIABLE (semantic elements, no
      // list virtualisation - Gemini), never finalize before the reply turn
      // for THIS send exists. The generating flag can flicker off in the gap
      // between the send and the new <model-response> node spawning, and the
      // watcher used to finalize on the PREVIOUS turn's stable text - a
      // premature loop.end rescued only by autoResume 30-45s later (diag
      // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
      // Bounded so a genuinely dead send still ends the turn.
      if (P.reliableCounts && !newReply) {
        if (!noTurnSince) noTurnSince = Date.now();
        // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
        // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
        // that decide it so we can see whether curTok is null (id missing on the new
        // turn -> count fallback) or equal to sendToken (last turn not advancing).
        const _waited = Date.now() - noTurnSince;
        if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
          A._noTurnLoggedAt = Date.now();
          diag("noTurnGrace.wait", {
            waitedMs: _waited,
            curTok: (P.lastAssistantId ? P.lastAssistantId() : undefined),
            sendToken: A.sendToken,
            assistantCount: P.assistantCount ? P.assistantCount() : undefined,
            base, gen, started, replyLen: (d.reply || "").length });
        }
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
      } else {
        noTurnSince = 0;
        A._noTurnLoggedAt = 0;
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 500) {  // 500ms settle – DOM is stable
        await sleep(120);
        continue;
      }

      // A turn that has produced NOTHING yet is still warming up - never
      // finalize it as empty/truncated/text (a premature retry interrupts it).
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
        diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize - wait for the reply, bounded. A manually-stopped turn is
      // exempt so a real stop still ends.
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !P.turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      // Blank-read guard: if THIS read came back empty but the same turn had
      // real text a tick ago, classify that text - see lastGoodReply above.
      let r = d.reply;
      if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      // Hold off on any "unparseable command" verdict while the provider reports
      // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
      // case: its network tap flips `done` the instant the SSE ends, but the
      // candidate-1 DOM we parse can still be mid-render, so a real command looks
      // half-written for a beat. Firing parse_error there sends an ERROR
      // mid-generation and nags a model that did nothing wrong. Only guard when
      // the reply already LOOKS like a command (so a plain-text answer is never
      // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
      // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
      const cmdShaped = P.replyUnsettled && (
        ZSParse.hasToolSignature(r) ||
        (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if (cmdShaped && P.replyUnsettled(d.item)) {
        if (!unsettledSince) unsettledSince = Date.now();
        if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(250); continue; }
      } else {
        unsettledSince = 0;
      }
      // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
      // composer from the DOM (validated live: getEditor() is null), so we can't
      // send the tool result until a candidate is picked - and the read reply is a
      // partial candidate, so a command there looks "cut off". Per the product rule
      // we use the FIRST candidate: wait for BOTH candidates to finish generating
      // (you can't select mid-stream), then auto-select Response 1. That collapses
      // the carousel to a normal turn - composer returns - and the normal parse/run
      // path below handles it. Never a parse_error here (the model didn't truncate).
      // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
      // stuck carousel, so this cannot hang.
      if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
        if (P.isGenerating()) { await sleep(250); continue; }   // both still writing
        if (P.resolveComparison && P.resolveComparison()) {
          diag("carousel.resolved");
          await sleep(400); continue;                            // let it collapse, re-read
        }
        await sleep(250); continue;                              // button not ready yet
      }
      if (ZSParse.hasToolSignature(r)) {
        const calls = ZSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present.
        if (r.includes(ZSParse.START_M) || ZSParse.LUA_START_RE.test(r)) return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        // ...unless ONLY the trailing closers were lost (the model hit its
        // output limit with the payload complete - seen live on Qwen: a big
        // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
        // and runs it instead of burning a whole retry turn; it refuses any
        // cut that amputated real content (mid-string / deep deficit), which
        // still falls through to the parse_error feedback. Safe to run here:
        // generation has ended (the open-block branch above kept waiting
        // while it streamed).
        if (ZSParse.hasOpenToolBlock(r)) {
          const saved = ZSParse.salvageCutOff(r);
          if (saved) {
            diag("tool.salvaged", { name: saved.tool });
            finalizeDiag("tool");
            return { kind: "tool", calls: [saved], item: d.item };
          }
          return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
        }
        // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
        // to parse - typically an unescaped " inside a code/string param broke the
        // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
        // mid-code). Unlike execute_luau there is NO ###LUA### fallback, so the
        // command silently dropped and the loop finalized the turn as a plain-text
        // answer with no result and no error - a dead turn. Fire a parse_error so
        // the model can fix its JSON. GATED on a known command name so prose that
        // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
        // placeholder like "command_name") is NOT misread as a broken command and
        // looped on - only a real tool name means a genuine failed call.
        const nm = ZSParse.toolNameFromText(r);
        if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
      }
      // Malformed execute_luau: the model wrote the ###END_LUA### closer but
      // FORGOT the ###LUA### opener, so hasToolSignature missed it and the block
      // never ran (seen on Gemini). Don't silently treat it as a final answer -
      // nudge a rewrite instead of leaving the user stuck on a dead turn.
      if (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r) && !r.includes(ZSParse.START_M)) {
        return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
      }
      // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
      // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
      // the required {"command":...,"params":...} envelope - it treated the tool as a
      // real callable function (seen on Gemini). Those argument keys never appear in a
      // normal prose answer, so nudge a rewrite rather than ending the turn silently.
      if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r)) {
        return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
      }
      // Malformed command, function-calling flavour: the model named a REAL tool
      // but under the WRONG KEY - {"toolName": "get_studio_state", "studio_id": …}
      // instead of {"command": …, "params": {…}}. It reads as a deliberate call,
      // yet hasToolSignature never fires (no "command" key, no markers) and the
      // argument keys are the tool's own, so neither guard above catches it: the
      // turn finalized as a plain-text answer and the loop ENDED with the user
      // watching a dead agent (seen live on ChatGPT, long session, 2026-08).
      // GATED on the value being a tool we actually have - same reasoning as the
      // toolNameFromText gate above, so prose that merely mentions a tool name in
      // some JSON example is never looped on.
      const wrongKey = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/.exec(r);
      if (wrongKey && !/"command"\s*:/.test(r)) {
        const wk = wrongKey[1];
        const hit = knownTool(wk);
        // Log the miss too: the gate depends on how the bridge ADVERTISES names
        // (they can be prefixed per server on a collision), so a silent no-match
        // is exactly the case that is impossible to diagnose after the fact.
        diag("cmd.wrongKey", { name: wk, known: hit, catalogue: A.toolNames.size });
        if (hit) return { kind: "parse_error", reason: "toolKey", raw: r, item: d.item };
      }
      // NOTE: a site "server busy / something went wrong" notice is deliberately
      // NOT special-cased. It falls through to kind:"text" below and simply ENDS
      // the loop as a final answer - no auto-retry. Retrying risked an infinite
      // re-answer loop when the model's OWN prose said "try again", and treating
      // busy as a normal terminal turn is cleaner: the user just re-sends if the
      // site actually hiccuped. (P.isBusyMsg stays on the provider interface,
      // unused by the core, in case a future flow wants it.)
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") { diag("empty.why", { branch: "finalBlank" }); return { kind: "empty" }; }
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local ZeroScript bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = (m) =>
    /Extension context invalidated|Receiving end does not exist|message port closed/i.test(m || "");

  function bg(msg) {
    return new Promise((resolve) => {
      const fail = (m) => resolve({
        ok: false,
        kind: isContextInvalidated(m) ? "stale-extension" : "disconnected",
        error: m,
      });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (e) {
        fail(String(e && e.message || e));
      }
    });
  }

  // 'subagent' is always blocked (long-running, hangs the loop). 'screen_capture'
  // is only blocked on providers whose underlying model can't see images
  // (P.supportsVision === false) - see providers/*.js for the per-site flag.
  // Both are filtered out of the advertised command list AND refused in runTool.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  const ALWAYS_BLOCKED_TOOLS = new Set(["subagent"]);
  const VISION_TOOLS = new Set(["screen_capture"]);
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  // Is `name` a tool we actually have? The bridge ADVERTISES names that may carry
  // a per-server prefix when two MCP servers expose the same tool (see
  // list_tools in bridge.py), while the model always writes the bare name - so a
  // plain `A.toolNames.has(bare)` misses, and so does bareToolName(bare), which
  // cannot re-add a prefix it never had. Compare bare-to-bare in BOTH directions.
  const bareKey = (n) => String(n || "").split("/").pop().split(".").pop();
  function knownTool(name) {
    if (!name || !A.toolNames.size) return false;
    if (A.toolNames.has(name) || A.toolNames.has(bareToolName(name))) return true;
    const b = bareKey(name);
    for (const t of A.toolNames) if (bareKey(t) === b) return true;
    return false;
  }
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    if (VISION_TOOLS.has(bare) && !P.supportsVision) return true;
    return false;
  };

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known Roblox vision tool (screen_capture) is themed "screen" by name via
  // ZS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ zsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("zsImageTools", (r) => {
      if (r && Array.isArray(r.zsImageTools)) for (const n of r.zsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // How long a fetched catalogue stays good enough to reuse without a round trip.
  const TOOLS_TTL_MS = 30000;

  // Refresh the tool catalogue - but never pay for it twice in a row.
  //
  // DEGRADED MODE (Roblox Studio closed, running on an addon server like Blender)
  // is where this used to hurt: a list_tools whose Roblox half is dead blocks the
  // bridge until it gives up, and the extension waited the FULL background timeout
  // for it. The boot sequence calls this three times in a row - startSession(),
  // then the model's list_commands, then list_mcp_servers - so the user watched
  // ~a minute of dead air with the model's reply already finished on screen
  // ("the first commands take forever even though the model clearly stopped
  // writing"). A short TTL collapses those three calls into one, and the caller
  // keeps the catalogue it already has instead of stalling for a fresh one.
  async function ensureTools(force) {
    if (!force && A.toolList.length && Date.now() - A.toolsAt < TOOLS_TTL_MS) {
      diag("tools.cached", { age: Date.now() - A.toolsAt, n: A.toolList.length });
      return A.toolList;
    }
    const t0 = Date.now();
    const r = await bg({ type: "list_tools" });
    diag("tools.fetched", { ms: Date.now() - t0, n: (r && r.tools && r.tools.length) || 0 });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools.filter((t) => !isBlockedTool(t.name));
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
      A.toolsAt = Date.now();
    }
    return A.toolList;
  }

  async function runTool(call) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return ZS.FEEDBACK.parseError("malformed");
    // NEVER execute while the AI tab is backgrounded/minimized. This is the single
    // choke point for ALL execution (agentLoop's tool dispatch AND the bootstrap's
    // list_commands), so it closes the hole the loop-entry gate alone left open:
    // the tab is foreground when a cycle starts, the model then generates for
    // 30-120s, the user minimizes MID-generation, and waitForResponse returns a
    // tool call that fired into Studio off-screen (observed live: GLM minimized
    // still ran execute_luau). Parking here (no time cap) means the call runs the
    // moment the tab is foreground again, instead of being lost or run blind.
    if (document.hidden && !A.stop) {
      diag("tool.waitVisible", { name });
      // Only reachable via a user Stop while parked; agentLoop's post-runTool
      // A.stop check breaks the loop and discards this, so it just needs to be
      // a non-crashing, clearly-labelled string.
      if (!(await waitVisible()) || A.stop) return "ERROR: the command was not run - stopped by the user.";
    }
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (VISION_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    // Virtual command: list the MCP server(s) ZeroScript is currently connected
    // to, with each one's REAL per-server health (from the bridge, never the
    // merged tool count - a dead server must not borrow another's numbers).
    if (name === "list_mcp_servers") {
      await ensureTools();
      const servers = (A.bridge && A.bridge.servers) || [];
      const lines = servers.length
        ? servers.map((sv) => {
            const label = sv.id === "roblox" ? "Roblox Studio (primary)" : `${sv.id} (addon)`;
            return `- ${sv.id}: ${label} - ${sv.alive ? `${sv.tools || 0} commands available` : "offline (no tools)"}`;
          })
        : ["- roblox: Roblox Studio (primary) - unknown (bridge did not report server health)"];
      return (
        `Output of 'list_mcp_servers':\n` +
        `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
        `Use list_commands with a "server" param (one of the ids above) to see that server's exact commands. Without "server", list_commands defaults to "roblox".`
      );
    }
    // Virtual command: list available commands with full details. Defaults to
    // the primary Roblox server - a DIFFERENT server's tools only ever show up
    // if the model explicitly asks via {"server": "<id>"} (see list_mcp_servers).
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      const requested = (args.server || "roblox").trim();
      // The MCP proxy keeps advertising Roblox's catalogue even with no Studio
      // attached, so list_commands would hand back the full command list and read
      // as "Roblox is fine" - then every command silently fails. When Roblox is
      // actually unusable, short-circuit the DEFAULT (roblox) listing into a plain
      // "Roblox is down" note that points the model at the other server(s), so it
      // can keep working in degraded mode instead of firing dead Roblox commands.
      if (requested === "roblox") {
        const s = A.bridge || {};
        const srv = s.servers || [];
        const rbx = srv.find((x) => x.id === "roblox");
        const rbxAlive = rbx ? !!rbx.alive : (!!s.mcpAlive || srv.some((x) => x.alive));
        const rbxUsable = !!s.connected && rbxAlive && s.studio !== false;
        if (!rbxUsable) {
          const others = srv.filter((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
          const otherStr = others.length
            ? `Other connected MCP server(s): ${others.map((x) => x.id).join(", ")}. Call list_mcp_servers, then list_commands with a "server" param to use them for anything that does not need Roblox.`
            : `No other MCP server is connected right now.`;
          return `Output of '${name}':\nRoblox Studio is currently OFFLINE (closed, no place open, or its MCP server disabled), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to open their place in Roblox Studio and enable its MCP server. ${otherStr}`;
        }
      }
      const known = new Set(A.toolList.map((t) => t.server).filter(Boolean));
      // Tools from a bridge that doesn't tag "server" yet (old version) have no
      // .server field at all - treat those as the primary server rather than
      // hiding everything.
      const scoped = A.toolList.filter((t) => (t.server || "roblox") === requested);
      if (!A.toolList.length) return `Output of '${name}':\nNo commands available - the bridge or Roblox Studio may be offline.`;
      if (!scoped.length) {
        return `Output of '${name}':\nERROR: no server named "${requested}" is connected. Connected servers: ${[...known].join(", ") || "roblox"}. Call list_mcp_servers to check.`;
      }
      const lines = scoped.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        // Two buckets: simple scalar params get packed onto ONE compact line;
        // params that need real explanation (array-of-object shape, or a long
        // description) keep their own line so nothing structurally important
        // gets flattened away (that per-item shape is what fixed "Unknown …
        // action: nil" bugs on user_keyboard_input/user_mouse_input).
        const compact = [];
        const detailed = [];
        for (const [k, v] of Object.entries(props)) {
          const items = v.items && typeof v.items === "object" ? v.items : null;
          const itemProps = items && items.properties;
          const mark = req.has(k) ? "" : "?";
          if (v.type === "array" && itemProps) {
            const itemReq = new Set(items.required || []);
            const fields = Object.entries(itemProps).map(([ik, iv]) => {
              const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ? `(${iv.enum.join("|")})` : (iv.type || "any");
              return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
            });
            detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ? " - " + v.description : ""}`);
          } else if (v.description && v.description.length > 45) {
            detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
          } else {
            const ty = Array.isArray(v.enum) && v.enum.length <= 8 ? `(${v.enum.join("|")})` : (v.type || "any");
            compact.push(`${k}${mark}:${ty}${v.description ? ` "${v.description}"` : ""}`);
          }
        }
        const paramLines = [compact.length ? `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
        // Tested usage note for the error-prone commands - kept full-length
        // (these are validated fixes for real bugs, not filler).
        const note = ZS.TOOL_NOTES[bareToolName(t.name)];
        const noteStr = note ? `\n    ⚠ ${note}` : "";
        return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ? "\n" + paramLines : ""}${noteStr}`;
      });
      return `Output of '${name}':\n${requested} commands (${scoped.length}):\n\n${lines.join("\n\n")}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name)) {
      return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    // The player-input tools only run against the Client datamodel (play mode) and
    // "Client" is the sole allowed value, so default it when the model omits it -
    // it can only be right. (It still needs the game RUNNING; that's documented.)
    if ((bareName === "user_keyboard_input" || bareName === "user_mouse_input") && !args.datamodel_type)
      args.datamodel_type = "Client";
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers, the loop
    // gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    // Stop watcher: a blocking tool (e.g. wait_job_finished) would otherwise keep
    // the loop awaiting the bridge for up to minutes, leaving the input locked and
    // the Stop button stuck. When the user halts (A.stop), abandon the wait within
    // ~150ms so the loop breaks and its finally unlocks everything. The in-flight
    // bridge call may still finish in the background; its result is just ignored.
    let stopTimer;
    const stopWatch = new Promise((res) => {
      stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
    });
    let r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout }), hardCap, stopWatch]);
    clearInterval(stopTimer);
    if (r && r.kind === "stopped") return "(stopped by user)";
    if (!r) return ZS.FEEDBACK.bridgeOffline;
    // The MCP server answers SUCCESSFULLY (ok:true) when no Studio is attached
    // (Studio closed / no place / MCP option disabled) - with an explanatory
    // text instead of a result. Surface it as a proper environment ERROR so the
    // model stops and tells the user, instead of treating it as tool output.
    if (r.ok && /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(r.text || "")) {
      ui.banner("warn", "Roblox Studio is not connected",
        "Open your place in Roblox Studio and enable the MCP server (Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server), then try again.");
      return ZS.FEEDBACK.studioOffline;
    }
    // The Roblox MCP reports missing/invalid required parameters as a SUCCESS
    // whose text is just the complaint (e.g. "datamodel_type is required").
    // Re-shape those into a real ERROR so the model corrects the call instead
    // of misreading it as tool output.
    if (r.ok && r.text && /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i.test(r.text.trim())) {
      return `ERROR calling '${name}': ${r.text.trim()}.\nA required or invalid parameter - check the command's parameters with list_commands, fix the call and retry.`;
    }
    // The Roblox MCP also reports Luau PARSE/RUNTIME errors as a SUCCESS whose
    // text is the executor's own stack trace ("…ExecuteLuauTool:139: …
    // CommandExecution:54: <real error>" - validated live). Genuine script
    // output never contains those internal paths. Re-shape into a real ERROR so
    // the model gets the fix-it hints below and the chip settles red, not ✓
    // green - and strip the internal frames so only the useful part remains.
    if (r.ok && bareName === "execute_luau" && r.text &&
        /\b(?:ExecuteLuauTool|CommandExecution):\d+:/.test(r.text)) {
      r = { ok: false, error: r.text.replace(/^(?:\S*(?:ExecuteLuauTool|CommandExecution):\d+:\s*)+/, "").trim() || r.text };
    }
    if (r.ok) {
      if (r.images && r.images.length && !P.supportsVision) {
        // Any tool from ANY connected server can turn out to return images -
        // we don't try to predict this from its name in advance. This is the
        // generic catch: whatever just ran, if it handed back images and this
        // provider's model can't see them, refuse cleanly instead of silently
        // attaching a file it will never actually process.
        return `ERROR: '${bareName}' returned an image, but this assistant cannot see images. Do NOT call it again. Use a different command to get the information as text instead.`;
      }
      if (r.images && r.images.length) {
        // Show the capture in a left-hand ZeroScript popup (from the in-memory
        // base64 - simple and reliable on every site; no DOM-embedded preview).
        ui.showImages(r.images, name);
        // Do NOT attach the image here: submitAndGetBase/typeAndSend types the
        // feedback text into the editor LATER, and on providers whose editor is
        // rebuilt via select-all + insertText (e.g. Gemini's setEditorText),
        // that wipe severs the site's internal binding between "pending upload"
        // and "message being composed" - the file then sits in the composer
        // forever while only the text goes out (validated live: Gemini kept
        // the file attached+unsent across the whole turn). Stash the images and
        // let the provider attach them as the LAST step, right before the send
        // click, so nothing mutates the editor afterward.
        A.pendingImages = r.images;
        diag("images.stashed", { count: r.images.length });
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
      }
      const text = r.text && r.text.length ? r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    // Orphaned content script - a page reload is the only cure, so say exactly
    // that instead of blaming the bridge (see bg / isContextInvalidated).
    if (r.kind === "stale-extension") {
      ui.banner("warn", "Reload this page",
        "ZeroScript was updated or reloaded while this tab was open, so this page is running an " +
        "old copy of it and commands can no longer run. Reload the page (F5) to reconnect - your " +
        "bridge and Roblox Studio are unaffected.");
      diag("bridge.staleExtension", { name, error: r.error });
      return ZS.FEEDBACK.staleExtension;
    }
    if (r.kind === "disconnected") return ZS.FEEDBACK.bridgeOffline;
    if (r.kind === "timeout") {
      return `ERROR: tool '${name}' timed out after ${name === "execute_luau" ? 20 : 120}s.\n${r.error}\nTry a shorter/simpler call or check that Roblox Studio is open and responsive.`;
    }
    if (name === "execute_luau") {
      const err = r.error || "";
      // "Failed to parse command code" is StudioMCP's GENERIC parse rejection: an
      // empty/mis-marked block is only ONE of its causes. The others are ordinary
      // Luau syntax errors and - seen live on Meta AI 2026-08-13 - code that is
      // syntactically fine but too big for the parser: a `return 1+1+1+…` chain
      // ran at ~500 terms (1006 chars) and was rejected at ~1000 (2006 chars).
      // Telling the model its block was empty when we DID send it a full code
      // string sends it to fix something that isn't broken; it retries the same
      // payload and fails again (the reported spam of parse errors). Only give the
      // marker advice when the code we actually sent really was empty.
      const luaCode = args.code || "";
      const hint = err.includes("Failed to parse command code")
        ? !luaCode.trim()
          ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
          : `Roblox refused to PARSE the code (${luaCode.length} chars sent, so it was not empty). Either the Luau syntax is invalid, or the code is too large/complex for the parser - a single huge expression or a very long script can be rejected outright. Check the syntax first; if it looks correct, split the work into several smaller calls.`
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

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Some tools answer with raw JSON on one line, and a 44-char slice of it makes
  // a chip that says nothing: list_roblox_studios read
  // `{"studios":[{"id":"8521cfad-f8d9-46f4-8cbe-2`. Summarise the SHAPE instead,
  // in the same spirit as the boot chip's "25 commands". Returns null when the
  // body isn't JSON, so plain-text outputs keep their first line unchanged.
  function jsonSummary(body) {
    if (!/^[[{]/.test(body) || body.length > 200000) return null;
    let v;
    try { v = JSON.parse(body); } catch { return null; }
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v);
    // The common MCP shape: one wrapper key holding the list. Its name is already
    // plural ("studios", "scripts"), so it reads correctly as-is - just drop the
    // trailing "s" when there is exactly one, so it says "1 studio".
    if (keys.length === 1 && Array.isArray(v[keys[0]])) {
      const n = v[keys[0]].length;
      const word = n === 1 ? keys[0].replace(/s$/, "") : keys[0];
      return `${n} ${word}`;
    }
    // Otherwise show the scalar fields - that's what a human would read off.
    const scalars = keys
      .filter((k) => v[k] === null || typeof v[k] !== "object")
      .map((k) => `${k}: ${v[k]}`);
    if (scalars.length) return scalars.join(", ").slice(0, 44);
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    // Errors are prose and read fine as-is; only reshape successful JSON.
    if (!isErr) { const j = jsonSummary(body); if (j) return j; }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
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
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0;
    const MAX_TRUNC = 6;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    const REMIND_TOOLS_EVERY = 20;
    ui.showStop(true);
    P.setInputLock(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        // Gate the WHOLE cycle on tab visibility. We only advance - read the
        // reply, PARSE it, EXECUTE a tool, inject the result - while the AI tab
        // is the FOREGROUND tab of its Edge window. document.visibilityState
        // (mirrored by document.hidden) is the right signal, NOT window focus:
        //  - Edge loses OS focus but the AI tab stays the active tab (user is
        //    working in Roblox Studio) -> still "visible" -> the agent keeps
        //    running, exactly as wanted.
        //  - The AI tab is backgrounded (another tab in front) or the window is
        //    minimized -> "hidden" -> pause here. Background tabs throttle
        //    rendering/timers, which made DOM reads unreliable (misparse,
        //    duplicate sends - see the send-side guard in submitAndGetBase).
        // Parking here means we never START a parse/exec cycle off-screen; the
        // send step re-checks too, so a switch-away mid-generation is covered.
        if (document.hidden && !A.stop) {
          diag("loop.waitVisible");
          ui.inputCover(true); // keep the "Agent is working" cover up while parked
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          diag("loop.visibleAgain");
        }
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", `${P.displayName} reached its context limit`,
            (res.detail || "") + "  -  open a new chat to start fresh.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "Conversation too long",
            `${P.displayName} reports the conversation is getting too long. Start a new session.`);
          break;
        }
        if (res.kind === "timeout") {
          ui.banner("warn", `No response from ${P.displayName}`,
            `${P.displayName} did not respond in time. The loop has stopped.`);
          break;
        }
        // A genuinely empty turn is effectively never produced (the warm-up guard
        // waits out slow starts). It DOES happen when the site drops a reply, and
        // ending the loop silently is what made this the single most confusing
        // failure: the pending command just settles to a grey "not run" with no
        // explanation anywhere. Say what happened.
        if (res.kind === "empty") {
          diag("empty.end");
          ui.banner("warn", `${P.displayName} returned an empty reply`,
            `The turn produced no text, so the agent loop stopped. Nothing was run. ` +
            `Ask ${P.displayName} to continue, or press Start again in a new chat.`);
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
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
            "The model repeatedly hit its length limit. Try a shorter request or start a new session.");
          break;
        }
        truncCount = 0;

        if (res.kind === "parse_error") {
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = ZSParse.toolNameFromText(res.raw || "") || "command";
          if (res.item) {
            const detail = res.reason === "unclosed" ? "cut off"
              : res.reason === "luaOpener" ? "missing ###LUA###"
              : res.reason === "envelope" ? "bad format"
              : "bad JSON";
            decorate.toolBox(res.item, failName, "err", detail, true, "", ZS.toolCategory(failName));
          }
          // Pass the detected command name so the feedback only offers the
          // ###LUA### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(ZS.FEEDBACK.parseError(res.reason, failName));
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
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          const category = learnedImg ? "screen" : ZS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category });

          // Park BEFORE painting the chip / stamping the clock / marking the turn
          // dispatched. runTool() gates on visibility too (it is the choke point
          // that also covers the bootstrap), but parking only there would leave
          // this block's side effects applied for the whole minimize:
          //   - the chip spins "running" while nothing actually runs, and
          //     elapsedOn(zsToolT0) counts the parked time, so a 20-min minimize
          //     renders a bogus "1200.0s" on the call;
          //   - rememberExecuted() would mark the turn dispatched before it ever
          //     ran, so a reload/close while parked loses the command for good -
          //     the auto-resume watchdog refuses to re-fire an "executed" turn.
          // Parking first keeps all of that truthful: we only commit once we are
          // foreground and about to really dispatch.
          if (document.hidden && !A.stop) {
            diag("tool.parkBeforeDispatch", { name: call.tool });
            if (!(await waitVisible()) || A.stop) break;
          }
          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool });
          const feedback = await runTool(call);
          A.toolRunning = false;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            break;
          }
          const isErr = feedbackIsError(feedback);
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ? "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (Roblox OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ? "screen" : category;
          decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
            true, outBody, resultCat);
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ? "err" : "done", detail: outSummary(feedback),
            body: outBody, category: resultCat, count: P.assistantCount(),
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ? P.lastAssistantId() : undefined,
          };

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Scope the reminder to the primary Roblox server, exactly like
              // list_commands: re-injecting EVERY connected server's tools (Blender
              // etc.) merged flat would bloat the model's context - the opposite of
              // what the model gets when it lists commands itself. Anti-drift only
              // needs the primary Roblox set; addon commands were listed on demand
              // and the bridge routes by name regardless.
              const roblox = A.toolList.filter((t) => (t.server || "roblox") === "roblox");
              toSend += ZS.toolsReminder(roblox) + "\n" + ZS.memoryNudge();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY });
            }
          }
          // This result becomes a turn, so it counts toward the re-statement
          // budget - context volume is what makes the site summarise, and the
          // volume is overwhelmingly tool results, not how often the user types.
          bumpSys("results");
          // Ride the system-prompt re-statement out on this result if one is due
          // and it fits (see withSysResend - the result itself is never trimmed).
          toSend = withSysResend(toSend);
          const images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ? images.length : 0 });
          base = await submitAndGetBase(toSend, images);
        }
      }
    } catch (e) {
      diag("loop.error", { msg: String((e && e.message) || e) });
      ui.banner("warn", "Internal loop error", String((e && e.message) || e));
    } finally {
      A.running = false;
      A.stop = false;
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", ZS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → "⏳ Stopping…", disabled
    P.stopGeneration();
    ui.toast("Stopping…");
  }

  // The full system prompt for the CURRENT provider and user settings. One
  // definition, used both by the bootstrap and by the periodic re-injection, so
  // the two can never drift apart.
  function systemPrompt() {
    return ZS.buildSystemPrompt({
      siteName: P.displayName,
      customPrompt: ui.getCustomPrompt(),
      providerNotes: P.promptExtra || "",
    });
  }

  // ── Periodic system-prompt re-injection (opt-in, per provider) ────────────
  // Some sites aggressively summarise their own context mid-conversation. When
  // that happens the model keeps the gist of the task but loses the MECHANISM:
  // it forgets that an extension reads its replies and executes them, and starts
  // answering "I can't invoke those commands in this session" while the
  // extension sits there ready and waiting. Observed repeatedly on ChatGPT.
  //
  // The periodic tools reminder does NOT fix this: it re-anchors command NAMES,
  // but it never restates that the commands actually run. So providers that need
  // it set `resendSystemEvery`, and the whole prompt goes back in.
  //
  // Delivery rides on the next injected tool result rather than costing its own
  // message - free and invisible. But that channel dries up in exactly the case
  // this exists for (a model that has forgotten it can call tools stops calling
  // them, so no results flow), so a fallback sends it as its own masked turn
  // once the window has elapsed with nothing to piggyback on.
  const RESEND_SYS_EVERY = P.resendSystemEvery || 0;
  // Injected tool results get their own, larger budget (see sysResendDue).
  const RESEND_SYS_EVERY_RESULTS = 12;

  // How much conversation has accumulated since the operating instructions were
  // last stated. PERSISTED per conversation, because both simpler designs failed
  // in opposite directions - each caught live on 2026-08-14:
  //
  //  - An in-memory counter RESETS on every page reload, while the session
  //    itself survives one (A.started is persisted). After an F5, or a silent
  //    Chrome extension auto-update, the tally restarted and the re-statement
  //    could be postponed indefinitely.
  //  - Walking the DOM back to the last SYS_MARKER turn is reload-proof but
  //    UNDER-counts badly: these sites virtualize. Measured on a real ChatGPT
  //    session that had long passed the threshold - only 12 turns were rendered,
  //    the marker was not among them (so the walk silently counted from the top
  //    of the window) and it saw 5 injected results instead of the true total.
  //
  // Counting at INJECTION time and persisting sidesteps both: it is exact, and
  // virtualization cannot erase it. The DOM walk is kept as a floor, since a
  // conversation that visibly shows the threshold is due no matter what storage
  // says (e.g. a session adopted from another device, or storage cleared).
  const sysKey = () => `zsSys:${P.conversationKey() || "new"}`;
  let sysCount = { users: 0, results: 0 };
  let sysCountKey = "";

  // Hydrate from storage. Only meaningful at startup / on a conversation switch;
  // it never overwrites counts already accumulated in this tick's memory (a
  // bump that landed while the async read was in flight must not be lost).
  async function loadSysCount() {
    const k = sysKey();
    if (k === sysCountKey) return sysCount;
    sysCountKey = k;
    const local = sysCount;
    sysCount = { users: 0, results: 0 };
    try {
      const r = await new Promise((res) => chrome.storage.local.get(k, res));
      const saved = r && r[k];
      if (saved) sysCount = {
        users: Math.max(saved.users || 0, local.users || 0),
        results: Math.max(saved.results || 0, local.results || 0),
      };
    } catch {}
    return sysCount;
  }
  function saveSysCount() {
    try { chrome.storage.local.set({ [sysCountKey]: sysCount }); } catch {}
  }
  // Increment SYNCHRONOUSLY, persist asynchronously. sysResendDue() reads
  // sysCount in the same tick as the bump that should trip it, so deferring the
  // increment into the storage promise made the tally lag a full turn behind and
  // the threshold was never seen at the moment it mattered (caught live: 12 tool
  // results, counter still reading 11, no rider). Storage is a durability
  // mechanism here, not the source of truth for the current tick.
  function bumpSys(field) {
    if (!RESEND_SYS_EVERY) return;
    if (sysCountKey !== sysKey()) { sysCountKey = sysKey(); }
    sysCount[field]++;
    saveSysCount();
  }
  function resetSysCount() {
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }

  // Lower bound read straight from what is on screen (see above).
  function sinceLastSysInDom() {
    const items = P.allItems();
    let users = 0, results = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = P.classifyText(it, ".zs-chip");
      // The bootstrap turn and every rider both carry the marker - either one
      // means the rules were fully stated here, so stop counting.
      if (txt.includes(ZS.SYS_MARKER)) break;
      if (!P.isUserItem(it)) continue;
      if (ZSParse.isInjectedFeedback(txt)) results++;
      else users++;
    }
    return { users, results };
  }

  function sinceLastSys() {
    const dom = sinceLastSysInDom();
    return {
      users: Math.max(sysCount.users, dom.users),
      results: Math.max(sysCount.results, dom.results),
    };
  }

  // A re-statement is owed once EITHER budget is spent. Two triggers because
  // they measure different things: user turns track a long back-and-forth, while
  // injected results track context VOLUME - and volume is what actually makes
  // the site summarise. Measured live on 2026-08-14: in a real session 5 of the
  // 6 "user" turns were injected tool results and only ONE was typed by Seb, so
  // a user-turn-only trigger sat at 1/6 while five full tool payloads had
  // already landed. The results budget is the one that fires in practice.
  function sysResendDue() {
    if (!RESEND_SYS_EVERY) return false;
    const { users, results } = sinceLastSys();
    const due = users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS;
    // Logged sparsely on purpose: this is consulted on EVERY tool result, and an
    // entry each time would flush the 300-slot diag ring of everything else -
    // exactly the history you need when something goes wrong. The verdict turn
    // and every 4th result is enough to reconstruct the tally.
    if (due || results % 4 === 0) {
      diag("sys.tally", {
        users, results, due,
        mem: `${sysCount.users}/${sysCount.results}`,
        need: `${RESEND_SYS_EVERY}u ${RESEND_SYS_EVERY_RESULTS}r`,
      });
    }
    return due;
  }
  // Attach the prompt to an outgoing tool result IF it fits. The result is never
  // truncated to make room: the passenger is dropped and the flag stays raised,
  // so it rides the next result instead. A tool result the model is waiting on
  // is always worth more than a reminder.
  function withSysResend(text) {
    if (!sysResendDue()) return text;
    const prompt = systemPrompt();
    const rider =
      "\n\n────────────────────────────────\n" +
      ZS.RESEND_MARKER + "\n" +
      "(System note from ZeroScript - an automatic re-statement of your operating " +
      "instructions, NOT a new request and NOT something to reply to. This conversation " +
      "may have been summarised, which drops the part explaining how you actually run " +
      "commands. To be explicit: the ZeroScript extension IS running in this page right " +
      "now, it DOES read your replies, and the commands below DO execute for real - the " +
      "results you have been receiving are proof of it. Keep using them exactly as " +
      "described. Just carry on with the task; do not acknowledge this note.)\n" +
      prompt;
    const cap = P.sendCharBudget || Infinity;
    if (text.length + rider.length > cap) {
      // Stays due - the next (smaller) result carries it.
      diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap });
      return text;
    }
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    diag("sys.resend", { via: "toolResult", chars: rider.length, ...spent });
    return text + rider;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (A.running || A.starting) return;
    // "Start session" is allowed ONLY on a blank conversation. Opening an
    // EXISTING conversation must never trigger the bootstrap.
    if (!P.chatIsEmpty() && !A.started) {
      ui.toast("Open a new, empty conversation to start a session.");
      return;
    }
    A.userStopped = false;
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ? P.lastAssistantId() : null;
    A.starting = true;
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    ui.setStarting(true);
    ui.updateStartGate(); // refresh the bar into its "starting" state
    P.setInputLock(true); // block user input during bootstrap
    ui.inputCover(true);  // cover the composer ("Working…") for the WHOLE Starting Up
    try {
      await ensureTools(true); // boot: always take a fresh catalogue (the TTL then
                               // covers the list_commands / list_mcp_servers calls
                               // the model makes seconds later)
      if (!alive()) return;
      if (!A.toolList.length) {
        ui.banner("warn", "Bridge or Studio offline",
          "Could not fetch Roblox tools. Run start.bat and make sure Roblox Studio is open, then try again.");
        return;
      }
      const modeState = await P.ensureComposerReady("startup");
      if (!alive()) return;
      if (!modeState.ready) {
        ui.banner("warn", `${P.displayName} mode not ready`,
          `Could not switch ${P.displayName} to the required mode. Start a new chat or reload the page, then try again.`);
        return;
      }
      const prompt = systemPrompt();
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        // Roblox down short-circuits list_commands into a plain "offline" note
        // (main.js, list_commands handler) instead of the real catalogue - detect
        // that and show it as such, rather than the STALE cached tool count below
        // (the bridge keeps advertising Roblox's catalogue even with no Studio
        // attached, so A.toolList still has 25+ entries that were never actually
        // usable this boot).
        if (/Roblox Studio is currently OFFLINE/.test(toolFeedback)) {
          decorate.toolBox(startRes.item, "Loading commands", "err", "Roblox offline", true);
        } else {
          // Count what the model ACTUALLY received: list_commands is scoped to the
          // primary Roblox server (main.js ~629), so showing A.toolList.length (every
          // connected server merged - Roblox + Blender + addons) overstated the boot
          // count and made it look like all servers were loaded at once. Count the
          // Roblox-scoped tools instead, matching the real result.
          const robloxCount = A.toolList.filter((t) => (t.server || "roblox") === "roblox").length;
          decorate.toolBox(startRes.item, "Loading commands", "done", `${robloxCount} commands`, true);
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2); // wait for "I'm ready" reply
        if (!alive()) return;
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
      }
      A.started = true;
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
      ui.toast(`Agent ready. Ask ${P.displayName} to build something in Roblox.`);
    } catch (e) {
      if (alive()) ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        P.setInputLock(false); // always unlock after bootstrap
        decorate.sweep();
      }
    }
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
    // Bell - the mid-session system-prompt re-statement. Deliberately NOT the
    // gear: the gear means "the agent is starting up", and a reminder is the
    // opposite (a session already long enough to need re-anchoring).
    remind:  SVG('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
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
    if (phase === "remind") return ICONS.remind;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__zsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      let chip = item.querySelector(".zs-chip");
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="zs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ? 1 : 0}|${label}|${detail}|${hasBody ? body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `zs-chip cat-${category} ${cls || ""}`;
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
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ? P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ? chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.zs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__zsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__zsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".zs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###LUA### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .zs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ? "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(ZS.RESEND_MARKER)) {
        if (item.dataset.zs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ? `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.zs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : hasImg ? "img" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: hasImg ? "screen" : m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.zsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !ZSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".zs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ? "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real ZeroScript session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasZsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = ZSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: ZSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __zsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            ZSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          ZSParse.isInjectedFeedback(P.classifyText(next, ".zs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ? "err" : (orphanPending ? "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ? "stopped" : (orphanPending ? "not run" : "");
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".zs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (ZSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: ZSParse.toolNameFromText(txt) });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with Roblox screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = ZSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".zs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ? { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".zs-chip")) {
        const tx = item.querySelector(".zs-chip-tx");
        const name = ZSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.zs || "chip-only" });
        resetDecoration(item);
      }
    },

    sweep() {
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".zs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".zs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, bar, dot, brandEl, stateEl, actionBtn, stopBtn, switchBtn, supportBtn, discordEl, menuEl, unstableEl;
    let cover, coverRaf, barRaf;
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    let bridgeOk = false, studioDown = false, placeDown = false, appDown = false, addonOk = false, studioProcUp = false;
    let wasConnected = false, bridgeBannerEl = null;

    function build() {
      root = document.createElement("div");
      root.id = "zs-root";
      // One consolidated status bar, anchored just above the site's composer
      // (positioned every frame by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites, custom prompt, support, Discord). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      root.innerHTML = `
        <div id="zs-bar">
          <span id="zs-dot" class="off" title=""></span>
          <span id="zs-brand">ZeroScript <span class="zs-free">v${EXT_VERSION}</span></span>
          <span id="zs-state"></span>
          <button id="zs-action"></button>
          <button id="zs-stop" hidden>■ Stop</button>
          <a id="zs-discord" href="https://discord.gg/D5G2HAzX8z" target="_blank" rel="noopener" title="Need help? Join our Discord"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></a>
          <button id="zs-switch" aria-label="Switch AI and options" title="Switch AI, custom prompt, support"><span id="zs-switch-name"></span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          <button id="zs-support" aria-label="Support ZeroScript" title="Support ZeroScript"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button>
        </div>
        <div id="zs-menu" hidden></div>
        ${P.unstableWarning ? `<button id="zs-unstable" aria-label="Provider may be unstable" hidden>⚠ unstable</button>` : ""}
      `;
      document.documentElement.appendChild(root);
      bar = root.querySelector("#zs-bar");
      dot = root.querySelector("#zs-dot");
      brandEl = root.querySelector("#zs-brand");
      stateEl = root.querySelector("#zs-state");
      actionBtn = root.querySelector("#zs-action");
      stopBtn = root.querySelector("#zs-stop");
      switchBtn = root.querySelector("#zs-switch");
      supportBtn = root.querySelector("#zs-support");
      discordEl = root.querySelector("#zs-discord");
      const swName = root.querySelector("#zs-switch-name");
      if (swName) swName.textContent = P.displayName || P.id;
      menuEl = root.querySelector("#zs-menu");
      bar.classList.add(`zs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`zs-site-${P.id}`);

      actionBtn.addEventListener("click", onActionClick);
      stopBtn.addEventListener("click", stopLoop);
      unstableEl = root.querySelector("#zs-unstable");
      if (unstableEl) {
        // Set the native tooltip via PROPERTY, not the HTML template: the warning
        // text may contain double quotes (e.g. GLM's "No response…"), which would
        // terminate a title="..." attribute early and truncate the tooltip.
        unstableEl.title = P.unstableWarning;
        unstableEl.addEventListener("click", (e) => { e.stopPropagation(); toast(P.unstableWarning); });
      }
      buildMenu();
      // Both bar controls open the same panel; the heart lands on the Support
      // section (last), the model button opens at the top with Switch AI.
      const toggleMenu = (toSupport) => {
        menuEl.hidden = !menuEl.hidden;
        if (!menuEl.hidden) {
          // Rebuild on every open, not just once at page load: the initial
          // buildMenu() call runs before the bridge status (server list/health)
          // has arrived, so the very first render always shows an empty/stale
          // MCP servers section otherwise - nothing ever refreshed it after.
          buildMenu();
          syncMenuPrompt();
          // On a FRESH open, menuEl has no max-height yet - that's only applied by
          // placeBar()'s positioning pass, which runs on the next rAF tick (it's a
          // separate loop, not synchronous with this click). Without it the panel
          // has no overflow yet, so scrollHeight === clientHeight and setting
          // scrollTop here is a no-op - the "jump to Support" silently failed on
          // the very first open (reported live on Arena). Deferring one frame lets
          // placeBar's already-queued tick clip the box first, so there's real
          // scroll room by the time we set scrollTop.
          requestAnimationFrame(() => {
            if (!menuEl.hidden) menuEl.scrollTop = toSupport ? menuEl.scrollHeight : 0;
          });
        }
      };
      switchBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(false); });
      supportBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(true); });
      openMenuFn = (toSupport) => { if (menuEl.hidden) toggleMenu(toSupport); };
      document.addEventListener("click", (e) => {
        if (menuEl.hidden) return;
        if (!menuEl.contains(e.target) && !switchBtn.contains(e.target) && !supportBtn.contains(e.target))
          menuEl.hidden = true;
      }, true);

      applyTheme();
      setInterval(applyTheme, 2000); // follow the host page toggling its theme
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind).
    function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start" || kind === "start-degraded") startSession();
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("zsCustomPrompt", (r) => {
        if (r && typeof r.zsCustomPrompt === "string") {
          customPrompt = r.zsCustomPrompt;
          syncMenuPrompt();
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }
    // Reflect the saved value back into the menu textarea (unless being edited).
    function syncMenuPrompt() {
      const ta = root && root.querySelector("#zs-set-text");
      if (ta && document.activeElement !== ta) ta.value = customPrompt;
    }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // User-added MCP servers shown at the very bottom of the menu. These are
    // ADDONS: the Roblox server stays primary and is never in this list. Each
    // entry is { id, name, command } - `command` is the raw string the user
    // typed (split into command+args when sent to the bridge). The bridge writes
    // them to config.json and restarts to load them; this local list only drives
    // the menu UI and is kept in sync with the bridge's server health.
    let customMcpServers = [];
    try {
      chrome.storage.local.get("zsCustomMcpServers", (r) => {
        if (r && Array.isArray(r.zsCustomMcpServers)) {
          customMcpServers = r.zsCustomMcpServers;
          if (!menuEl.hidden) buildMenu();
        }
      });
    } catch {}
    function getCustomMcpServers() { return customMcpServers; }
    function saveCustomMcpServers() {
      try { chrome.storage.local.set({ zsCustomMcpServers: customMcpServers }); } catch {}
    }
    // The bridge (config.json + live health) is the SOURCE OF TRUTH for which
    // addon servers actually exist - chrome.storage.local is just a display-name
    // cache, and the two CAN drift (e.g. storage cleared, or config.json edited
    // by hand). Rendering from the bridge's live list means an addon never
    // "disappears" from the menu while still running - and self-heals the local
    // cache the moment we see a server it didn't know about.
    function mergedMcpServers() {
      const live = ((A.bridge && A.bridge.servers) || []).filter((sv) => sv.id !== "roblox");
      const byId = new Map(customMcpServers.map((s) => [s.id, s]));
      const merged = live.map((sv) => {
        const cached = byId.get(sv.id);
        return {
          id: sv.id, name: (cached && cached.name) || sv.id, command: cached && cached.command,
          alive: sv.alive, tools: sv.tools,
        };
      });
      // Self-heal: cache didn't know about a server the bridge actually has.
      let healed = false;
      for (const sv of live) {
        if (!byId.has(sv.id)) { customMcpServers.push({ id: sv.id, name: sv.id }); healed = true; }
      }
      if (healed) saveCustomMcpServers();
      // A server we just added/removed but the bridge hasn't reported back on
      // yet (mid-restart) - still show it, health unknown, so it doesn't blink
      // out of the list during the few seconds the bridge is restarting.
      for (const s of customMcpServers) {
        if (!merged.some((m) => m.id === s.id)) merged.push({ ...s, alive: undefined, tools: undefined });
      }
      return merged;
    }
    // Derive a config-safe server id from a display name (roblox is reserved).
    function mcpSlug(name) {
      let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!s || s === "roblox") s = `addon-${s || "server"}`;
      let id = s, n = 2;
      while (customMcpServers.some((x) => x.id === id)) id = `${s}-${n++}`;
      return id;
    }
    // Split a raw "command with args" string into command + args (shell-lite:
    // whitespace-separated, honouring "double" and 'single' quotes).
    function splitCommand(raw) {
      const parts = String(raw || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const clean = parts.map((p) => p.replace(/^["']|["']$/g, ""));
      return { command: clean[0] || "", args: clean.slice(1) };
    }
    // Wait for the bridge to come back after its restart (config reload). Resolves
    // true once reconnected (optionally once `id` shows up in server health).
    async function waitForBridgeBack(id, timeoutMs = 15000) {
      const t0 = Date.now();
      // Give the bridge a moment to actually drop before we start polling, so we
      // don't instantly match the pre-restart "connected" state.
      await new Promise((r) => setTimeout(r, 1200));
      while (Date.now() - t0 < timeoutMs) {
        const s = await bg({ type: "status" });
        if (s && s.connected) {
          if (!id || (Array.isArray(s.servers) && s.servers.some((x) => x.id === id))) return true;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      return false;
    }

    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control: other AI sites, the custom
    // prompt, and support (Ko-fi + Robux). Opens above the bar.
    function buildMenu() {
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      let sites = "";
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const label = `<span class="zs-site-name"><span>${s.name}</span><span class="zs-site-host">${hostOf(s.url)}</span></span>`;
        sites += current
          ? `<div class="zs-site-opt zs-site-here">${label}<span class="zs-site-badge">active</span></div>`
          : `<button class="zs-site-opt" data-u="${s.url}">${label}<span class="zs-site-go">&rarr;</span></button>`;
      }
      let passes = "";
      for (const p of ROBUX_PASSES) {
        passes += `<button class="zs-tip-opt zs-tip-rbx" data-u="${passUrl(p.id)}"><span class="zs-rbx-cur">R$</span>${p.robux}</button>`;
      }
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const mergedServers = mergedMcpServers();
      // Roblox always heads the list - greyed out, no health dot (its own status
      // is already the main ZeroScript dot elsewhere) and no remove button (it's
      // the primary server, protected bridge-side too).
      let mcpList =
        `<div class="zs-mcp-item zs-mcp-item-primary"><div class="zs-mcp-info"><span class="zs-mcp-name">Roblox Studio</span><span class="zs-mcp-url">primary - always connected</span></div></div>`;
      mergedServers.forEach((s, i) => {
        // alive === undefined -> the bridge hasn't reported this server's health
        // yet (just added/removed, still restarting) - shown neutral, not red.
        const healthClass = s.alive === true ? "on" : s.alive === false ? "off" : "unknown";
        const healthTitle = s.alive === true ? `${s.tools || 0} tools available` : s.alive === false ? "offline" : "status unknown";
        mcpList += `<div class="zs-mcp-item"><span class="zs-mcp-health zs-mcp-health-${healthClass}" title="${healthTitle}"></span><div class="zs-mcp-info"><span class="zs-mcp-name">${esc(s.name)}</span><span class="zs-mcp-url">${esc(s.command || s.id)}</span></div><button class="zs-mcp-remove" data-id="${esc(s.id)}" title="Remove">✕</button></div>`;
      });
      menuEl.innerHTML =
        `<div class="zs-menu-head"><span class="zs-menu-logo">ZeroScript</span><span class="zs-menu-tag">v${EXT_VERSION}</span></div>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Switch AI</span></div>
           ${sites}
         </section>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Free Support</span></div>
           <button class="zs-tip-opt zs-tip-star" data-u="${GITHUB_URL}"><span>Star on GitHub</span><span class="zs-tip-sub">free, helps a lot</span></button>
           ${WORKINK_URL ? `<button class="zs-tip-opt zs-tip-ad" data-u="${WORKINK_URL}"><span>Watch an ad to support</span><span class="zs-tip-sub">free, takes a minute</span></button>` : ""}
         </section>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Support with Robux / Ko-fi</span></div>
           <button class="zs-tip-opt zs-tip-kofi" data-u="${KOFI_URL}"><span>Tip on Ko-fi</span><span class="zs-tip-sub">any amount</span></button>
           <div class="zs-tip-sep">or tip in Robux</div>
           <div class="zs-rbx-grid">${passes}</div>
         </section>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Custom prompt</span></div>
           <div class="zs-menu-note">Added below the system prompt on every new session. The built-in prompt can't be edited.</div>
           <textarea id="zs-set-text" rows="4" placeholder="e.g. Always comment your Luau code. Prefer small modular scripts."></textarea>
           <div class="zs-set-row"><button id="zs-set-save">Save</button><span id="zs-set-status"></span></div>
         </section>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>MCP servers</span></div>
           <div class="zs-menu-note">Roblox Studio is always connected (primary). Add another MCP server (e.g. Blender, Sketchfab) as an addon - the bridge restarts briefly to load it. Experimental.</div>
           ${mcpList}
           <div class="zs-mcp-sep"></div>
           <input id="zs-mcp-name" class="zs-mcp-field" placeholder="Name, e.g. Blender" />
           <input id="zs-mcp-url" class="zs-mcp-field" placeholder="Start command, e.g. npx -y @some/mcp-server" />
           <div class="zs-set-row"><button id="zs-mcp-add">Add server</button><span id="zs-mcp-status"></span></div>
         </section>`;
      const open = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} menuEl.hidden = true; };
      menuEl.querySelectorAll("button.zs-site-opt, .zs-tip-opt").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      const ta = menuEl.querySelector("#zs-set-text");
      const saveBtn = menuEl.querySelector("#zs-set-save");
      const status = menuEl.querySelector("#zs-set-status");
      ta.value = customPrompt;
      saveBtn.addEventListener("click", () => {
        customPrompt = ta.value;
        try { chrome.storage.local.set({ zsCustomPrompt: customPrompt }); } catch {}
        status.textContent = "Saved ✓";
        setTimeout(() => { status.textContent = ""; }, 1600);
      });
      const mcpNameEl = menuEl.querySelector("#zs-mcp-name");
      const mcpUrlEl = menuEl.querySelector("#zs-mcp-url");
      const mcpStatus = menuEl.querySelector("#zs-mcp-status");
      const mcpAddBtn = menuEl.querySelector("#zs-mcp-add");
      // Disable every add/remove control and show the restart spinner. Adding or
      // removing a server rewrites config.json and restarts the whole bridge, so
      // no other server edit may run until it is back.
      let mcpBusy = false;
      function setMcpBusy(on, label) {
        mcpBusy = on;
        mcpAddBtn.disabled = on;
        menuEl.querySelectorAll(".zs-mcp-remove").forEach((b) => (b.disabled = on));
        mcpStatus.innerHTML = on
          ? `<span class="zs-mcp-spin-row"><span class="zs-mcp-spin"></span>${label || "Restarting bridge…"}</span>`
          : "";
      }

      menuEl.querySelectorAll(".zs-mcp-remove").forEach((b) =>
        b.addEventListener("click", async () => {
          if (mcpBusy) return;
          const id = b.dataset.id;
          if (!id) return;
          setMcpBusy(true, "Restarting bridge…");
          const r = await bg({ type: "remove_server", server_id: id });
          if (!r || !r.ok) {
            setMcpBusy(false);
            mcpStatus.textContent = (r && r.error) || "Couldn't remove server";
            setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
            return;
          }
          customMcpServers = customMcpServers.filter((s) => s.id !== id);
          saveCustomMcpServers();
          await waitForBridgeBack(null);
          buildMenu(); // rebuilds with the spinner cleared
        }));

      mcpAddBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        const name = mcpNameEl.value.trim();
        const command = mcpUrlEl.value.trim();
        if (!name || !command) {
          mcpStatus.textContent = "Name and command required";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 1800);
          return;
        }
        const id = mcpSlug(name);
        const { command: cmd, args } = splitCommand(command);
        setMcpBusy(true, "Restarting bridge…");
        const r = await bg({ type: "add_server", server_id: id, command: cmd, args });
        if (!r || !r.ok) {
          setMcpBusy(false);
          mcpStatus.textContent = (r && r.error) || "Couldn't add server";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
          return;
        }
        customMcpServers.push({ id, name, command });
        saveCustomMcpServers();
        await waitForBridgeBack(id);
        buildMenu(); // rebuilds with the new server listed + spinner cleared
      });
    }

    // ── First-time onboarding card (bridge missing) ─────────────────────────
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
        ? `<a id="zs-setup-video" href="${VIDEO_URL}" target="_blank" rel="noopener">▶︎ Watch tutorial</a>`
        : "";
      setupCard.innerHTML =
        `<div id="zs-setup-head"><span id="zs-setup-logo">ZeroScript</span><span id="zs-setup-tag">Setup</span></div>` +
        `<div id="zs-setup-sub">The <b>Bridge</b> is what connects this chat to Roblox Studio. Three steps and you're running.</div>` +
        `<ol id="zs-setup-steps">` +
          `<li>Download the Bridge from GitHub</li>` +
          `<li>Run <code>start.bat</code></li>` +
          `<li>Back here, click <b>Start Roblox agent</b></li>` +
        `</ol>` +
        `<div class="zs-setup-copy-row">` +
          `<input type="text" id="zs-setup-link" readonly value="${GITHUB_URL}">` +
          `<button id="zs-setup-copy">Copy</button>` +
        `</div>` +
        videoBtn +
        `<button id="zs-setup-dismiss">Got it</button>`;
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

    // The onboarding card is pinned to the top-right corner (via CSS), out of the
    // way of the composer; nothing to reposition per frame.
    function placeSetup() {}

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
      // Bridge is down, but if the user is just READING an existing
      // conversation with no ZeroScript session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
    }

    // The single source of truth for the bar's content. Decides the dot tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting the Roblox agent…"
    //  • session active   → live dot, "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/Studio warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      if (!bar) return;
      // indicator = an optional leading dot/spinner; msg = the wrappable text.
      let toneClass = "standby", indicator = "", msg = "", label = "", kind = "", disabled = false, warn = false;
      // Orphaned page: check FIRST and return. Nothing below can be true any
      // more - the status poll is stopped, so every value it would render (the
      // green dot, "Agent active", the tool count) is a frozen snapshot of a
      // build this page no longer talks to. Leaving those up contradicted the
      // "reload this page" banner sitting right next to them, which is exactly
      // the confusing state Seb caught on 2026-08-14.
      // No action button here: the banner already carries the Reload one.
      if (A.staleExtension) {
        if (dot) dot.className = "off";
        toneClass = "warn"; warn = true;
        msg = `<b>Disconnected</b> · reload this page to reconnect`;
      }
      // Show "Starting…" for the whole bootstrap. If the user actually leaves for
      // a new (empty) chat, syncSessionState clears A.starting, so this naturally
      // falls back to that chat's own state - no fragile per-key check here (fresh
      // chats share a key, and the conversation id only appears mid-bootstrap).
      else if (A.starting) {
        toneClass = "starting";
        indicator = `<span class="zs-spin"></span>`;
        msg = `Starting the Roblox agent…`;
        label = "Starting…"; kind = "starting"; disabled = true;
      } else if (A.started) {
        // Prefer the ADVERTISED list length (A.toolList - the AGGREGATE catalogue
        // across every connected MCP server, already filtered by the vision/blocked
        // gate so it matches what the model actually has: e.g. screen_capture is
        // absent on non-vision providers like Kimi). After a page reload A.toolList
        // is empty until the next list_tools, so fall back to the sum of every
        // server's per-server health count (Roblox + addons like Blender) - NOT the
        // Roblox-only count, which made the total drop to just 27 after a reload.
        const healthTotal = A.bridge &&
          (A.bridge.servers || []).reduce((n, x) => n + (x.tools || 0), 0);
        const tools = A.toolList.length || healthTotal || (A.bridge && A.bridge.tools) || 0;
        // "N tools" only means StudioMCP itself is up - it advertises its full
        // catalogue even with no Studio/place attached (see probe_studio() in
        // bridge.py), so showing it while Studio/place isn't actually usable
        // reads as "everything's fine" when tool calls will just fail. Surface
        // the real blocker instead in that case.
        if (A.bridge && A.bridge.connected === false) {
          // placeDown/appDown/studioDown are all false in this case (they're
          // only computed when the bridge IS connected - see setStatus), so
          // without this check the bridge dropping fell through to the
          // stale "N tools" text below, reading as if nothing was wrong.
          toneClass = "warn"; warn = true;
          msg = `<b>Agent active</b> · bridge offline, run start.bat`;
        } else if ((placeDown || appDown || studioDown) && addonOk) {
          // DEGRADED session by CHOICE: the user started the agent with Roblox
          // down but other MCP server(s) alive (the "Start agent (Roblox
          // offline)" path) - they may only want the addon tools (e.g. Blender).
          // Keep the YELLOW dot as the honest health signal, but do NOT keep the
          // red imperative "open Roblox Studio" nag on screen for the whole
          // session (warn=false → no zs-state-warn red text). The full nag
          // still shows when NO server is usable (the branches below).
          toneClass = "warn";
          msg = `<b>Agent active</b>${tools ? ` · ${tools} tools` : ""} · Roblox offline`;
        } else if (placeDown) {
          toneClass = "warn"; warn = true;
          msg = `<b>Agent active</b> · open a place in Roblox Studio`;
        } else if (appDown || studioDown) {
          toneClass = "warn"; warn = true;
          msg = studioProcUp
            ? `<b>Agent active</b> · Studio is open but not connected - open <b>Assistant Settings &gt; MCP Servers</b> in Studio`
            : `<b>Agent active</b> · open Roblox Studio & enable its MCP server`;
        } else {
          toneClass = "active";
          // No inline dot here: the leading status dot already shows green, two
          // dots side by side looked cluttered. The green "Agent active" text
          // carries it.
          msg = `<b>Agent active</b>${tools ? ` · ${tools} tools` : ""}`;
        }
      } else if (P.isFreshChat() || P.chatIsEmpty()) {
        // Treat ANY empty chat (no turns yet) as the standby/start case - not just
        // the strict fresh-chat match. isFreshChat() also requires an exact root
        // path AND the editor already mounted; on a cold load (e.g. arriving from a
        // search-engine link) the SPA can show pathname/editor before they settle,
        // which used to drop into the discouraging "No agent here" branch on a page
        // that is actually empty and startable. "No agent here" is only correct for
        // an EXISTING conversation (one that has turns) we did not start.
        if (bridgeOk) {
          toneClass = "standby";
          msg = `Standby. Start the agent, or just chat.`;
          label = "▶︎ Start Roblox agent"; kind = "start";
        } else if (addonOk) {
          // Roblox is down but another MCP server is live: allow a DEGRADED start
          // (yellow). The agent runs on the other server(s); Roblox tools stay
          // unavailable until Studio is back. Button enabled, but visibly warned.
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `Run <b>start.bat</b> on your PC.`
            : studioProcUp
              ? `<b>Studio open but not connected</b> - open <b>Assistant Settings &gt; MCP Servers</b> in Studio, or start without it.`
              : `<b>Roblox Studio offline</b> - start with your other MCP server(s).`;
          label = "▶︎ Start agent (Roblox offline)"; kind = "start-degraded";
        } else {
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `Run <b>start.bat</b> on your PC.`
            : placeDown
              ? `Open a <b>place</b> in Roblox Studio.`
              : (appDown || studioDown) && studioProcUp
                ? `Studio is open but not connected - open <b>Assistant Settings &gt; MCP Servers</b> in Studio.`
                : appDown
                  ? `Open <b>Roblox Studio</b> &amp; enable its MCP server.`
                  : studioDown
                    ? `Open <b>Roblox Studio</b> &amp; enable its MCP server.`
                    : `Open <b>Roblox Studio</b> for the tools.`;
          label = "▶︎ Start Roblox agent"; kind = "start";
        }
        disabled = !bridgeOk && !addonOk;
      } else {
        toneClass = "noagent";
        msg = `No agent here. Open a new chat to start one.`;
      }
      // Parked on visibility: the loop is alive but deliberately frozen because
      // this tab is not the foreground tab of its window. Say so explicitly -
      // otherwise the bar keeps claiming "Agent active" while nothing advances,
      // which reads as a hang (and is what users reported as "it died in the
      // background"). No red warn tone: this is a normal, recoverable pause.
      if (A.parked && (A.running || A.starting)) {
        toneClass = "warn"; warn = false;
        msg = `<b>Paused</b> · bring this tab to the front to continue`;
      }
      // Provider mode guard: some sites (e.g. Arena) only work in one chat mode.
      // When the provider reports the current mode is unsupported, override the
      // bar into a visible warning and disable Start until the user switches back.
      // Skipped once a session is started/starting (the mode is fixed for the
      // conversation by then). Reactive: renderBar runs on every sweep, so the
      // warning appears/clears the instant the user changes the mode dropdown.
      if (!A.started && !A.starting && P.modeWarning) {
        const modeWarn = P.modeWarning();
        if (modeWarn) {
          toneClass = "warn"; warn = true; msg = modeWarn;
          if (kind === "start" || kind === "start-degraded") disabled = true;
        }
      }
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Before a session is started, the bar stays minimal: only the Start action
      // + Discord (help). The AI selector and the tips/support menu appear once the
      // agent is actually running - so the pre-start bar isn't cluttered with
      // options that only matter mid-session. (A.started is ambiguous with `warn`
      // tone - which occurs both started-with-bridge-down and standby-with-bridge-
      // down - so it's tracked explicitly in the signature.)
      const showExtras = !!A.started;
      const sig = [toneClass, indicator, msg, label, kind, disabled, warn, busy, showExtras].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. zs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      stateEl.innerHTML = indicator + `<span class="zs-state-txt">${msg}</span>`;
      stateEl.classList.toggle("zs-state-warn", warn);
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.disabled = disabled;
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector + tips/support: only once a session is live. Discord stays
      // visible in every state (it's the help link).
      if (switchBtn) switchBtn.style.display = showExtras ? "" : "none";
      if (supportBtn) supportBtn.style.display = showExtras ? "" : "none";
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { renderBar(); }
    function setStarting() { renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      if (!dot) return;
      const servers = s.servers || [];
      // ZeroScript status tracks ONLY the primary Roblox MCP server. Every other
      // server is an addon and must NEVER make the dot/gate look connected while
      // Roblox itself is down. Old bridges don't send per-server health, so fall
      // back to the aggregate signals they do send (mcpAlive / total tools).
      const roblox = servers.find((x) => x.id === "roblox");
      const mcpUp = roblox ? !!roblox.alive : (!!s.mcpAlive || servers.some((x) => x.alive));
      // Roblox-only count drives the connectivity gate (the dot must never look
      // green off an addon while Roblox itself is down)...
      const robloxTools = roblox ? (roblox.tools || 0) : (s.tools || 0);
      const mcpOk = s.connected && (mcpUp || robloxTools > 0);
      // ...but the DISPLAYED count is the aggregate across every server (Roblox +
      // addons like Blender), so it stays consistent with the bar and doesn't
      // under-report when addon servers are loaded.
      const totalTools = servers.reduce((n, x) => n + (x.tools || 0), 0) || s.tools || robloxTools;
      // studio === false means the MCP server answered but the Studio is not USABLE
      // (no place loaded). studioApp tells the two sub-cases apart:
      //   studioApp === false → no Studio connected at all (app closed OR its MCP
      //                         server option is disabled - indistinguishable).
      //   studioApp === true  → Studio open but no place loaded (home screen / place
      //                         closed mid-session). THIS is the case that used to
      //                         wrongly read "Connected".
      // null/undefined = unknown (old bridge / probe busy) → don't degrade.
      const studioOff = mcpOk && s.studio === false;
      const noApp = studioOff && s.studioApp === false;
      const noPlace = studioOff && s.studioApp === true;
      const ok = mcpOk && !studioOff;
      dot.className = s.connected ? (ok ? "on" : "warn") : "off";
      // Studio PROCESS running on the machine (bridge-side tasklist check).
      // Splits noApp into its two truly different situations: Studio not
      // launched at all vs Studio OPEN but its MCP plugin never registered
      // with the bridge. The plugin only attempts to register ONCE (at Studio
      // boot or on a panel/toggle interaction) and never retries by itself,
      // so for the second case "open Roblox Studio" is dead-end advice - the
      // action that actually works (validated live 3x, 2026-07-11) is opening
      // Assistant Settings > MCP Servers inside the already-open Studio.
      const procUp = s.studioProc === true;
      let txt;
      if (!s.connected) txt = "Bridge offline, run start.bat";
      else if (!mcpOk) txt = "Bridge OK, open Roblox Studio";
      else if (noPlace) txt = "Roblox Studio is open but no place is loaded - open a place";
      else if (noApp) txt = procUp
        ? "Studio is open but not connected - in Studio, open Assistant Settings > MCP Servers (or toggle its MCP server off/on)"
        : "Roblox Studio not connected - open it and enable its MCP server";
      else if (studioOff) txt = "Studio not connected, enable the MCP server in Roblox Studio";
      else txt = `Connected · ${totalTools} tools ready`;
      dot.title = txt; // full bridge detail on hover over the status dot
      bridgeOk = ok;
      studioDown = studioOff;
      placeDown = noPlace;
      appDown = noApp;
      studioProcUp = procUp;
      // A non-Roblox MCP (Blender, Sketchfab, ...) that is actually alive. When
      // Roblox itself is down but such a server is present, the session can still
      // start in a DEGRADED mode - the agent just can't touch Roblox until Studio
      // is back. Gated on s.connected so a dropped bridge never reads as usable.
      addonOk = !!s.connected && servers.some((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      // Once the bridge has connected at least once, onboarding is done: never
      // resurface the "download the bridge" setup card again (otherwise, if the
      // bridge later drops, it would reappear on top of the bridge-lost banner).
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // The page outlived its extension build (reload / Chrome auto-update /
    // disable+enable). Distinct from bridgeAlert on purpose: opposite cause,
    // opposite fix, and this one NEVER self-heals, so the banner has no Close
    // button and offers the reload directly rather than telling the user to go
    // restart a bridge that was never down.
    function staleExtensionAlert() {
      // Latch it BEFORE painting, so the bar drops its frozen "Agent active ·
      // N tools" in the same pass and never contradicts the banner.
      A.staleExtension = true;
      renderBar();
      if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
      if (root.querySelector(".zs-banner.zs-stale")) return;
      const b = document.createElement("div");
      b.className = "zs-banner limit zs-stale";
      b.innerHTML = `<div class="zs-banner-t">⚠ Reload this page to reconnect ZeroScript</div>
        <div class="zs-banner-m">ZeroScript was updated or reloaded while this tab was open, so this page is still running the old copy and commands can no longer run. Your bridge and Roblox Studio are fine - only this page needs refreshing.</div>
        <div class="zs-banner-acts"><button class="zs-banner-reload">Reload page</button></div>`;
      b.querySelector(".zs-banner-reload").addEventListener("click", () => location.reload());
      root.appendChild(b);
      bridgeBannerEl = b;
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
      // The setup tutorial lives INSIDE this banner (not as a separate card) so it
      // can never overlap the alert - the previous standalone onboarding card did.
      const videoLink = VIDEO_URL
        ? `<a class="zs-banner-video" href="${VIDEO_URL}" target="_blank" rel="noopener">▶︎ Watch setup tutorial</a>`
        : "";
      b.innerHTML = `<div class="zs-banner-t">⚠ Lost connection to ZeroScript</div>
        <div class="zs-banner-m">The ZeroScript bridge stopped on your PC. Restart it (run start.bat and keep Roblox Studio open): the agent will reconnect automatically as soon as it is detected again.</div>
        <div class="zs-banner-acts">${videoLink}<button class="zs-banner-x">Close</button></div>`;
      b.querySelector(".zs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled "⏳ Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = "⏳ Stopping…";
      renderBar();
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable Roblox control.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        toast("Tip: click “▶︎ Start Roblox agent” to let the AI control Roblox Studio.");
      }
      if (!actionBtn) return;
      actionBtn.classList.add("zs-flash");
      setTimeout(() => actionBtn.classList.remove("zs-flash"), 1200);
    }

    // ── Theme auto-detection (light / dark) ─────────────────────────────────
    // The panel and the in-conversation chips are dark-themed by default. On a
    // LIGHT host page the chips' light text on a near-transparent tint becomes
    // invisible, so we detect the page's effective background luminance and add
    // `.zs-light` to <html>; overlay.css then flips to readable light colours.
    // Most chat sites declare their theme EXPLICITLY (a `dark`/`light` class on
    // <html>/<body>, a data-theme attribute, or CSS color-scheme) - far more
    // reliable than luminance, since many (e.g. z.ai) leave <html>/<body> with a
    // transparent background and paint the theme on a deeper container. Returns
    // "light" | "dark" | null (no explicit signal).
    function pageThemeHint() {
      const de = document.documentElement, b = document.body;
      const cls = (de.className + " " + (b ? b.className : "")).toLowerCase();
      if (/\bdark\b/.test(cls)) return "dark";
      if (/\blight\b/.test(cls)) return "light";
      const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                    de.getAttribute("data-color-scheme") || "").toLowerCase();
      if (/dark/.test(attr)) return "dark";
      if (/light/.test(attr)) return "light";
      const cs = (getComputedStyle(de).colorScheme || "").toLowerCase();
      if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
      if (/light/.test(cs) && !/dark/.test(cs)) return "light";
      return null;
    }
    // Fallback only: luminance of the first opaque background up the tree.
    function effectiveBg() {
      let n = document.body;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor || "rgb(255,255,255)";
    }
    function applyTheme() {
      let light;
      const hint = pageThemeHint();
      if (hint) {
        light = hint === "light";
      } else {
        const m = (effectiveBg().match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (m.length < 3) return;
        light = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
      }
      document.documentElement.classList.toggle("zs-light", light);
    }

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      const m = P.barMount();
      return (m && m.parent && m.parent.isConnected) ? m : null;
    }

    // Floating fallback geometry (used only when no inline mount is available).
    const BAR_MAX_W = 560, BAR_GAP = 8;

    // Anchored mode bookkeeping: the composer element whose top padding we are
    // borrowing to seat the bar (see the anchored branch below). Cleared when we
    // leave anchored mode so the site's composer returns to its normal layout.
    let anchorPadEl = null;
    function clearAnchorPad() {
      if (anchorPadEl) { try { anchorPadEl.style.paddingTop = ""; } catch {} anchorPadEl = null; }
    }

    // Position the floating "⚠ unstable" pill just above the bar's left edge.
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      u.style.left = Math.round(br.left) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    function placeBar() {
      barRaf = requestAnimationFrame(placeBar);
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #zs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // rAF loop is resilient (its next frame is scheduled before any body code),
      // so the panel reappears on the very next frame.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every frame - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next frame once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        (P.overlayBlocking && P.overlayBlocking())
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (menuEl) menuEl.hidden = true;
        return;
      }

      // Preferred: in-flow mount inside the composer (no overlap, full width).
      const mount = computeBarMount();
      if (mount) {
        clearAnchorPad();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("zs-bar-inline")) {
          bar.classList.add("zs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        // Transparent (blends in) when mounted INSIDE the input box; surface card
        // when mounted ABOVE it. The provider's barMount() signals which via .inside.
        bar.classList.toggle("zs-bar-inside", !!mount.inside);
        bar.style.display = "flex";
        if (menuEl && !menuEl.hidden) {
          const br = bar.getBoundingClientRect();
          menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
        }
        return;
      }

      // Anchored mode: the provider wants the integrated, in-composer LOOK but
      // its composer is a framework-reconciled subtree we must NOT insert our
      // node into (e.g. Kimi's Vue tree - inserting #zs-bar there makes Vue's
      // next diff reuse the bar node as a host and nest the editor inside it).
      // So we keep the bar in our own #zs-root, position it (position:fixed) to
      // hug the composer's top edge at full width, and RESERVE that strip with
      // padding-top on the composer so it reads as in-flow without ever becoming
      // a child of the framework's DOM. barAnchor() returns the element to hug.
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside");
        bar.classList.add("zs-bar-anchored");
        if (root && bar.parentElement !== root) root.appendChild(bar);
        const r = anchorEl.getBoundingClientRect();
        if (!r.width) { bar.style.display = "none"; clearAnchorPad(); if (menuEl) menuEl.hidden = true; return; }
        bar.style.display = "flex";
        const bh = bar.offsetHeight || 34;
        if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
        anchorPadEl = anchorEl;
        anchorEl.style.paddingTop = (bh + 6) + "px"; // reserve the strip the bar sits in (+gap)
        bar.style.left = Math.round(r.left) + "px";
        bar.style.top = Math.round(r.top) + "px";
        bar.style.width = Math.round(r.width) + "px";
        if (menuEl && !menuEl.hidden) {
          bar.classList.remove("zs-bar-inline"); // ensure fixed geometry for menu math
          menuEl.style.right = Math.round(window.innerWidth - (r.left + r.width)) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(r.top - 16)) + "px";
        }
        return;
      }
      bar.classList.remove("zs-bar-anchored");
      clearAnchorPad();

      // Fallback: float just above the editor (fixed positioning), for sites
      // where no clean inline mount could be resolved.
      if (bar.classList.contains("zs-bar-inline")) {
        bar.classList.remove("zs-bar-inline");
        if (root && bar.parentElement !== root) root.appendChild(bar);
      }
      const f = (P.getEditor && P.getEditor()) || (P.composerFrame && P.composerFrame());
      if (!f) { bar.style.display = "none"; if (menuEl) menuEl.hidden = true; return; }
      bar.style.display = "flex";
      const r = f.getBoundingClientRect();
      if (!r.width) { bar.style.display = "none"; return; }
      const w = Math.min(r.width, BAR_MAX_W);
      const left = Math.round(r.left + (r.width - w) / 2);
      const bh = bar.offsetHeight || 40;
      const top = Math.max(4, Math.round(r.top - bh - BAR_GAP));
      bar.style.width = w + "px";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // Keep the open "more" menu anchored to the bar, opening upward.
      if (menuEl && !menuEl.hidden) {
        const br = bar.getBoundingClientRect();
        menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
        menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
        menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
      }
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // Returns a FULLY OPAQUE colour that matches what is VISUALLY behind the cover.
    // The cover must hide the typed text, so it can't be translucent - but simply
    // returning the first solid ancestor is wrong when the composer surface itself
    // is translucent: Meta's card is rgba(56,56,56,0.8) over a dark page, so its
    // real on-screen colour is a BLEND (~rgb(50,50,50)), lighter than the bare page
    // (rgb(24,24,25)). Filling the cover with the page colour made it visibly
    // darker than the composer. So collect the background layers from `el` up to
    // the first opaque ancestor and FLATTEN them (alpha compositing) into one solid
    // colour that reproduces the composer's actual appearance.
    function opaqueBg(el) {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.999) break; // opaque base reached - nothing behind matters
        }
        n = n.parentElement;
      }
      // Guarantee an opaque base at the bottom of the stack.
      if (!layers.length || layers[layers.length - 1].a < 0.999) {
        const base = parseColor(getComputedStyle(document.body).backgroundColor) ||
                     { r: 255, g: 255, b: 255, a: 1 };
        layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
      }
      // We collected top-most (el) first, so composite from the opaque base (last)
      // upward toward el (first).
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
      return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
    }
    // Parse an rgb()/rgba() computed colour into {r,g,b,a}. Returns null for
    // "transparent"/unparseable. getComputedStyle always yields rgb/rgba form.
    function parseColor(c) {
      if (!c || c === "transparent") return null;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
    }
    // Source-over compositing of a (possibly translucent) fg onto an opaque bg.
    function blendOver(fg, bg) {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    }

    function inputCover(on) {
      const ed = P.getEditor();
      if (!on) {
        if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
        if (ed) ed.classList.remove("zs-typing");
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      ed.classList.add("zs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "zs-input-cover";
        cover.innerHTML = `<span>Agent is working…</span>`;
        document.documentElement.appendChild(cover);
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        const e = P.getEditor();
        if (!e) { coverRaf = requestAnimationFrame(place); return; }
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add every frame keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("zs-typing")) e.classList.add("zs-typing");
        // The cover is SIZED to coverTarget() when a provider supplies one, else
        // to the editor node itself. Some composers (Meta AI) make the editable a
        // tiny line inside a much larger rounded card - covering only the editor
        // left the rest of the card exposed and CLICKABLE (a careful click focused
        // the editor and let the user type behind the cover). Meta returns its
        // whole composer card so the cover blankets the entire input band and its
        // pointer-events:auto blocks every click. The typing mask above still lives
        // on the real editor node `e`.
        const covNode = (P.coverTarget && P.coverTarget()) || e;
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          (P.overlayBlocking && P.overlayBlocking()) ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          coverRaf = requestAnimationFrame(place);
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .zs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        // The SAME clipping applies horizontally, and for the same reason: a
        // composer whose editor is a flex item grows to its content width when a
        // long unbroken line is injected, while an ancestor with overflow-x:hidden
        // keeps the PAGE looking right. Seen on ChatGPT at Start, where the editor
        // is filled with the (large) system prompt: the inner
        // .prosemirror-parent widened past its `-my-2.5 flex overflow-x-hidden`
        // wrapper, so the cover - position:fixed and sized to the raw rect - stuck
        // out to the RIGHT of the composer card. Clip on each axis independently:
        // the ancestor that clips X is not always the one that clips Y.
        let clipY = false, clipX = false;
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
          const st = getComputedStyle(a);
          const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
          const ar = a.getBoundingClientRect();
          if (!clipY && clips(st.overflowY)) {
            clipY = true;
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
          }
          if (!clipX && clips(st.overflowX)) {
            clipX = true;
            const left = Math.max(r.left, ar.left);
            const right = Math.min(r.right, ar.right);
            if (right > left) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never paint outside the composer card. The cover is position:fixed and
        // re-placed every rAF from a freshly measured rect, which is correct while
        // the page is still - but a site that ANIMATES its composer updates layout
        // AFTER our callback, so for the whole animation the cover trails one frame
        // behind. Seen on ChatGPT at Start: injecting the system prompt grows the
        // composer 58px -> 156px, the page gains a scrollbar, the content column
        // narrows and the composer slides 29px left - while the cover kept the
        // previous coordinates and hung 28px past the card's right edge. It only
        // showed on the FIRST send, because afterwards the composer is already
        // docked at the bottom and stops moving. Clamping to the composer frame
        // makes a stale rect impossible to see: worst case the cover is briefly a
        // few px small, which reads as nothing.
        const frame = P.composerFrame && P.composerFrame();
        if (frame) {
          const fr = frame.getBoundingClientRect();
          // Only clamp to a frame that really wraps the cover target, so a provider
          // whose frame is narrower than its editor can never shrink the cover.
          const cx = r.left + r.width / 2;
          if (fr.width > 0 && fr.left <= cx && fr.right >= cx) {
            const left = Math.max(r.left, fr.left);
            const right = Math.min(r.right, fr.right);
            if (right - left > 40) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Optionally overshoot the editor box by PAD px on every side. Some
        // composers (Gemini's Quill) keep typed text near rounded corners, so a
        // cover sized EXACTLY to the editor leaves slivers of text peeking; those
        // providers set coverPad to bleed past the edges. A native <textarea>
        // (DeepSeek) needs none - overshooting there just makes the cover overflow
        // the composer, so it defaults to 0.
        const PAD = P.coverPad || 0;
        // Optional vertical nudge: some composers (Gemini's Quill) report an
        // editor rect that sits a few px below the visual input box centre, so
        // the centred "Agent is working…" text looks low. A provider can shift it.
        const OFFY = P.coverOffsetY || 0;
        // Height is at least MIN_H so the label is readable even over a
        // single-line composer. CENTER the cover on the editor's vertical middle
        // rather than anchoring its TOP to the editor top: a short (e.g. 20px)
        // textarea bumped to 36px would otherwise grow only DOWNWARD, leaving the
        // "Agent is working…" label sitting high in the composer's input band
        // (seen on Cloudflare's 1-line textarea). For a composer already taller
        // than MIN_H the maths reduces to the old `r.top - PAD`, so DeepSeek/Gemini
        // are unchanged.
        // Hard ceiling: even though .zs-typing caps the editor's visual height
        // (see overlay.css), belt-and-suspenders clamp the cover so a composer
        // whose growing element escapes that CSS cap on some provider can never
        // turn the "Agent is working…" cover into a full-page white slab.
        const MAXH = P.coverMaxH || 200;
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = (r.left - PAD) + "px";
        cover.style.top = (centerY - h / 2) + "px";
        cover.style.width = (r.width + PAD * 2) + "px";
        cover.style.height = h + "px";
        // Composite the surface BEHIND the cover target so the fill matches what
        // the user sees (a translucent composer card blends over the page).
        cover.style.background = opaqueBg(covNode);
        // When the cover blankets a whole composer card (coverTarget), match its
        // corner radius so the cover's square corners don't poke past the card's
        // rounded ones. Editor-sized covers keep the CSS default.
        if (P.coverTarget) cover.style.borderRadius = getComputedStyle(covNode).borderRadius;
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
          <button class="zs-banner-x">Close</button>
        </div>`;
      b.querySelector(".zs-banner-t").textContent = title;
      b.querySelector(".zs-banner-m").textContent = msg;
      b.querySelector(".zs-banner-x").addEventListener("click", () => b.remove());
      root.appendChild(b);
    }

    // Left-hand ZeroScript popup showing the latest screen_capture. Fed from the
    // in-memory base64 (a data: URL always renders), so it works identically on
    // every provider and never touches the site's DOM. Only the most recent
    // capture is kept - a new one replaces the old.
    function showImages(images, toolName) {
      root.querySelectorAll(".zs-shot").forEach((e) => e.remove());
      const wrap = document.createElement("div");
      wrap.className = "zs-shot";
      const hdr = document.createElement("div");
      hdr.className = "zs-shot-hdr";
      const ttl = document.createElement("span");
      ttl.className = "zs-shot-ttl";
      ttl.textContent = `${toolName} · ${images.length} image${images.length > 1 ? "s" : ""}`;
      const close = document.createElement("button");
      close.className = "zs-shot-x";
      close.textContent = "✕";
      close.addEventListener("click", () => wrap.remove());
      hdr.appendChild(ttl);
      hdr.appendChild(close);
      wrap.appendChild(hdr);
      const body = document.createElement("div");
      body.className = "zs-shot-body";
      for (const img of images) {
        const el = document.createElement("img");
        el.className = "zs-shot-img";
        el.src = `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
        body.appendChild(el);
      }
      wrap.appendChild(body);
      root.appendChild(wrap);
    }

    build();
    return { setStatus, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup, getCustomPrompt, getCustomMcpServers, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

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

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // ZeroScript's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#zs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

  let _prevHardGen = null, _prevSoftGen = null;
  setInterval(() => {
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #zs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".zs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live ZeroScript session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a ZS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ? P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    ui.showStop(A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating()));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ? P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && ZSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = ZSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, studioApp: msg.studioApp, studioProc: msg.studioProc, tools: msg.tools, servers: msg.servers });
    }
    if (msg && msg.type === "zs-open-menu") {
      ui.openMenu(false); // from the popup's Settings button — opens at the top (Switch AI / custom prompt)
    }
  });

  // Status poll. An orphaned content script (see bg / isContextInvalidated) gets
  // a failure object back whose `connected` is undefined, which setStatus would
  // read as "the bridge just dropped" and answer with the red "run start.bat"
  // banner - sending the user to fix a bridge that is perfectly healthy, with
  // the one thing that WOULD fix it (reload the page) never mentioned. Catch it
  // before setStatus, say the right thing, and stop polling: the context can
  // never come back, so every later tick would just repeat the same failure.
  let statusTimer = 0;
  function onStatus(s) {
    if (!s) return;
    if (s.kind === "stale-extension") {
      clearInterval(statusTimer);
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: s.error });
      return;
    }
    ui.setStatus(s);
  }
  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  loadSysCount();
  bg({ type: "status" }).then(onStatus);
  statusTimer = setInterval(() => bg({ type: "status" }).then(onStatus), 5000);

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ zsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS a ZeroScript session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or a ZeroScript command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasZsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (txt.includes(ZS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###LUA### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / zsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not ZeroScript's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "Start Roblox agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("zs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("zs-hidden")) continue;
      const txt = P.classifyText(item, ".zs-chip");
      if (txt.includes(ZS.SYS_MARKER) ||
          (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt))) {
        item.classList.add("zs-hidden");
      }
    }
  }
  const mo = new MutationObserver(() => {
    preHideWholeItems();
    scheduleSweep();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // Belt-and-braces: a low-frequency sweep regardless of tab visibility or
  // mutation timing, so camouflage always converges.
  setInterval(scheduleSweep, 1500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      bumpSys("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
  const RESUME_FRESH_MS = 180000;
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden) return;                         // AI tab not foreground → don't parse/exec off-screen (agentLoop gates too)
    if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return;
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (withSysResend) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
  const SYS_FALLBACK_IDLE_MS = 20000;
  setInterval(async () => {
    if (!sysResendDue()) return;
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden || A.userStopped) return;
    if (P.isGenerating()) return;
    // The user is composing - their draft owns the editor, leave it alone.
    try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
    // Give the cheap path a fair chance first: only step in once the turn has
    // been settled and quiet for a while with no tool result to ride on.
    if (Date.now() - A.lastGenAt < SYS_FALLBACK_IDLE_MS) return;
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    diag("sys.resend", { via: "ownTurn", ...spent });
    try {
      const base = await submitAndGetBase(systemPrompt());
      await waitForResponse(base);
    } catch (e) {
      diag("sys.resendFailed", { err: String(e && e.message || e) });
    }
  }, 5000);

  log(`ZeroScript content script ready (provider: ${P.id})`);
})();
