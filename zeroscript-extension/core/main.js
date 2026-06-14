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

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list (ChatGPT), where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
  }

  async function submitAndGetBase(text) {
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
          if (!(await waitFor(() => !document.hidden || A.stop, 600000)) || A.stop) break;
        }
        await P.typeAndSend(text);
        // The site clears the textarea as soon as the send is accepted — faster
        // and more reliable than waiting for a DOM turn count change.
        await waitFor(() => {
          if (P.editorText().trim() === "") messageSent = true;
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
    const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
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
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached.
    const GEN_STOP_GRACE_MS = 2500;

    while (Date.now() - t0 < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      const gen = P.isGenerating();
      const d = P.readAssistant();
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // ChatGPT's list virtualisation kept assistantCount() <= base for a fresh
      // reply, so the reliableCounts gate below waited out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
      const newReply = (curTok !== undefined)
        ? (curTok != null && curTok !== A.sendToken)
        : P.assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;

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
          if (Date.now() - preStartSilent > 60000) return { kind: "empty" };
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
      if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); }
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
      const stuckDone = started && d.reply && Date.now() - lastChangeAt > STABLE_MS;
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
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
      } else {
        noTurnSince = 0;
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

      const r = d.reply;
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      if (ZSParse.hasToolSignature(r)) {
        const calls = ZSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present.
        if (r.includes(ZSParse.START_M) || ZSParse.LUA_START_RE.test(r)) return { kind: "parse_error", raw: r };
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        if (ZSParse.hasOpenToolBlock(r)) return { kind: "parse_error", raw: r };
      }
      if (r.length < 400 && P.isBusyMsg(r)) return { kind: "busy" };
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") return { kind: "empty" };
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
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

  // Tools we never expose to the model: 'subagent' (long-running, hangs the
  // loop) and 'screen_capture' (returns an image text-only models can't see).
  // Filtered out of the advertised command list AND refused in runTool.
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

  async function runTool(call) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return ZS.FEEDBACK.parseError;
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (bareName === "screen_capture") {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    // Virtual command: list all available Roblox commands with full details.
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
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers, the loop
    // gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    const r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout }), hardCap]);
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
    if (r.ok) {
      if (r.images && r.images.length) {
        ui.showImages(r.images, name);
        let attached = false;
        try { attached = await P.attachImages(r.images); } catch (e) { log("attach failed", e); }
        if (!attached) { try { P.clearAttachments(); } catch {} } // drop a broken upload
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
    P.setInputLock(true); // prevent user from typing while the agent is active
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", `${P.displayName} reached its context limit`,
            (res.detail || "") + "  -  click “New session” to start fresh.");
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
        if (res.kind === "busy") {
          ui.toast(`${P.displayName} is busy - retrying in 4s…`);
          await sleep(4000);
          base = await submitAndGetBase(ZS.FEEDBACK.continue);
          continue;
        }
        // A genuinely empty turn is effectively never produced (the warm-up
        // guard waits out slow starts) - just end the loop quietly.
        if (res.kind === "empty") { diag("empty.end"); break; }

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
      P.setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
  }

  function stopLoop() {
    diag("stopLoop");
    A.stop = true;
    A.userStopped = true; // suppress auto-resume until the next user message
    P.stopGeneration();
    ui.toast("Loop stopped.");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession(opts) {
    if (A.running || A.starting) return;
    // "Start session" is allowed ONLY on a blank conversation. Opening an
    // EXISTING conversation must never trigger the bootstrap. The explicit
    // "New session" recovery button passes force:true.
    if (!P.chatIsEmpty() && !(opts && opts.force) && !A.started) {
      ui.toast("Open a new, empty conversation to start a session.");
      return;
    }
    A.userStopped = false;
    A.starting = true;
    ui.setStarting(true);
    ui.updateStartGate(); // reveal the composer + send the panel back to the corner
    P.setInputLock(true); // block user input during bootstrap
    try {
      await ensureTools();
      if (!A.toolList.length) {
        ui.banner("warn", "Bridge or Studio offline",
          "Could not fetch Roblox tools. Start the ZeroScript bridge and make sure Roblox Studio is open, then try again.");
        return;
      }
      const modeState = await P.ensureComposerReady("startup");
      if (!modeState.ready) {
        ui.banner("warn", `${P.displayName} mode not ready`,
          `Could not switch ${P.displayName} to the required mode. Start a new chat or reload the page, then try again.`);
        return;
      }
      const prompt = ZS.buildSystemPrompt(A.toolList, { siteName: P.displayName, profile: P.promptProfile });
      const base = await submitAndGetBase(prompt);
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      let startRes = await waitForResponse(base);

      // Cautious models (ChatGPT especially) often refuse the FIRST turn with a
      // plain-text "I don't have access to Studio / this extension" instead of
      // emitting list_commands - validated live. A single "just try it" nudge
      // reliably unblocks them (the same thing a user does by hand). So if the
      // bootstrap reply is NOT a command, auto-nudge and re-wait, a couple of
      // times, before giving up. We only nudge on non-tool replies; a model that
      // jumped straight to a (different) command is left to the normal flow.
      let bootstrapNudges = 0;
      while (startRes.kind !== "tool" && bootstrapNudges < 3 && !A.stop) {
        bootstrapNudges++;
        diag("bootstrap.nudge", { kind: startRes.kind, n: bootstrapNudges });
        const nudgeBase = await submitAndGetBase(ZS.FEEDBACK.bootstrapNudge);
        decorate.sweep();
        startRes = await waitForResponse(nudgeBase);
      }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
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
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
      ui.toast(`Agent ready. Ask ${P.displayName} to build something in Roblox.`);
    } catch (e) {
      ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      A.starting = false;
      ui.setStarting(false);
      P.setInputLock(false); // always unlock after bootstrap
      decorate.sweep(); // flip the chip from animated → settled
    }
  }

  // Explicit "New session": open a FRESH conversation and bootstrap it there -
  // rather than re-injecting the system prompt into the current chat. Falls
  // back to an in-place start only if navigation fails.
  async function newSessionClick() {
    if (A.running || A.starting) {
      ui.toast("Please wait - ZeroScript is busy.");
      return;
    }
    if (await P.openNewChat()) {
      // Fresh conversation → reset session state before bootstrapping it.
      A.started = false;
      ui.setStarted(false);
    }
    startSession({ force: true });
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
    delete item.__zsChip;
  }

  const decorate = {
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
          if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
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
      const chipGone = !item.querySelector(".zs-chip");
      let rawVisible = false;
      if (!opts.whole) {
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code']")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      if (chipGone || rawVisible) this.chip(item, opts);
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
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

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
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
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
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt)) {
        const live = item === P.lastAssistant() && (P.isGenerating() || A.running);
        const phase = live ? "run" : "done";
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code']")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && ZSParse.hasCommandShape(e.textContent || ""));
        if (item.dataset.zphase !== phase || chipGone || rawVisible) {
          this.toolBox(item, ZSParse.toolNameFromText(txt), phase, "", false);
        }
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        resetDecoration(item);
      }
    },

    sweep() {
      for (const it of P.allItems()) this.classify(it);
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, dot, stopBtn, cover, coverRaf, startBtn, hintEl, ctaEl, activeEl, activeTxtEl, stateEl;
    let panel, gateRaf, bridgeOk = false, studioDown = false;
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
          ${P.unstableWarning ? `<div id="zs-unstable" title="">⚠ ${P.displayName} is unstable - may stop doing what it should</div>` : ""}
          <div id="zs-cta">
            <button id="zs-start">▶  Start session</button>
            <div id="zs-hint">Click <b>Start</b>, then type what you want to build - ${P.displayName} will drive Roblox Studio for you.</div>
          </div>
          <div id="zs-active" hidden>
            <span class="zs-active-txt"><span class="zs-live-dot"></span>Session active - just type your request</span>
            <button id="zs-new" title="Open a fresh conversation and start a new agent session there">⟳ New session</button>
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
      // Permanent, non-intrusive instability notice (full text on hover).
      const unstable = root.querySelector("#zs-unstable");
      if (unstable) unstable.title = P.unstableWarning;
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
    //  • anything else → the compact "active" row with the "New session" button.
    function syncPanel() {
      if (!ctaEl) return;
      const showCta = A.starting || (P.isFreshChat() && !A.started);
      ctaEl.hidden = !showCta;
      activeEl.hidden = showCta;
      if (!showCta && activeTxtEl) {
        activeTxtEl.innerHTML = A.started
          ? `<span class="zs-live-dot"></span>Session active. Just type your request in ${P.displayName}.`
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
      const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
      // studio === false means the MCP server answered but NO Studio is attached
      // (Studio closed, no place open, or its MCP option disabled). The MCP
      // process stays alive in that state, so mcpOk alone reads "Connected".
      // null/undefined = unknown (old bridge / probe busy) → don't degrade.
      const studioOff = mcpOk && s.studio === false;
      const ok = mcpOk && !studioOff;
      dot.className = s.connected ? (ok ? "on" : "warn") : "off";
      let txt;
      if (!s.connected) txt = "Bridge offline - run the ZeroScript bridge";
      else if (!mcpOk) txt = "Bridge OK - open Roblox Studio";
      else if (studioOff) txt = "Studio not connected - enable the MCP server in Roblox Studio";
      else txt = `Connected · ${s.tools} Roblox tools ready`;
      stateEl.textContent = txt;
      bridgeOk = ok;
      studioDown = studioOff;
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
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

    // Gate the Start button on a usable bridge (the CTA only ever shows on a
    // fresh blank chat, see syncPanel). The hint explains whatever is missing.
    function refreshStart() {
      if (!startBtn || A.starting) return;
      const ready = bridgeOk;
      startBtn.disabled = !ready;
      if (!hintEl) return;
      hintEl.innerHTML = ready
        ? `Click <b>Start</b>, then type what you want to build - ${P.displayName} will drive Roblox Studio for you.`
        : (!A.bridge.connected
            ? `⚠ Start the <b>ZeroScript bridge</b> on your PC first.`
            : studioDown
              ? `⚠ Open <b>Roblox Studio</b> with a place and <b>enable the MCP server</b> (Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server).`
              : `⚠ Open <b>Roblox Studio</b> so the tools become available.`);
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
    // composer frame and bring the control panel up OVER it, enlarged, so a
    // non-technical user can't miss the mandatory "Start session" step. The
    // extension still types/sends programmatically (visibility:hidden doesn't
    // block scripted value-setting or .click()).
    function updateStartGate() {
      syncPanel();
      refreshStart();
      const frame = P.composerFrame();
      const show = !A.started && !A.starting && P.isFreshChat() && !!frame && !!panel;
      if (!show) { ungate(); return; }
      document.querySelectorAll(".zs-frame-hidden").forEach((e) => {
        if (e !== frame) e.classList.remove("zs-frame-hidden");
      });
      frame.classList.add("zs-frame-hidden");
      root.classList.add("zs-gate-on");
      const place = () => {
        if (!root.classList.contains("zs-gate-on")) return;
        const f = P.composerFrame();
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
      const ed = P.getEditor();
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
        const e = P.getEditor();
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

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
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

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  setInterval(() => {
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // The "■ Stop" button, by contrast, uses the STRICT hard signal so it never
    // flashes on reload / scroll. The loop-active case is covered by A.running.
    ui.showStop(A.running || A.toolRunning || P.isHardGenerating());

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
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, tools: msg.tools, servers: msg.servers });
    }
  });

  bg({ type: "status" }).then((s) => s && ui.setStatus(s));
  setInterval(() => bg({ type: "status" }).then((s) => s && ui.setStatus(s)), 5000);

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
      if (P.isAssistantItem(it) && ZSParse.hasCommandShape(txt)) return true;
    }
    return false;
  }
  function syncSessionState() {
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path === lastSyncPath) {
      // SAME conversation: never downgrade a known-started session just because
      // virtualization scrolled the marker out of the DOM. "started" is sticky
      // until the key actually changes (a different conversation).
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
  const mo = new MutationObserver(scheduleSweep);
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
      captureSendToken(); // identity of the assistant turn before this reply
      setTimeout(() => { if (!A.running) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
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
  const RESUME_FRESH_MS = 8000;
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  log(`ZeroScript content script ready (provider: ${P.id})`);
})();
