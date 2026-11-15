// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - MV3 service worker.
//
// Owns the controller URL and browser identity, and performs every HTTP call to
// the local controller. Keeping fetches here avoids any https-page -> loopback
// ambiguity and gives the caller a guaranteed resolved response.
//
// Contract: every message ALWAYS gets a response object. The agent loop must
// never hang on a dead controller.

const DEFAULT_API = "http://127.0.0.1:8790";
const VERSION = chrome.runtime.getManifest().version;

let apiBase = DEFAULT_API;
let browserId = null;

const READY = new Promise((resolve) => {
  chrome.storage.local.get(["apiBase", "browserId"], (cfg) => {
    if (cfg && cfg.apiBase) apiBase = cfg.apiBase;
    if (cfg && cfg.browserId) browserId = cfg.browserId;
    if (!browserId) {
      browserId = (self.crypto && crypto.randomUUID && crypto.randomUUID()) || `b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      chrome.storage.local.set({ browserId });
    }
    resolve();
  });
});

function log(...a) {
  console.log("[nzs-bg]", ...a);
}

async function apiCall(path, body, timeoutMs) {
  await READY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs || 60000));
  try {
    const res = await fetch(apiBase.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${(text || "").slice(0, 300)}`, status: res.status };
    }
    if (!data || typeof data !== "object") return { ok: false, error: "controller returned a non-JSON response" };
    return data;
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "controller timeout" : String((e && e.message) || e);
    return { ok: false, error: msg, offline: true };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "getConfig") {
    READY.then(() => sendResponse({ ok: true, apiBase, browserId, version: VERSION }));
    return true;
  }

  if (msg.type === "setConfig") {
    const url = String(msg.apiBase || "").replace(/\/+$/, "");
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url)) {
      sendResponse({ ok: false, error: "only http://127.0.0.1:<port> is allowed" });
      return false;
    }
    apiBase = url;
    chrome.storage.local.set({ apiBase }, () => sendResponse({ ok: true, apiBase }));
    return true;
  }

  if (msg.type === "api") {
    apiCall(msg.path, msg.body, msg.timeoutMs).then(sendResponse);
    return true;
  }

  if (msg.type === "openConsole") {
    READY.then(() => {
      chrome.tabs.create({ url: apiBase.replace(/\/+$/, "") + "/" }).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
    });
    return true;
  }

  if (msg.type === "badge") {
    const ok = !!msg.ok;
    chrome.action.setBadgeText({ text: msg.text != null ? String(msg.text).slice(0, 4) : ok ? "" : "!" });
    chrome.action.setBadgeBackgroundColor({ color: ok ? "#22c55e" : "#9ca3af" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// First-run: point the user at the console.
chrome.runtime.onInstalled.addListener((details) => {
  log("installed", details.reason, VERSION);
  chrome.action.setBadgeText({ text: "" });
});

// Re-check the controller when the browser starts (best effort).
chrome.runtime.onStartup?.addListener(() => {
  apiCall("/api/status", {}, 5000).then((r) => {
    chrome.action.setBadgeBackgroundColor({ color: r.ok ? "#22c55e" : "#9ca3af" });
  });
});
