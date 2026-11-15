// SPDX-License-Identifier: GPL-3.0-or-later
// core/net.js - talks to the local NonZeroScript controller.
//
// All requests go through the background service worker on purpose:
//  - one place owns the controller URL (the popup can change it),
//  - the service worker is an extension context, so http://127.0.0.1 is always
//    allowed even from an https chat page,
//  - a dead controller always resolves to {ok:false}, never a hung promise.
// eslint-disable-next-line no-unused-vars
const ZSNet = (() => {
  "use strict";

  let base = (typeof ZS !== "undefined" && ZS.DEFAULT_CONTROLLER) || "http://127.0.0.1:8790";
  let browserId = "unknown";
  let extVersion = "";

  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, extensionGone: true });
            return;
          }
          resolve(r || { ok: false, error: "no response from background" });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e), extensionGone: true });
      }
    });
  }

  async function init() {
    const c = await bg({ type: "getConfig" });
    if (c && c.ok) {
      base = c.apiBase || base;
      browserId = c.browserId || browserId;
      extVersion = c.version || "";
    }
    return c;
  }

  function api(path, body, timeoutMs) {
    return bg({ type: "api", path, body: body || {}, timeoutMs: timeoutMs || 60000 });
  }

  function getBase() {
    return base;
  }

  function getBrowserId() {
    return browserId;
  }

  function getVersion() {
    return extVersion;
  }

  async function setBase(url) {
    const clean = String(url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(clean)) return { ok: false, error: "只允许 http://127.0.0.1:端口" };
    base = clean;
    return bg({ type: "setConfig", apiBase: clean });
  }

  function openConsole() {
    return bg({ type: "openConsole" });
  }

  let _lastBadge = null;
  function badge(ok, text) {
    const key = `${ok ? 1 : 0}:${text || ""}`;
    if (key === _lastBadge) return Promise.resolve({ ok: true });
    _lastBadge = key;
    return bg({ type: "badge", ok, text });
  }

  chrome.storage?.onChanged?.addListener((changes) => {
    if (changes.apiBase && changes.apiBase.newValue) base = changes.apiBase.newValue;
  });

  return { init, api, getBase, setBase, getBrowserId, getVersion, openConsole, badge };
})();
