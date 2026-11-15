// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agent loop and in-page UI.
//
// This is the Godot edition of ZeroScript. The flow is:
//
//   visual console -> controller (local HTTP relay) -> this tab
//     -> AI chat web page -> one JSON command -> controller -> Godot plugin
//
// The extension never talks to Godot directly and never executes commands
// itself: it types a prompt, waits for the model's answer, parses ONE command,
// reports it, and waits for the controller to assign the next turn (possibly to
// a different browser). That is what makes multi-browser rotation possible.
//
// Everything site-specific goes through ZSProvider (providers/*.js). This file
// may only touch its OWN UI and the provider interface.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = Object.assign(
    {
      GEN_IDLE_MS: 1200,
      STABLE_MS: 12000,
      WARMUP_MS: 45000,
      RESPONSE_TIMEOUT_MS: 300000,
    },
    P.timings || {}
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const log = (...a) => console.log("[nonzeroscript]", ...a);
  const SID_KEY = "nzs-session-id";

  // ════════════════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════════════════
  const state = {
    sessionId: null,
    browserId: "unknown",
    browser: "Browser",
    controllerOnline: null,
    editorConnected: null,
    editorProject: "",
    editorWrite: true,
    editorCSharp: null,
    editorDotnet: null,
    settings: { min_delay: 2, max_delay: 6, max_turns: 60 },
    tools: [],
    sessionState: "registered", // registered | starting | ready | busy | stopped
    starting: false,
    ready: false,
    busy: false,
    abort: false,
    currentTurn: null,
    taskId: null,
    lastError: "",
    lastReply: "",
    turns: 0,
    pollTimer: null,
    reconnectTimer: null,
    mountTimer: null,
    startedAt: 0,
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root = null;
    let bar = null;
    let els = {};
    let toastTimer = null;

    function detectBrowser() {
      const ua = navigator.userAgent || "";
      if (/\bEdg\//.test(ua)) return "Edge";
      if (/\bOPR\//.test(ua)) return "Opera";
      if (/\bFirefox\//.test(ua)) return "Firefox";
      if (/\bChrome\//.test(ua)) return "Chrome";
      return "Browser";
    }

    function build() {
      if (document.getElementById("zs-root")) {
        root = document.getElementById("zs-root");
        bar = document.getElementById("zs-bar");
        bindEls();
        return;
      }
      root = document.createElement("div");
      root.id = "zs-root";
      bar = document.createElement("div");
      bar.id = "zs-bar";
      bar.className = `zs-bar zs-prov-${P.id}`;
      bar.innerHTML = `
        <span id="zs-brand" title="NonZeroScript · Godot edition"><span class="zs-logo">&lt;/&gt;</span><b>NonZeroScript</b></span>
        <span id="zs-dot" class="zs-dot"></span>
        <span id="zs-state">正在连接操控台…</span>
        <span id="zs-extra"></span>
        <span id="zs-spacer"></span>
        <button id="zs-console" class="zs-btn zs-btn-ghost" title="打开可视化操控台">操控台</button>
        <button id="zs-start" class="zs-btn zs-btn-main">启动</button>
        <button id="zs-stop" class="zs-btn zs-btn-stop" disabled>停止</button>
      `;
      root.appendChild(bar);
      const toast = document.createElement("div");
      toast.id = "zs-toast";
      root.appendChild(toast);
      document.documentElement.appendChild(root);
      bindEls();
      mount();
    }

    function bindEls() {
      els = {
        dot: document.getElementById("zs-dot"),
        state: document.getElementById("zs-state"),
        extra: document.getElementById("zs-extra"),
        start: document.getElementById("zs-start"),
        stop: document.getElementById("zs-stop"),
        consoleBtn: document.getElementById("zs-console"),
        toast: document.getElementById("zs-toast"),
      };
      els.start.onclick = () => {
        if (!state.ready && !state.starting) startSession();
      };
      els.stop.onclick = () => stopSession("用户点击停止");
      els.consoleBtn.onclick = () => ZSNet.openConsole();
    }

    // Put the bar where the site's composer lives. Providers export one of
    // barMount / barAnchor / composerFrame; fall back to a fixed corner.
    function mount() {
      if (!bar) return;
      if (bar.classList.contains("zs-bar-fixed")) return;
      try {
        const m = P.barMount ? P.barMount() : null;
        if (m && m.parent) {
          m.parent.insertBefore(bar, m.before || null);
          bar.classList.add("zs-bar-inline");
          if (m.inside) bar.classList.add("zs-bar-inside");
          return;
        }
        const a = P.barAnchor ? P.barAnchor() : null;
        if (a && a.parentElement) {
          a.parentElement.insertBefore(bar, a);
          bar.classList.add("zs-bar-inline");
          return;
        }
        const f = P.composerFrame ? P.composerFrame() : null;
        if (f && f.parentElement) {
          f.parentElement.insertBefore(bar, f);
          bar.classList.add("zs-bar-inline");
          return;
        }
      } catch (e) {
        log("mount failed", e);
      }
      bar.classList.add("zs-bar-fixed");
      (document.body || document.documentElement).appendChild(bar);
    }

    function ensureMounted() {
      if (!root || !bar) return;
      if (!document.getElementById("zs-root")) {
        (document.body || document.documentElement).appendChild(root);
      }
      if (!document.getElementById("zs-bar")) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside", "zs-bar-fixed");
        root.appendChild(bar);
        mount();
        return;
      }
      // A composer can appear after document_idle (SPA route change): retry the
      // in-flow mount instead of leaving the bar in the fixed corner forever.
      if (bar.classList.contains("zs-bar-fixed")) {
        bar.classList.remove("zs-bar-fixed");
        mount();
      }
    }

    function set({ tone, text, extra, startLabel, startDisabled, stopDisabled, dot }) {
      if (!els.state) return;
      bar.classList.toggle("tone-ok", tone === "ok");
      bar.classList.toggle("tone-warn", tone === "warn");
      bar.classList.toggle("tone-err", tone === "err");
      bar.classList.toggle("tone-busy", tone === "busy");
      els.state.textContent = text || "";
      els.extra.textContent = extra || "";
      if (startLabel != null) els.start.textContent = startLabel;
      if (startDisabled != null) els.start.disabled = !!startDisabled;
      if (stopDisabled != null) els.stop.disabled = !!stopDisabled;
      if (dot) els.dot.className = `zs-dot zs-dot-${dot}`;
    }

    function toast(msg, ms = 6000, kind = "") {
      if (!els.toast) return;
      els.toast.textContent = String(msg || "");
      els.toast.className = `zs-toast shown ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        els.toast.className = "zs-toast";
      }, ms);
    }

    function setBusyVisual(on) {
      bar.classList.toggle("zs-busy", !!on);
    }

    function render() {
      const settings = state.settings || {};
      const delay = `${fmtSec(settings.min_delay)}-${fmtSec(settings.max_delay)}s`;
      const provider = P.displayName || P.id;
      const extraBase = `${state.browser} · ${provider} · 延迟 ${delay}`;
      const editor = state.editorConnected
        ? `Godot 已连接 · ${state.editorCSharp ? "GDScript + C#" : "GDScript"}`
        : "Godot 未连接";
      setBusyVisual(state.busy || state.starting);

      if (state.controllerOnline === false) {
        set({
          tone: "err", dot: "err",
          text: "中转未运行 · 请先启动操控台",
          extra: extraBase,
          startLabel: "重试连接", startDisabled: false, stopDisabled: !state.busy,
        });
        return;
      }
      if (state.controllerOnline === null) {
        set({ tone: "warn", dot: "warn", text: "正在连接中转…", extra: extraBase, startDisabled: true, stopDisabled: true });
        return;
      }
      if (state.lastError) {
        set({ tone: "err", dot: "warn", text: state.lastError, extra: `${extraBase} · ${editor}`, startLabel: state.ready ? "已启动" : "启动", startDisabled: state.ready || state.starting, stopDisabled: !state.busy && !state.starting });
        return;
      }
      if (state.starting) {
        set({ tone: "busy", dot: "busy", text: "正在启动会话：发送系统提示…", extra: `${extraBase} · ${editor}`, startLabel: "启动中…", startDisabled: true, stopDisabled: false });
        return;
      }
      if (state.busy) {
        set({ tone: "busy", dot: "busy", text: `执行任务 ${state.taskId || ""}…`, extra: `${extraBase} · 回合 ${state.turns}`, startLabel: "已启动", startDisabled: true, stopDisabled: false });
        return;
      }
      if (state.ready) {
        set({ tone: "ok", dot: "ok", text: `已就绪 · 等待操控台派发任务`, extra: `${extraBase} · ${editor}`, startLabel: "已启动", startDisabled: true, stopDisabled: false });
        return;
      }
      set({
        tone: "warn", dot: "ok",
        text: "会话未启动 · 点击“启动”接入轮换",
        extra: `${extraBase} · ${editor}`,
        startLabel: "启动", startDisabled: false, stopDisabled: true,
      });
    }

    function fmtSec(v) {
      const n = Number(v || 0);
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    }

    return { build, mount, ensureMounted, set, toast, render, detectBrowser };
  })();

  // ════════════════════════════════════════════════════════════════════════
  //  CONNECTION / SESSION REGISTRATION
  // ════════════════════════════════════════════════════════════════════════
  function rememberSessionId() {
    try {
      let sid = sessionStorage.getItem(SID_KEY);
      if (!sid) {
        sid = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem(SID_KEY, sid);
      }
      state.sessionId = sid;
    } catch {
      state.sessionId = `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  async function connect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    if (!state.sessionId) rememberSessionId();
    if (!state.browserId || state.browserId === "unknown") {
      await ZSNet.init();
      state.browserId = ZSNet.getBrowserId();
      state.browser = ui.detectBrowser();
    }
    ui.render();
    const r = await ZSNet.api(
      "/api/session/register",
      {
        sessionId: state.sessionId,
        browser: state.browser,
        browserId: state.browserId,
        provider: P.id,
        displayName: P.displayName,
        label: `${state.browser} · ${P.displayName}`,
        pageUrl: location.href,
        conversation: safeConversationKey(),
        state: state.sessionState,
        version: ZSNet.getVersion(),
      },
      8000
    );
    if (r && r.ok) {
      state.controllerOnline = true;
      state.editorConnected = r.editor ? !!r.editor.connected : null;
      state.editorProject = r.editor ? r.editor.project || "" : "";
      state.editorWrite = r.editor && r.editor.write_enabled === false ? false : true;
      state.editorCSharp = r.editor && r.editor.csharp != null ? !!r.editor.csharp : null;
      state.editorDotnet = r.editor && r.editor.dotnet != null ? !!r.editor.dotnet : null;
      if (r.settings) state.settings = r.settings;
      if (Array.isArray(r.tools)) state.tools = r.tools;
      state.lastError = "";
      log("registered", state.sessionId);
      schedulePoll(150);
      ZSNet.badge(true, "");
      if (state.pendingStart && !state.ready && !state.starting) {
        state.pendingStart = false;
        setTimeout(startSession, 50);
      }
    } else {
      state.controllerOnline = false;
      state.lastError = "";
      state.sessionState = "registered";
      log("registration failed", r && r.error);
      scheduleReconnect(2000);
      ZSNet.badge(false, "!");
    }
    ui.render();
  }

  function safeConversationKey() {
    try {
      return P.conversationKey ? P.conversationKey() : "";
    } catch {
      return "";
    }
  }

  function scheduleReconnect(ms) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => connect(), ms);
  }

  function schedulePoll(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!state.sessionId) return;
    const r = await ZSNet.api(
      "/api/session/poll",
      {
        sessionId: state.sessionId,
        state: state.sessionState,
        provider: P.id,
        displayName: P.displayName,
        conversation: safeConversationKey(),
      },
      15000
    );
    if (!r || !r.ok) {
      state.controllerOnline = false;
      state.editorConnected = null;
      state.lastError = "";
      ui.render();
      ZSNet.badge(false, "!");
      scheduleReconnect(2500);
      return;
    }
    state.controllerOnline = true;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.editorConnected = r.editor ? !!r.editor.connected : state.editorConnected;
    state.editorProject = r.editor ? r.editor.project || state.editorProject : state.editorProject;
    if (r.editor && r.editor.write_enabled != null) state.editorWrite = r.editor.write_enabled !== false;
    if (r.editor && r.editor.csharp != null) state.editorCSharp = !!r.editor.csharp;
    if (r.editor && r.editor.dotnet != null) state.editorDotnet = !!r.editor.dotnet;
    if (r.settings) state.settings = r.settings;
    ZSNet.badge(true, "");
    if (r.stop) {
      // The console asked every tab to stop.
      state.abort = true;
      try {
        P.stopGeneration && P.stopGeneration();
      } catch {}
      if (!state.busy && !state.starting) resetAfterStop();
    }
    if (r.assign && !state.busy && !state.starting && state.ready) {
      runAssignment(r.assign);
    }
    ui.render();
    schedulePoll(state.busy ? 3000 : 1200);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION START / STOP
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (state.ready || state.starting || state.busy) return;
    if (state.controllerOnline === false) {
      state.pendingStart = true;
      await connect();
      return;
    }
    if (state.controllerOnline !== true) return;

    state.starting = true;
    state.abort = false;
    state.lastError = "";
    state.sessionState = "starting";
    ui.render();

    // Show the provider's known caveat once, without blocking.
    if (P.unstableWarning) ui.toast(`${P.displayName}: ${P.unstableWarning}`, 9000, "warn");

    try {
      if (P.captchaPresent && P.captchaPresent()) throw new Error("页面出现了验证码，请先在浏览器中完成验证。");
      if (P.overlayBlocking && P.overlayBlocking()) throw new Error("页面被弹窗/遮罩阻挡，请关闭后重试。");
      if (P.ensureComposerReady) {
        const mode = await P.ensureComposerReady("startup");
        if (mode && mode.ready === false) {
          throw new Error(P.modeWarning ? `${P.displayName} 模式未就绪：${P.modeWarning()}` : `${P.displayName} 模式未就绪，请新开对话或刷新页面。`);
        }
      } else if (P.enforceComposer) {
        P.enforceComposer();
      }

      if (!state.tools.length) {
        const t = await ZSNet.api("/api/tools", {}, 8000);
        if (t && t.ok && Array.isArray(t.tools)) state.tools = t.tools;
      }

      const prompt = ZS.systemPrompt({
        siteName: P.displayName,
        tools: state.tools,
        editor: {
          connected: state.editorConnected,
          project: state.editorProject,
          engine: "Godot 4.7.2",
          write_enabled: state.editorWrite,
          csharp: !!state.editorCSharp,
          dotnet: !!state.editorDotnet,
        },
        providerNotes: P.promptExtra || "",
        customPrompt: state.settings.custom_prompt || "",
      });

      // The prompt is a simulated input too: wait the configured random delay.
      const wait = ZS.randomDelay(state.settings.min_delay, state.settings.max_delay);
      if (!(await countdown(wait, `等待 ${(wait / 1000).toFixed(1)} 秒后发送系统提示`))) return;
      if (state.abort) return;

      const base = markTurnStart();
      await P.typeAndSend(prompt);
      state.sessionState = "busy";
      ui.set({ tone: "busy", dot: "busy", text: `${P.displayName} 正在阅读系统提示…`, extra: "启动会话" });
      const res = await waitForReply(base, "start");
      if (state.abort) return;

      if (res.kind === "text" && ZSParse.hasCommandShape(res.text)) {
        // It ignored "reply READY". Nudge once, then accept the session anyway.
        const wait2 = ZS.randomDelay(state.settings.min_delay, state.settings.max_delay);
        if (!(await countdown(wait2, "等待发送启动纠正"))) return;
        const base2 = markTurnStart();
        await P.typeAndSend(
          "Do not run any command during startup. Reply with plain text: READY. " +
            "Wait for the first task; the controller will send it."
        );
        await waitForReply(base2, "start-ack");
      }
      if (state.abort) return;

      state.ready = true;
      state.starting = false;
      state.sessionState = "ready";
      state.startedAt = Date.now();
      ui.toast(`${P.displayName} 会话已接入轮换。在操控台添加任务即可。`, 6000, "ok");
      schedulePoll(50);
    } catch (e) {
      state.ready = false;
      state.lastError = String((e && e.message) || e).slice(0, 180);
      ui.toast(state.lastError, 9000, "err");
      log("start failed", e);
    } finally {
      state.starting = false;
      if (!state.ready && (state.sessionState === "starting" || state.sessionState === "busy")) {
        state.sessionState = "registered";
      }
      ui.render();
    }
  }

  function markTurnStart() {
    let count = 0;
    let id = null;
    let text = "";
    try {
      count = P.assistantCount ? P.assistantCount() : 0;
      id = P.lastAssistantId ? P.lastAssistantId() : null;
      const r = P.readAssistant ? P.readAssistant() : null;
      text = (r && r.reply) || "";
    } catch {}
    return { count, id, text, at: Date.now() };
  }

  function stopSession(reason) {
    state.abort = true;
    try {
      P.stopGeneration && P.stopGeneration();
    } catch {}
    state.ready = false;
    state.starting = false;
    state.busy = false;
    state.sessionState = "stopped";
    state.currentTurn = null;
    ui.render();
    // Always tell the controller, even when idle: otherwise it would keep
    // dispatching new turns to a tab the user has switched off.
    if (state.sessionId) {
      ZSNet.api("/api/session/stop", { sessionId: state.sessionId, reason }, 8000);
    }
    ui.toast("已停止。再次点击“启动”可重新接入。", 5000, "warn");
  }

  function resetAfterStop() {
    state.abort = false;
    state.busy = false;
    state.ready = false;
    state.starting = false;
    state.sessionState = "stopped";
    state.currentTurn = null;
    ui.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ASSIGNMENT EXECUTION
  // ════════════════════════════════════════════════════════════════════════
  async function runAssignment(assign) {
    if (state.busy || state.starting) return;
    state.busy = true;
    state.abort = false;
    state.currentTurn = assign;
    state.taskId = assign.taskId || null;
    state.sessionState = "busy";
    state.turns = assign.turnIndex || state.turns + 1;
    state.lastError = "";
    ui.render();

    const min = assign.minDelay != null ? assign.minDelay : state.settings.min_delay;
    const max = assign.maxDelay != null ? assign.maxDelay : state.settings.max_delay;
    const wait = ZS.randomDelay(min, max);

    try {
      if (P.captchaPresent && P.captchaPresent()) throw new Error("页面出现了验证码，任务已暂停。");
      const okWait = await countdown(wait, `等待 ${(wait / 1000).toFixed(1)} 秒后输入`);
      if (!okWait || state.abort) return await finishAborted(assign);

      const base = markTurnStart();
      await P.typeAndSend(assign.text);
      ui.set({ tone: "busy", dot: "busy", text: `${P.displayName} 正在思考…`, extra: `任务 ${state.taskId} · 回合 ${state.turns}` });

      const res = await waitForReply(base, assign.turnId);
      if (state.abort) return await finishAborted(assign);

      if (res.kind === "stopped") {
        await reportTurn(assign, { reply: res.text || "", error: "stopped", done: false });
        ui.toast("浏览器内检测到停止，任务已暂停。", 6000, "warn");
        return;
      }
      if (res.kind === "timeout" || res.kind === "empty") {
        const msg = res.kind === "timeout" ? "等待 AI 回复超时" : "AI 没有返回内容";
        await reportTurn(assign, { reply: res.text || "", error: msg, done: true });
        ui.toast(msg, 7000, "err");
        return;
      }

      const siteError = readSiteError();
      const calls = ZSParse.parseToolCalls(res.text);
      let command = null;
      let parseError = null;

      if (calls.length > 1) {
        parseError = "multiple";
      } else if (calls.length === 1) {
        command = { command: calls[0].tool, params: calls[0].arguments || {} };
      } else {
        parseError = ZSParse.diagnose(res.text);
        // A reply cut off by an output limit can still hold a complete command
        // with only the closing braces missing. Recover it when provable.
        if (parseError === "unclosed" || parseError === "malformed") {
          const salvaged = ZSParse.salvageCutOff(res.text);
          if (salvaged) {
            command = { command: salvaged.tool, params: salvaged.arguments || {} };
            parseError = null;
          }
        }
      }

      if (command) {
        const mismatch = ZSParse.codeLanguageWarning(command, res.text);
        if (mismatch) {
          log("language mismatch", mismatch);
          ui.toast(mismatch, 9000, "warn");
        }
      }

      if (siteError && !command) {
        await reportTurn(assign, { reply: res.text || "", error: siteError, done: true });
        ui.toast(`站点提示：${siteError}`, 9000, "err");
        return;
      }

      const chip = showChip(
        res.item,
        command ? command.command : null,
        parseError ? "err" : command ? "run" : "done",
        parseError ? "格式错误" : command ? "执行中…" : "任务完成"
      );

      const feedback = parseError
        ? ZS.FEEDBACK.parseError(parseError, command ? command.command : ZSParse.toolNameFromText(res.text))
        : "";

      const report = await reportTurn(assign, {
        reply: res.text || "",
        command,
        parseError,
        feedback,
        done: !command && !parseError,
      });

      if (chip) {
        if (parseError) updateChip(chip, "err", "需要重写命令");
        else if (command) {
          if (report && report.ok && report.executed) {
            updateChip(chip, report.okResult === false ? "err" : "done",
              report.okResult === false ? "执行失败" : "完成");
          } else {
            updateChip(chip, report && report.ok ? "done" : "err", report && report.ok ? "已提交" : "未提交");
          }
        } else {
          updateChip(chip, "done", "任务完成");
        }
      }

      if (report && report.taskState === "paused") {
        ui.toast("操控台暂停了任务。", 6000, "warn");
      }
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 220);
      log("assignment failed", e);
      state.lastError = msg;
      ui.toast(msg, 9000, "err");
      await reportTurn(assign, { reply: "", error: msg, done: true });
    } finally {
      state.busy = false;
      state.currentTurn = null;
      state.abort = false;
      state.sessionState = state.ready ? "ready" : "stopped";
      state.lastError = "";
      ui.render();
      if (state.ready) schedulePoll(200);
      else schedulePoll(1500);
    }
  }

  async function finishAborted(assign) {
    if (assign) await reportTurn(assign, { reply: "", error: "stopped", done: false });
    state.busy = false;
    state.currentTurn = null;
    state.abort = false;
    state.sessionState = state.ready ? "ready" : "stopped";
    ui.render();
  }

  async function reportTurn(assign, payload) {
    const body = Object.assign(
      {
        sessionId: state.sessionId,
        turnId: assign.turnId,
        taskId: assign.taskId,
        provider: P.id,
        displayName: P.displayName,
        browser: state.browser,
        reply: ZS.clip(payload.reply || "", 30000),
        done: false,
      },
      payload
    );
    const r = await ZSNet.api("/api/session/report", body, 120000);
    if (!r || !r.ok) {
      state.lastError = (r && r.error) || "上报失败";
      ui.toast(`上报失败：${state.lastError}`, 8000, "err");
    }
    return r;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER
  // ════════════════════════════════════════════════════════════════════════
  async function waitForReply(base) {
    const t0 = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    let sawNew = false;
    let lastKind = "";

    while (Date.now() - t0 < (T.RESPONSE_TIMEOUT_MS || 300000)) {
      if (state.abort) return { kind: "stopped", text: lastText, item: null };

      let r = { present: false, reply: "", item: null };
      try {
        r = P.readAssistant() || r;
      } catch {}
      const text = String(r.reply || "").trim();

      let fresh = false;
      let gen = false;
      try {
        const count = P.assistantCount ? P.assistantCount() : 0;
        const id = P.lastAssistantId ? P.lastAssistantId() : null;
        if (base.id && id) fresh = id !== base.id;
        else if (base.count != null) fresh = count > base.count;
        fresh = fresh || (!!text && text !== base.text && Date.now() - t0 > 1200);
        gen = P.isGenerating ? !!P.isGenerating() : false;
      } catch {}

      if (fresh) sawNew = true;
      if (sawNew && text) {
        if (text !== lastText) {
          lastText = text;
          lastChange = Date.now();
        }
        const idle = Date.now() - lastChange;
        const open = ZSParse.hasOpenToolBlock(text);
        if (!gen && !open && idle >= Math.min(T.GEN_IDLE_MS || 1000, 2500)) {
          return { kind: "text", text, item: r.item };
        }
        if (gen && !open && idle >= (T.STABLE_MS || 12000)) {
          // The site's "generating" flag is stuck but the text is frozen.
          return { kind: "text", text, item: r.item };
        }
      }

      if (!sawNew && Date.now() - t0 > (T.WARMUP_MS || 45000)) {
        return { kind: "empty", text: "", item: null };
      }

      // Truncation: click the site's "Continue" control and keep waiting.
      try {
        if (sawNew && P.findContinueBtn && P.findContinueBtn() && Date.now() - lastChange > 2500) {
          P.clickContinueBtn && P.clickContinueBtn();
          lastChange = Date.now();
        }
      } catch {}

      if (P.turnHalted && P.turnHalted() && Date.now() - t0 > 1500) {
        return { kind: "stopped", text: lastText, item: r.item };
      }

      const kind = P.isGenerating ? "gen" : "idle";
      if (kind !== lastKind) lastKind = kind;
      await sleep(400);
    }
    return { kind: "timeout", text: lastText, item: null };
  }

  function readSiteError() {
    try {
      if (!P.scanError) return "";
      const e = P.scanError();
      if (!e) return "";
      if (typeof e === "string") return e;
      return e.text || e.reason || e.message || "";
    } catch {
      return "";
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CHIPS (small in-conversation status pill)
  // ════════════════════════════════════════════════════════════════════════
  function showChip(item, tool, kind, detail) {
    if (!item) return null;
    try {
      const chip = document.createElement("div");
      chip.className = `zs-chip zs-chip-${kind}`;
      chip.innerHTML =
        `<span class="zs-chip-head"><span class="zs-chip-ic">${iconFor(tool)}</span>` +
        `<span class="zs-chip-tx">${escapeHtml(tool || "NonZeroScript")}</span></span>` +
        `<span class="zs-chip-dt">${escapeHtml(detail || "")}</span>`;
      let spot = null;
      try {
        spot = P.findToolBlockSpot ? P.findToolBlockSpot(item, chip) : null;
      } catch {}
      if (spot && spot.parent) {
        spot.parent.insertBefore(chip, spot.ref || null);
      } else {
        item.appendChild(chip);
      }
      return chip;
    } catch (e) {
      log("chip failed", e);
      return null;
    }
  }

  function updateChip(chip, kind, text) {
    if (!chip) return;
    chip.className = `zs-chip zs-chip-${kind}`;
    const d = chip.querySelector(".zs-chip-dt");
    if (d) d.textContent = text || "";
  }

  function iconFor(tool) {
    const cat = ZS.toolCategory(tool || "");
    const icons = {
      read: "◈",
      edit: "✎",
      scene: "▣",
      run: "▶",
      tool: "◆",
    };
    return icons[cat] || "◆";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════════════════════
  async function countdown(ms, label) {
    const t0 = Date.now();
    while (true) {
      if (state.abort) return false;
      const left = ms - (Date.now() - t0);
      if (left <= 0) break;
      ui.set({
        tone: "busy", dot: "busy",
        text: `${label} · ${(left / 1000).toFixed(1)}s`,
        extra: state.currentTurn ? `任务 ${state.taskId || ""} · 回合 ${state.turns}` : "启动会话",
      });
      await sleep(Math.min(200, left));
    }
    return !state.abort;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════════════
  async function boot() {
    rememberSessionId();
    ui.build();
    ui.render();
    P.init && P.init({ diag: (ev, data) => log(ev, data || "") });
    await ZSNet.init();
    state.browserId = ZSNet.getBrowserId();
    state.browser = ui.detectBrowser();
    // The popup asks the page for its live state and can reload a stale tab.
    chrome.runtime.onMessage?.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === "nzs-reload") {
        location.reload();
        return false;
      }
      if (msg.type === "nzs-status") {
        sendResponse({
          ok: true,
          provider: P.id,
          displayName: P.displayName,
          sessionId: state.sessionId,
          sessionState: state.sessionState,
          ready: state.ready,
          busy: state.busy,
          starting: state.starting,
          controllerOnline: state.controllerOnline,
          editorConnected: state.editorConnected,
          taskId: state.taskId,
          turns: state.turns,
          lastError: state.lastError,
        });
        return false;
      }
      return false;
    });
    await connect();

    // Keep the bar alive across SPA re-renders.
    state.mountTimer = setInterval(() => ui.ensureMounted(), 2500);

    // Best-effort detach. Must go through the background worker: a page-world
    // sendBeacon carries the chat site's Origin and the controller rejects
    // cross-origin calls by design.
    window.addEventListener("beforeunload", () => {
      try {
        ZSNet.api(`/api/session/close?session=${encodeURIComponent(state.sessionId || "")}`, {}, 2000);
      } catch {}
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.controllerOnline === false) connect();
    });

    log("NonZeroScript ready", P.id, state.sessionId);
  }

  boot();
})();
