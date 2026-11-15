// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen-net.js - Qwen network tap (runs in the MAIN world).
//
// WHY THIS EXISTS: Qwen renders assistant replies (and the fenced code blocks
// that carry ZeroScript commands) in a Monaco editor that DISPOSES off-screen
// blocks - collapsing them to their first line - and can drop the final complete
// frame for short/fast blocks. Reading the command back from the DOM is therefore
// unreliable (a `{"command":...}` becomes just `{`, a 50-line execute_luau becomes
// just `###LUA###`), which made the agent loop hang (opener with no closer) and
// fail to parse. The streamed API response, by contrast, carries the assistant's
// RAW markdown verbatim. This script taps it and republishes the reconstructed
// text so providers/qwen.js can read commands from a source Monaco can't corrupt.
//
// It wraps window.fetch in the PAGE world (a content script's isolated-world
// fetch wrap would not see the app's calls), accumulates the `answer`-phase delta
// content per streamed response, and publishes the latest response's full text +
// done flag into a DOM node (#zs-qwen-net, JSON textContent) that the isolated
// content script can read. Registered as a content script with "world": "MAIN",
// run_at "document_start" so the wrap is installed before Qwen's app uses fetch.
(() => {
  "use strict";
  if (window.__zsQwenNet) return;
  window.__zsQwenNet = true;

  const NODE_ID = "zs-qwen-net";
  const node = () => {
    let n = document.getElementById(NODE_ID);
    if (!n) {
      n = document.createElement("script");
      n.type = "application/json";
      n.id = NODE_ID;
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  };
  const publish = (obj) => { try { node().textContent = JSON.stringify(obj); } catch {} };

  // Parse the SSE lines we have so far, folding `answer`-phase content into `acc`.
  // Returns the updated accumulator { rid, text, done }.
  function foldLine(line, acc) {
    const s = line.trim();
    if (!s.startsWith("data:")) return acc;
    const js = s.slice(5).trim();
    if (!js || js === "[DONE]") { if (js === "[DONE]") acc.done = true; return acc; }
    let o;
    try { o = JSON.parse(js); } catch { return acc; }
    // A new response starts a fresh answer (reset text so we never mix two turns).
    const created = o["response.created"];
    if (created && created.response_id) { acc.rid = created.response_id; acc.text = ""; acc.done = false; }
    const d = o.choices && o.choices[0] && o.choices[0].delta;
    if (d) {
      if (d.phase === "answer" && typeof d.content === "string") acc.text += d.content;
      // Do NOT treat delta.status==="finished" as the turn's end. Qwen (fe 0.2.73)
      // now emits `status:"finished"` ~12s BEFORE the SSE stream actually closes,
      // and the rest of the answer (including a command's closing marker, e.g.
      // ###END_LUA###) keeps streaming afterwards. Trusting it flipped `done` early,
      // so the content script fired the still-incomplete command mid-stream and
      // injected a "Bad JSON / unclosed" feedback while Qwen was still writing.
      // The true end is the stream closing (`[DONE]`, or the reader ending in
      // consume(), which sets acc.done there) - rely on that instead.
    }
    return acc;
  }

  async function consume(resp) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const acc = { rid: null, text: "", done: false };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          foldLine(buf.slice(0, idx), acc);
          buf = buf.slice(idx + 1);
        }
        publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
      }
      if (buf) foldLine(buf, acc);
    } catch {}
    acc.done = true;
    publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = (args[0] && args[0].url) || args[0];
    const p = origFetch.apply(this, args);
    try {
      if (typeof url === "string" && /\/chat\/completions/i.test(url)) {
        p.then((res) => { try { if (res && res.body) consume(res.clone()); } catch {} });
      }
    } catch {}
    return p;
  };
})();
