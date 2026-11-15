// SPDX-License-Identifier: GPL-3.0-or-later
// app.js - the visual console. Vanilla JS, no build step; the poll interval
// follows the performance mode (400 ms turbo .. 2 s eco, see /api/status.perf).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    status: null,
    tools: [],
    logsSince: 0,
    memTask: "",
    memListSig: "",
    tick: 0,
    busy: false,
    lastRender: {},
    settingsLoaded: false,
  };

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const shortId = (id) => (id ? String(id).slice(0, 8) : "—");

  const timeOf = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(11, 19);
      return d.toLocaleTimeString("zh-CN", { hour12: false });
    } catch {
      return String(iso).slice(11, 19);
    }
  };

  function toast(msg, kind = "", ms = 4200) {
    const el = $("toast");
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.className = "toast";
    }, ms);
  }

  async function api(path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 65000);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
    } catch (e) {
      return { ok: false, error: e.name === "AbortError" ? "请求超时" : String(e.message || e) };
    } finally {
      clearTimeout(t);
    }
  }

  // ── pills ───────────────────────────────────────────────────────────────
  function renderPills(st) {
    $("ver").textContent = `v${st.version}`;
    $("port-pill").textContent = st.port;
    const ed = st.editor || {};
    const edPill = $("editor-pill");
    const edDot = $("pill-editor").querySelector(".dot");
    if (ed.connected) {
      edPill.textContent = ed.project || "已连接";
      edDot.className = "dot ok";
    } else {
      edPill.textContent = "未连接";
      edDot.className = "dot warn";
    }
    const ready = (st.sessions || []).filter((s) => s.ready).length;
    $("session-pill").textContent = `${ready} / ${(st.sessions || []).length}`;
    $("uptime").textContent = `控制器已运行 ${Math.floor((st.uptime || 0) / 60)} 分 ${(st.uptime || 0) % 60} 秒`;
    const perf = st.perf || {};
    const perfPill = $("perf-pill");
    if (perfPill) perfPill.textContent = perf.label || "均衡";
    const perfNote = $("perf-mode-note");
    if (perfNote) {
      perfNote.textContent = perf.rss_mb
        ? `${perf.label || ""} · 内存 ${perf.rss_mb} MB · 日志 ${perf.log_limit} 条`
        : (perf.label || "");
    }
    const rss = $("rss");
    if (rss) rss.textContent = perf.rss_mb ? `内存 ${perf.rss_mb} MB` : "";
  }

  // ── tasks ───────────────────────────────────────────────────────────────
  const TASK_LABEL = {
    queued: ["排队中", "warn"],
    running: ["运行中", "run"],
    waiting: ["等待会话", "warn"],
    done: ["完成", "ok"],
    paused: ["已暂停", "warn"],
    stopped: ["已停止", ""],
    error: ["出错", "err"],
  };

  function taskHtml(t) {
    const [label, cls] = TASK_LABEL[t.state] || [t.state, ""];
    const canPause = ["running", "waiting"].includes(t.state);
    return `
      <div class="task-item ${esc(t.state)}">
        <div class="t-head">
          <span class="badge ${cls}">${esc(label)}</span>
          <span class="t-prompt">${esc(t.prompt)}</span>
          ${canPause ? `<button class="danger small t-actions" data-pause="${esc(t.id)}">停止</button>` : ""}
        </div>
        <div class="t-meta">
          <span>#${esc(shortId(t.id))}</span>
          <span>回合 ${t.turns}</span>
          ${t.provider ? `<span>指定 ${esc(t.provider)}</span>` : `<span>任意 AI</span>`}
          ${t.rr ? `<span>轮换 ${t.rr}</span>` : ""}
          <span>${esc(timeOf(t.created))}</span>
          ${t.error ? `<span style="color:#fca5a5">${esc(t.error)}</span>` : ""}
        </div>
        ${t.last_reply ? `<div class="t-last">AI：${esc(t.last_reply)}</div>` : ""}
      </div>`;
  }

  function renderTasks(st) {
    const list = st.tasks || [];
    const html = list.length
      ? list.map(taskHtml).join("")
      : `<div class="empty-note">暂无任务。在上方输入目标后点“加入队列”。</div>`;
    if (html === state.lastRender.tasks) return;
    state.lastRender.tasks = html;
    $("tasks").innerHTML = html;
  }

  // ── sessions ────────────────────────────────────────────────────────────
  const SESSION_LABEL = {
    registered: ["未启动", "warn"],
    starting: ["启动中", "warn"],
    ready: ["就绪", "ok"],
    assigned: ["已派发", "run"],
    busy: ["忙碌", "run"],
    finishing: ["收尾", "run"],
    stopped: ["已停止", ""],
    offline: ["离线", "err"],
  };

  function sessionHtml(s) {
    const [label, cls] = SESSION_LABEL[s.state] || [s.state, ""];
    return `
      <div class="session ${esc(s.state)} ${s.ready ? "ready" : ""} ${s.alive ? "" : "offline"}">
        <div class="s-head">
          <span class="prov">${esc(s.display_name || s.provider)}</span>
          <span class="browser">${esc(s.browser)}</span>
          <span class="badge ${cls}">${esc(label)}</span>
          <label class="check" title="是否参与轮换">
            <input type="checkbox" data-toggle="${esc(s.id)}" ${s.enabled ? "checked" : ""} /> 轮换
          </label>
        </div>
        <div class="s-meta">
          <span>#${esc(s.short)}</span>
          <span>心跳 ${s.seen_ago}s 前</span>
          <span>回合 ${s.stats ? s.stats.turns : 0}</span>
          <span>命令 ${s.stats ? s.stats.commands : 0}</span>
          ${s.stats && s.stats.errors ? `<span style="color:#fca5a5">错误 ${s.stats.errors}</span>` : ""}
          ${s.version ? `<span>扩展 v${esc(s.version)}</span>` : ""}
        </div>
        ${s.task_id ? `<div class="s-task">任务 #${esc(shortId(s.task_id))} 正在此会话</div>` : ""}
        ${s.state !== "offline" ? `<button class="linkish" data-kick="${esc(s.id)}">移除会话</button>` : ""}
      </div>`;
  }

  function renderSessions(st) {
    const list = st.sessions || [];
    const rot = st.rotation || {};
    let rotText = "没有可轮换的会话";
    if (rot.active) rotText = `轮换中 · ${rot.eligible} 个浏览器`;
    else if (rot.eligible === 1) rotText = "单浏览器模式（再勾选一个即轮换）";
    $("sessions-note").textContent = list.length
      ? `${list.filter((s) => s.ready).length} 个就绪 · ${list.filter((s) => s.enabled).length} 个参与轮换 · ${rotText}`
      : "在 AI 页面点“启动”后会出现在这里";
    const html = list.length
      ? list.map(sessionHtml).join("")
      : `<div class="empty-note">暂无会话。安装浏览器扩展 → 打开 ChatGPT / DeepSeek 等 → 点页面上的“启动”。</div>`;
    if (html === state.lastRender.sessions) return;
    state.lastRender.sessions = html;
    $("sessions").innerHTML = html;
  }

  // ── editor ──────────────────────────────────────────────────────────────
  function renderEditor(st) {
    const ed = st.editor || {};
    const badge = $("editor-badge");
    badge.textContent = ed.connected ? "已连接" : "未连接";
    badge.className = `badge ${ed.connected ? "ok" : "err"}`;
    const rows = [
      ["状态", ed.connected ? `<span class="v ok">已连接 · 心跳 ${ed.seen_ago}s 前</span>` : `<span class="v off">未连接</span>`],
      ["项目", esc(ed.project || "—")],
      ["路径", esc(ed.project_path || "—")],
      ["引擎", esc(ed.engine || "Godot 4.7.2")],
      ["当前场景", esc(ed.open_scene || "—")],
      ["播放中", ed.playing ? "是" : "否"],
      ["脚本语言", ed.connected
        ? (ed.csharp ? `<span class="v ok">GDScript + C#</span>` : "GDScript（无 C#）")
        : "—"],
      ["允许写入", ed.write_enabled ? "是" : "否"],
      ["待执行", esc(ed.queue != null ? ed.queue : 0)],
    ];
    const html = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join("");
    if (html === state.lastRender.editor) return;
    state.lastRender.editor = html;
    $("editor").innerHTML = html;
    $("editor").className = "kv";
  }

  // ── settings ────────────────────────────────────────────────────────────
  function setValue(id, value) {
    const el = $(id);
    if (!el || document.activeElement === el) return;
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = value == null ? "" : value;
  }

  function fillSettings(st) {
    if (state.settingsLoaded) return;
    const s = st.settings || {};
    setValue("min-delay", s.min_delay);
    setValue("max-delay", s.max_delay);
    setValue("max-turns", s.max_turns);
    setValue("memory-entries", s.memory_context_entries);
    setValue("rotation", s.rotation);
    setValue("auto-start", s.auto_start_queue);
    setValue("custom-prompt", s.custom_prompt);
    setValue("perf-mode", s.perf_mode || "balanced");
    setValue("memory-keep", s.memory_keep_days == null ? 0 : s.memory_keep_days);
    state.settingsLoaded = true;
  }

  async function saveSettings() {
    const body = {
      min_delay: Number($("min-delay").value),
      max_delay: Number($("max-delay").value),
      max_turns: Number($("max-turns").value),
      memory_context_entries: Number($("memory-entries").value),
      rotation: $("rotation").checked,
      auto_start_queue: $("auto-start").checked,
      custom_prompt: $("custom-prompt").value,
      memory_keep_days: Number($("memory-keep").value || 0),
    };
    if (body.max_delay < body.min_delay) {
      toast("最大秒数必须大于或等于最小秒数", "err");
      return;
    }
    const r = await api("api/settings", body);
    if (r && r.ok) {
      state.settingsLoaded = false;
      fillSettings({ settings: r.settings });
      toast("设置已保存", "ok");
      refresh();
    } else {
      toast((r && r.error) || "保存失败", "err");
    }
  }

  // ── logs ────────────────────────────────────────────────────────────────
  async function loadLogs() {
    const r = await api(`api/logs?since=${state.logsSince}`).catch(() => null);
    if (!r || !r.ok) return;
    if (r.entries && r.entries.length) {
      const box = $("logs");
      const frag = document.createDocumentFragment();
      for (const e of r.entries) {
        const line = document.createElement("div");
        line.className = "log-line";
        const lv = String(e.level || "info").toLowerCase();
        line.innerHTML = `<span class="ts">${esc(String(e.ts || "").slice(11, 19))}</span>` +
          `<span class="lv ${esc(lv)}">${esc(lv)}</span>` +
          `<span class="msg"></span>`;
        line.querySelector(".msg").textContent = e.message || "";
        frag.appendChild(line);
      }
      box.appendChild(frag);
      while (box.children.length > 600) box.removeChild(box.firstChild);
      if ($("autoscroll").checked) box.scrollTop = box.scrollHeight;
    }
    state.logsSince = r.last || state.logsSince;
  }

  // ── memory ──────────────────────────────────────────────────────────────
  async function loadMemoryList() {
    const r = await api("api/memory", {}).catch(() => null);
    if (!r || !r.ok) return;
    const tasks = r.tasks || [];
    const sig = tasks.map((t) => t.file).join("|");
    if (sig !== state.memListSig) {
      state.memListSig = sig;
      const sel = $("mem-select");
      const prev = state.memTask || sel.value;
      sel.innerHTML =
        `<option value="">选择任务…</option>` +
        tasks
          .map((t) => `<option value="${esc(t.task_id)}">${esc((t.created || "").slice(11, 19))} · ${esc(t.prompt || "")}</option>`)
          .join("");
      if (prev && tasks.some((t) => t.task_id === prev)) sel.value = prev;
      else if (tasks.length) {
        sel.value = tasks[0].task_id;
        state.memTask = tasks[0].task_id;
      }
    }
    if (state.memTask) await loadMemory();
  }

  async function loadMemory() {
    const id = state.memTask;
    if (!id) {
      $("memory").className = "memory empty-note";
      $("memory").textContent = "选择一个任务查看时间线";
      return;
    }
    const r = await api(`api/memory?task=${encodeURIComponent(id)}&limit=300`, {}).catch(() => null);
    if (!r || !r.ok) return;
    const events = r.events || [];
    const box = $("memory");
    box.className = "memory";
    box.innerHTML = events
      .map((e) => {
        const kind = e.kind || "note";
        const bad = kind === "tool" && !e.ok;
        const cls = kind === "tool" ? `tool ${bad ? "err" : ""}` : kind;
        let body = e.text || "";
        let head = "";
        if (kind === "tool") {
          body = `${e.command || "?"} → ${e.ok ? "OK" : "ERROR"}${e.preview ? ` · ${e.preview}` : ""}`;
        }
        if (kind === "dispatch") head = `<span class="mem-kind">派发 · ${esc(e.label || "")}</span>`;
        else if (kind === "reply") head = `<span class="mem-kind">回复 · ${esc(e.label || "")}</span>`;
        else head = `<span class="mem-kind">${esc(kind)}</span>`;
        return `<div class="mem-item ${esc(cls)}">
          <div class="mem-head"><span class="mem-ts">${esc((e.ts || "").slice(11, 19))}</span>${head}</div>
          <div class="mem-body">${esc(String(body).slice(0, 900))}</div>
        </div>`;
      })
      .join("") || `<div class="empty-note">这个任务还没有时间线记录</div>`;
  }

  // ── test command ────────────────────────────────────────────────────────
  async function loadTools() {
    const r = await api("api/tools", {}).catch(() => null);
    if (!r || !r.ok) return;
    state.tools = r.tools || [];
    const sel = $("test-cmd");
    const prev = sel.value;
    sel.innerHTML = state.tools.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    if (prev && state.tools.some((t) => t.name === prev)) sel.value = prev;
    fillTestParams();
  }

  function fillTestParams() {
    const name = $("test-cmd").value;
    const tool = state.tools.find((t) => t.name === name);
    const params = tool ? tool.params || {} : {};
    const obj = {};
    for (const [k, v] of Object.entries(params)) {
      if (v && v.required) obj[k] = v.type === "boolean" ? false : v.type === "integer" ? 0 : "";
    }
    $("test-params").value = JSON.stringify(obj, null, 0);
  }

  async function runTest() {
    const command = $("test-cmd").value;
    if (!command) return;
    let params = {};
    try {
      params = JSON.parse($("test-params").value || "{}");
    } catch {
      toast("参数不是合法 JSON", "err");
      return;
    }
    $("test-out").textContent = "执行中…";
    const r = await api("api/execute", { command, params });
    $("test-out").textContent = r && r.ok ? r.text || "(no output)" : `ERROR: ${(r && r.error) || (r && r.text) || "failed"}`;
    refresh();
  }

  // ── task actions ────────────────────────────────────────────────────────
  async function addTask() {
    const prompt = $("prompt").value.trim();
    if (!prompt) {
      toast("请先写下任务目标", "warn");
      $("prompt").focus();
      return;
    }
    const r = await api("api/task/add", { prompt, provider: $("provider").value });
    if (r && r.ok) {
      $("prompt").value = "";
      toast(`任务 #${shortId(r.task.id)} 已加入队列`, "ok");
      refresh();
    } else {
      toast((r && r.error) || "添加失败", "err");
    }
  }

  async function stopAll() {
    if (!confirm("停止所有任务，并让所有浏览器会话中止当前回合？")) return;
    const r = await api("api/task/stop", {});
    toast(r && r.ok ? "已停止全部任务" : "停止失败", r && r.ok ? "warn" : "err");
    refresh();
  }

  // ── providers ───────────────────────────────────────────────────────────
  function fillProviders(st) {
    const sel = $("provider");
    if (sel.dataset.filled === "1") return;
    const providers = st.providers || [];
    sel.innerHTML =
      `<option value="">任意 AI（全部已启动会话）</option>` +
      providers.map((p) => `<option value="${esc(p.id)}">只派发给 ${esc(p.name)}</option>`).join("");
    sel.dataset.filled = "1";
  }

  // ── refresh loop ────────────────────────────────────────────────────────
  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    try {
      const st = await api("api/status", {});
      if (!st || !st.ok) {
        const dot = $("pill-controller").querySelector(".dot");
        if (dot) dot.className = "dot err";
        $("ver").textContent = "离线";
        return;
      }
      state.status = st;
      renderPills(st);
      fillProviders(st);
      fillSettings(st);
      renderTasks(st);
      renderSessions(st);
      renderEditor(st);
      await loadLogs();
      state.tick++;
      if (!state.tools.length) loadTools();
      if (state.tick === 1 || state.tick % 5 === 0) loadMemoryList();
    } finally {
      state.busy = false;
    }
  }

  // ── performance mode / bulk session toggles ─────────────────────────────
  async function applyPerf() {
    const mode = $("perf-mode").value;
    const r = await api("api/settings", {
      perf_mode: mode,
      memory_keep_days: Number($("memory-keep").value || 0),
    });
    if (!r || !r.ok) {
      toast((r && r.error) || "切换失败", "err");
      return;
    }
    state.settingsLoaded = false;
    fillSettings({ settings: r.settings });
    toast(`已切换到${mode === "eco" ? "极致性能" : mode === "turbo" ? "最快速度" : "均衡"}模式`, "ok");
    refresh();
  }

  async function setAllSessions(enabled) {
    const list = (state.status && state.status.sessions) || [];
    if (!list.length) {
      toast("还没有已连接的会话", "warn");
      return;
    }
    let n = 0;
    for (const s of list) {
      const r = await api("api/session/enable", { sessionId: s.id, enabled });
      if (r && r.ok) n++;
    }
    toast(`已${enabled ? "启用" : "停用"} ${n} 个会话的轮换`, "ok");
    refresh();
  }

  // ── events ──────────────────────────────────────────────────────────────
  $("add-task").addEventListener("click", addTask);
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addTask();
  });
  $("stop-all").addEventListener("click", stopAll);
  $("save-settings").addEventListener("click", saveSettings);
  $("apply-perf").addEventListener("click", applyPerf);
  $("sessions-all").addEventListener("click", () => setAllSessions(true));
  $("sessions-none").addEventListener("click", () => setAllSessions(false));
  $("test-run").addEventListener("click", runTest);
  $("test-cmd").addEventListener("change", fillTestParams);

  $("tasks").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pause]");
    if (!btn) return;
    const r = await api("api/task/pause", { taskId: btn.dataset.pause });
    toast(r && r.ok ? "任务已暂停" : (r && r.error) || "操作失败", r && r.ok ? "warn" : "err");
    refresh();
  });

  $("sessions").addEventListener("change", async (e) => {
    const box = e.target.closest("[data-toggle]");
    if (!box) return;
    const r = await api("api/session/enable", { sessionId: box.dataset.toggle, enabled: box.checked });
    if (!r || !r.ok) toast((r && r.error) || "切换失败", "err");
    refresh();
  });

  $("sessions").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-kick]");
    if (!btn) return;
    const r = await api("api/session/close", { session: btn.dataset.kick });
    if (r && r.ok) toast("会话已移除", "warn");
    refresh();
  });

  $("mem-select").addEventListener("change", (e) => {
    state.memTask = e.target.value;
    loadMemory();
  });

  $("open-godot").addEventListener("click", () => {
    alert(
      "在 Godot 中连接 NonZeroScript：\n\n" +
        "1. 把编辑器包解压出的 addons/nonzeroscript 放进项目根目录\n" +
        "2. 项目 → 项目设置 → 插件 → 启用 NonZeroScript\n" +
        "3. 右侧 NonZeroScript 面板确认中转地址为 " +
        (state.status ? `http://127.0.0.1:${state.status.port}` : "http://127.0.0.1:8790") +
        "\n4. 面板应显示“已连接”，本页 Godot 状态会变绿。"
    );
  });

  // The poll interval follows the performance mode.
  async function loop() {
    await refresh();
    const ms = (state.status && state.status.perf && state.status.perf.ui_refresh_ms) || 1200;
    setTimeout(loop, ms);
  }
  loop();
})();
