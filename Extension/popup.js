// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

// ── Bridge token setup UI (issue #61) ───────────────────────────────────────
// The bridge prints a per-install token on its terminal at startup. The user
// pastes it here once; background.js stores it in chrome.storage.local and
// stamps it on every WebSocket message. The panel is shown when the
// connected bridge reports authRequired=true AND we don't have a token yet.
// Once a token is saved, the panel collapses to a one-line "Change token"
// link the user can expand to re-paste (cleared storage, copied wrong, etc.).
const tokenPanel  = document.getElementById("token-panel");
const tokenTitle  = document.getElementById("token-title");
const tokenHint   = document.getElementById("token-hint");
const tokenInput  = document.getElementById("token-input");
const tokenSave   = document.getElementById("token-save");
const tokenStatus = document.getElementById("token-status");
const tokenToggle = document.getElementById("token-toggle");

function renderTokenState(s) {
  const authRequired = !!s.authRequired;
  const hasToken = !!s.hasToken;
  const authJustSet = !!s.authJustSet;

  // Auto-handshake (1.5.6.3+): the bridge sent the token in the welcome
  // frame and background.js auto-stored it. Show a one-line confirmation
  // for ~2 seconds, then clear the flag (which dismisses this line on the
  // next status push). This is the only "first-run" UX for the new flow -
  // no paste panel, no ACTION NEEDED banner in the bridge terminal.
  if (authJustSet) {
    // Re-purpose the existing yellow panel as a green one-line status:
    // hide the input row, show only the title + hint. The CSS class
    // `token-ok` already exists for this (green border, green title).
    tokenPanel.classList.add("token-show", "token-ok");
    tokenTitle.textContent = "Bridge authenticated ✓";
    tokenHint.innerHTML = "The bridge auto-shared its token with the " +
      "extension on connect - no setup needed. You can run commands now.";
    tokenStatus.textContent = "";
    tokenStatus.className = "token-status";
    // Hide the input row inline - keep the CSS change local so we don't
    // disturb the manual fallback path (when authJustSet is false the
    // panel renders normally below).
    document.querySelector(".token-row").style.display = "none";
    tokenToggle.style.display = "none";
    // After ~2.5s, ask background to clear the flag. The next status
    // push then re-runs renderTokenState with authJustSet=false, which
    // collapses the panel naturally (because by then hasToken=true too).
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "clear_auth_just_set" }, () => refresh());
    }, 2500);
    return;
  }
  // Restore the input row visibility (it was hidden in the authJustSet
  // branch above; if we got here without going through it, this is a
  // no-op).
  document.querySelector(".token-row").style.display = "";

  // No bridge connected yet, or an old bridge that doesn't enforce a token:
  // don't pester the user with a setup panel they don't need.
  if (!s.connected || !authRequired) {
    tokenPanel.classList.remove("token-show", "token-ok");
    tokenToggle.style.display = "none";
    return;
  }

  if (hasToken) {
    // Token already on file: collapse to a single "Change token" link the
    // user can expand to re-paste. No need to take popup real estate with
    // the full panel once setup is done.
    tokenPanel.classList.remove("token-show");
    tokenToggle.style.display = "block";
    tokenToggle.textContent = "Change bridge token";
    tokenStatus.textContent = "";
    tokenStatus.className = "token-status";
    return;
  }

  // Bridge requires a token, we don't have one, and we did NOT just
  // auto-receive it: this is the manual fallback path. Only reached if
  // (a) the user is on 1.5.6.2 (bridge sends auth_required but no token in
  // the welcome frame), or (b) the bridge's welcome frame was missed and
  // no token has been auto-stored yet. Show the panel + the manual paste
  // instructions.
  tokenPanel.classList.add("token-show");
  tokenPanel.classList.remove("token-ok");
  tokenTitle.textContent = "Bridge token required";
  tokenHint.innerHTML =
    "The bridge normally auto-shares its token with the extension on " +
    "connect. If you see this, the auto-handshake didn't happen yet " +
    "(older bridge, or the connection dropped). Manual fallback: the " +
    "bridge prints a token on its terminal (look for the line starting " +
    "with <code>bridge token:</code>). Copy that value and paste it " +
    "below. You only do this once.";
  tokenToggle.style.display = "none";
  tokenStatus.textContent = "";
  tokenStatus.className = "token-status";
}

tokenToggle.addEventListener("click", () => {
  // Expand the panel for re-paste, even if a token is already saved.
  tokenPanel.classList.add("token-show");
  tokenPanel.classList.remove("token-ok");
  tokenTitle.textContent = "Change bridge token";
  tokenHint.innerHTML =
    "Paste the new token from the bridge's terminal (the line starting " +
    "with <code>bridge token:</code>) and click Save. The new token takes " +
    "effect immediately.";
  tokenToggle.style.display = "none";
  tokenInput.value = "";
  tokenInput.focus();
  tokenStatus.textContent = "";
  tokenStatus.className = "token-status";
});

tokenSave.addEventListener("click", () => {
  const t = (tokenInput.value || "").trim();
  if (!t) {
    tokenStatus.textContent = "Paste the token from the bridge's terminal first.";
    tokenStatus.className = "token-status err";
    return;
  }
  tokenSave.disabled = true;
  tokenStatus.textContent = "Saving…";
  tokenStatus.className = "token-status";
  chrome.runtime.sendMessage({ type: "set_token", token: t }, (r) => {
    tokenSave.disabled = false;
    if (r && r.ok) {
      tokenPanel.classList.add("token-ok");
      tokenTitle.textContent = "Bridge token saved";
      tokenStatus.textContent = "Saved. The agent can run commands now.";
      tokenStatus.className = "token-status ok";
      tokenInput.value = "";
      // refresh() will collapse the panel after the next status push.
      setTimeout(refresh, 400);
    } else {
      tokenStatus.textContent = (r && r.error) || "Could not save token.";
      tokenStatus.className = "token-status err";
    }
  });
});

tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); tokenSave.click(); }
});

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox Studio ready"
        : studioOff ? "Studio not connected · enable the MCP server in Studio"
        : "Bridge OK · open Roblox Studio")
    : "Bridge offline";
  tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py";
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
  // The token panel is driven by the same status push that drives the
  // rest of the popup - if the bridge goes away or an old bridge connects,
  // the panel hides itself automatically.
  renderTokenState(s);
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart Roblox server";
    setTimeout(refresh, 600);
  });
});
document.getElementById("kofi").addEventListener("click", () => {
  chrome.tabs.create({ url: KOFI_URL });
});
document.getElementById("settings").addEventListener("click", () => {
  // Same mechanism as the Ko-fi button (chrome.tabs), but tries the in-page
  // panel on an already-open supported AI tab first, so opening it doesn't
  // require a conversation to already be started there.
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
