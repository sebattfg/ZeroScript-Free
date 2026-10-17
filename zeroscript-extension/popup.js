// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function parseToolText(response) {
  if (!response || !response.text) return null;
  try { return JSON.parse(response.text); } catch { return null; }
}

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const detail = document.getElementById("stateDetail");
  const list = Array.isArray(s.servers) ? s.servers : [];
  const up = list.filter((x) => x.alive).length;
  const ready = !!(s.connected && (s.mcpAlive || up > 0 || s.tools > 0));
  dot.className = "dot " + (s.connected ? (ready ? "on" : "warn") : "");
  state.textContent = !s.connected ? "Bridge offline" : ready ? "Local bridge connected" : "Bridge connected · waiting for tools";
  detail.textContent = s.connected ? `${s.tools || 0} tools loaded · ${up} MCP service(s) online` : "Start bridge.py or run start.bat";

  const workspace = s.workspace && typeof s.workspace === "object" ? s.workspace : null;
  if (workspace) {
    document.getElementById("workspaceRoot").textContent = workspace.root || "No valid folder is available.";
    const configured = workspace.configured === true;
    const badge = document.getElementById("workspaceBadge");
    badge.textContent = configured ? "Selected" : "Needs setup";
    badge.className = "badge" + (configured ? " ready" : "");
    document.getElementById("workspaceHint").textContent = configured
      ? "This folder is saved locally and will be reused on future starts. Change it at any time."
      : "No project folder has been confirmed. Pick a folder here or give the AI an absolute path when it asks.";
  } else if (!s.connected) {
    document.getElementById("workspaceRoot").textContent = "Bridge unavailable";
    document.getElementById("workspaceBadge").textContent = "Offline";
    document.getElementById("workspaceHint").textContent = "Connect the local bridge to read or change the selected folder.";
  }

  document.getElementById("toolCount").textContent = `${s.tools || 0}`;
  const roblox = list.find((x) => x.id === "roblox");
  const robloxStatus = document.getElementById("robloxStatus");
  const robloxBadge = document.getElementById("robloxBadge");
  if (!roblox) {
    robloxStatus.textContent = "Not configured · general coding tools work independently";
    robloxBadge.textContent = "Not configured";
    robloxBadge.className = "badge";
  } else if (!roblox.alive) {
    robloxStatus.textContent = "Configured, but its MCP process is offline";
    robloxBadge.textContent = "Offline";
    robloxBadge.className = "badge";
  } else if (s.studio === true) {
    robloxStatus.textContent = "Live Studio connection available";
    robloxBadge.textContent = "Connected";
    robloxBadge.className = "badge ready";
  } else if (s.studio === false) {
    robloxStatus.textContent = "MCP is running; connect Studio from Assistant Settings → MCP Servers";
    robloxBadge.textContent = "Waiting for Studio";
    robloxBadge.className = "badge";
  } else {
    robloxStatus.textContent = "MCP process is running; Studio state is unknown";
    robloxBadge.textContent = "Optional";
    robloxBadge.className = "badge";
  }

  const other = list.filter((x) => x.id !== "roblox");
  document.getElementById("servers").textContent = other.length
    ? `Other integrations · ${other.filter((x) => x.alive).length}/${other.length} online: ${other.map((x) => x.id).join(", ")}`
    : "Optional MCP integrations can be configured separately.";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => {
    if (chrome.runtime.lastError) {
      document.getElementById("state").textContent = "Bridge status unavailable";
      return;
    }
    if (s) render(s);
  });
}

document.getElementById("chooseWorkspace").addEventListener("click", () => {
  // Keep the picker in a persistent extension tab. Native dialogs can steal
  // focus from a toolbar popup and close its JavaScript context mid-selection.
  chrome.tabs.create({ url: chrome.runtime.getURL("workspace.html?openFolder=1") });
});

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    button.disabled = false;
    button.textContent = original;
    setTimeout(refresh, 900);
  });
});
document.getElementById("kofi").addEventListener("click", () => {
  chrome.tabs.create({ url: KOFI_URL });
});
document.getElementById("openExplorer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("workspace.html") });
});
document.getElementById("settings").addEventListener("click", () => {
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "zs-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
