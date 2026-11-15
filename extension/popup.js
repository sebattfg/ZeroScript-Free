// SPDX-License-Identifier: GPL-3.0-or-later
// popup.js - status + controller address.

const $ = (id) => document.getElementById(id);

function bg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: "no response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function dot(el, kind) {
  el.className = `dot ${kind || ""}`.trim();
}

function setTabState(t) {
  if (!t) {
    dot($("tab-dot"), "warn");
    $("tab").textContent = "当前页不是 AI 聊天";
    return;
  }
  if (!t.ok) {
    dot($("tab-dot"), "warn");
    $("tab").textContent = "未加载（刷新页面）";
    return;
  }
  const map = {
    ready: ["ok", "已接入轮换"],
    busy: ["ok", "执行中"],
    starting: ["warn", "启动中"],
    registered: ["warn", "未启动"],
    stopped: ["warn", "已停止"],
  };
  const m = map[t.sessionState] || ["warn", t.sessionState];
  dot($("tab-dot"), m[0]);
  $("tab").textContent = `${t.displayName} · ${m[1]}`;
  if (t.taskId) {
    $("task-row").style.display = "";
    $("task").textContent = `${t.taskId.slice(0, 8)} · 回合 ${t.turns || 0}`;
  }
}

async function refresh() {
  const cfg = await bg({ type: "getConfig" });
  if (cfg && cfg.ok) {
    $("ver").textContent = `v${cfg.version}`;
    $("base").value = cfg.apiBase;
  }

  const st = await bg({ type: "api", path: "/api/status", body: {}, timeoutMs: 5000 });
  if (st && st.ok) {
    dot($("ctl-dot"), "ok");
    $("ctl").textContent = `运行中 :${st.port || ""}`;
    const ed = st.editor || {};
    if (ed.connected) {
      dot($("ed-dot"), "ok");
      $("ed").textContent = ed.project || "已连接";
    } else {
      dot($("ed-dot"), "warn");
      $("ed").textContent = "插件未连接";
    }
  } else {
    dot($("ctl-dot"), "err");
    $("ctl").textContent = "未启动";
    dot($("ed-dot"), "err");
    $("ed").textContent = "—";
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("no tab");
    chrome.tabs.sendMessage(tab.id, { type: "nzs-status" }, (t) => {
      if (chrome.runtime.lastError) setTabState(null);
      else setTabState(t);
    });
  } catch {
    setTabState(null);
  }
}

$("console").onclick = () => {
  bg({ type: "openConsole" });
  window.close();
};

$("save").onclick = async () => {
  const r = await bg({ type: "setConfig", apiBase: $("base").value.trim() });
  if (!r || !r.ok) {
    alert((r && r.error) || "保存失败");
    return;
  }
  refresh();
};

$("reload").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "nzs-reload" }, () => void chrome.runtime.lastError);
  } catch {}
  window.close();
};

refresh();
setInterval(refresh, 2000);
