// content.js — runs on kimi.com. Drives the agentic loop in-page.
// Reads Kimi's DOM (textContent, render-independent), parses tool calls,
// asks background to execute them on the Roblox MCP, and feeds results back.
// Camouflages the system prompt ("Starting Up"), hides tool JSON (and its code
// header) behind animated chips, masks injected input, and exposes a Stop button.
// Kimi ALWAYS receives an output.
//
// K2.6 notes (validated live):
//  - One turn = one .chat-content-item (role class -user / -assistant).
//  - .segment-content-box is per-segment & re-rendered during streaming → unused.
//  - Completion is driven by the reliable "generating" flag
//    (.send-button-container gains class "stop" while streaming), NOT by text
//    stability — the virtualized list never lets text settle mid-stream.

(() => {
  "use strict";
  const S = ZS.SELECTORS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[zeroscript]", ...a);

  // Ko-fi tip link. ⚠️ Replace "zeroscript" with your real Ko-fi username.
  const KOFI_URL = "https://ko-fi.com/zeroscript";
  // Roblox "tip" Game Passes — the native currency for the audience.
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

  // Text of an item for signature detection. For assistant turns we use ONLY
  // the non-thinking markdown, so tool blocks that Kimi merely drafts inside its
  // <thinking> are never detected, shown as "running", or executed.
  function itemText(item) {
    if (item.classList.contains("chat-content-item-assistant")) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DOM PRIMITIVES
  // ════════════════════════════════════════════════════════════════════════
  const assistantCount = () => document.querySelectorAll(S.assistant).length;
  const userCount = () => document.querySelectorAll(S.user).length;
  const getEditor = () => document.querySelector(S.editor);
  const isGenerating = () => !!document.querySelector(S.generating);
  const lastAssistant = () => {
    const it = document.querySelectorAll(S.assistant);
    return it.length ? it[it.length - 1] : null;
  };

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const th = item.querySelector(`${S.thinking} ${S.markdown}`);
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: th ? th.textContent.trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Kimi input box not found");
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false, null);
    // Kimi's editor reports textContent === "" right after a *successful* insert,
    // so we trust execCommand's return value; submitAndGetBase verifies + retries.
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
    await sleep(120);
    pressEnter(editor);
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  function clickSendButton() {
    const cands = [...document.querySelectorAll(".send-button-container")].filter(
      (b) => !b.classList.contains("disabled")
    );
    if (cands.length) {
      cands[cands.length - 1].click();
      return true;
    }
    return false;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  async function submitAndGetBase(text) {
    A.injecting = true;
    ui.inputCover(true);
    try {
      const base = assistantCount();
      const preUser = userCount();
      const landed = () => userCount() > preUser || isGenerating();
      await typeAndSend(text);
      if (!(await waitFor(landed, 3500))) {
        clickSendButton();
        if (!(await waitFor(landed, 3500))) {
          await typeAndSend(text);
          await waitFor(landed, 4000);
        }
      }
      return base;
    } finally {
      ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ERROR / LIMIT DETECTION
  // ════════════════════════════════════════════════════════════════════════
  function scanContextLimit(d) {
    if (d.reply && ZS.RE.contextLimit.test(d.reply)) return d.reply.slice(0, 240);
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && ZS.RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL PARSING  (validated against live K2.6 rendering)
  // ════════════════════════════════════════════════════════════════════════
  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const LUA_START = "###LUA###";
  const LUA_START_ALT = "###LUA---"; // Kimi sometimes writes --- instead of ###
  const LUA_END = "###END_LUA###";

  // Find the first LUA start marker (either variant) at or after `from`.
  // Returns { pos, len } where len is the marker's own length to skip past it.
  function findLuaStart(text, from = 0) {
    const p1 = text.indexOf(LUA_START, from);
    const p2 = text.indexOf(LUA_START_ALT, from);
    if (p1 === -1 && p2 === -1) return { pos: -1, len: 0 };
    if (p1 === -1) return { pos: p2, len: LUA_START_ALT.length };
    if (p2 === -1) return { pos: p1, len: LUA_START.length };
    return p1 <= p2 ? { pos: p1, len: LUA_START.length } : { pos: p2, len: LUA_START_ALT.length };
  }

  function hasToolSignature(r) {
    return (
      r.includes(START_M) ||
      r.includes("MCP_TOOL") ||
      r.includes(LUA_START) ||
      r.includes(LUA_START_ALT) ||
      (r.includes('"tool"') && r.includes('"arguments"'))
    );
  }

  function extractJson(raw) {
    raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    try {
      return JSON.parse(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  function extractToolAnywhere(text) {
    let pos = 0;
    while (true) {
      const s = text.indexOf('"tool"', pos);
      if (s === -1) break;
      const start = text.lastIndexOf("{", s);
      if (start === -1) { pos = s + 1; continue; }
      let depth = 0, end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) { pos = s + 1; continue; }
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (typeof obj.tool === "string" && typeof obj.arguments === "object") return obj;
      } catch {}
      pos = s + 1;
    }
    return null;
  }

  function parseToolCalls(r) {
    // Lowercase for case-insensitive end-marker search.
    // Kimi writes: ###end_mcp_tool### (underscore) or ###end-mcp_tool### (dash).
    const rLow = r.toLowerCase();
    const findEndM = (from) => {
      const a = rLow.indexOf("###end_mcp_tool###", from);
      const b = rLow.indexOf("###end-mcp_tool###", from);
      if (a === -1 && b === -1) return -1;
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    };
    const out = [];
    let from = 0;
    while (true) {
      const sm = r.indexOf(START_M, from);
      if (sm === -1) break;
      const em = findEndM(sm);
      if (em === -1) break;
      const body = r.slice(sm + START_M.length, em);
      const { pos: ls, len: luaLen } = findLuaStart(body);
      const le = body.indexOf(LUA_END);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: body.slice(ls + luaLen, le).trim() } });
        from = em + END_M.length;
        continue;
      }
      for (const sub of body.split(START_M)) {
        const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
        if (!cleaned) continue;
        const p = extractJson(cleaned);
        if (p) out.push(p);
      }
      from = em + END_M.length;
    }
    if (out.length === 0) {
      const { pos: ls, len: luaLen } = findLuaStart(r);
      const le = r.indexOf(LUA_END);
      if (ls !== -1 && le !== -1 && le > ls) {
        out.push({ tool: "execute_luau", arguments: { code: r.slice(ls + luaLen, le).trim() } });
      }
    }
    if (out.length === 0) {
      const f = extractToolAnywhere(r);
      if (f) out.push(f);
    }
    return out;
  }

  function toolNameFromText(txt) {
    const m = txt.match(/"tool"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    if (txt.includes("execute_luau") || txt.includes(LUA_START) || txt.includes(LUA_START_ALT)) return "execute_luau";
    return "tool";
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven — robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    const TIMEOUT = 300000;
    const STABLE_MS = 9000; // generating-flag stuck ON but text frozen → treat as done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now();

    while (Date.now() - t0 < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      const gen = isGenerating();
      const d = readAssistant();
      const newReply = assistantCount() > base;

      if (!started) {
        if (newReply) started = true;
        else {
          if (Date.now() - t0 > 45000) return { kind: gen ? "timeout" : "empty" };
          await sleep(150);
          continue;
        }
      }

      // Track text stability (independent of the generating flag).
      if (d.reply !== lastText) { lastText = d.reply; lastChangeAt = Date.now(); }

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = scanContextLimit(d);
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      if (gen) {
        doneSince = 0;
        // Fallback: if Kimi's "generating" flag gets stuck but the text has not
        // changed for a while and we already have content, stop waiting blindly.
        if (d.reply && Date.now() - lastChangeAt > STABLE_MS) {
          log("generating flag stuck — falling back to text stability");
        } else {
          await sleep(160);
          continue;
        }
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 1100) {
        await sleep(120);
        continue;
      }

      const r = d.reply;
      if (ZS.RE.tooLong.test(r)) return { kind: "too_long" };
      if (hasToolSignature(r)) {
        const calls = parseToolCalls(r);
        if (calls.length) return { kind: "tool", calls, item: d.item };
        // Only fire parse_error if explicit markers were present — not just
        // "tool"/"arguments" keywords mentioned in an explanation.
        if (r.includes(START_M) || r.includes(LUA_START) || r.includes(LUA_START_ALT)) return { kind: "parse_error", raw: r };
      }
      if (ZS.RE.busy.test(r)) return { kind: "busy" };
      if (r === "") return { kind: "empty" };
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for Kimi)
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

  async function ensureTools() {
    const r = await bg({ type: "list_tools" });
    if (r && r.tools && r.tools.length) {
      A.toolList = r.tools;
      A.toolNames = new Set(r.tools.map((t) => t.name));
    }
    return A.toolList;
  }

  // ── Send images (Studio captures) to Kimi, which is multimodal ───────────
  // Kimi accepts pasted images: we synthesise a paste event carrying the
  // file(s) onto its editor, then wait for the upload to settle so the
  // attachment rides along with the feedback message we send next.
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }

  const attachThumbs = () =>
    [...document.querySelectorAll(`${S.attachArea} ${S.imageThumb}`)];

  // Remove any pending attachments from the composer (used to clean up a
  // failed/errored upload so the feedback message still sends as clean text).
  function clearAttachments() {
    document.querySelectorAll(`${S.attachArea} .image-delete-icon, ${S.attachArea} .image-delete-container`)
      .forEach((d) => ["mouseover", "mousedown", "mouseup", "click"]
        .forEach((t) => { try { d.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch {} }));
  }

  async function attachImagesToKimi(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const want = attachThumbs().length + images.length;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // Wait until every thumbnail has settled (success/error), not still loading.
    const settled = await waitFor(() => {
      const t = attachThumbs();
      return t.length >= want && t.every((x) => /success|error/.test(x.className));
    }, 25000);
    if (!settled) return false;
    return !attachThumbs().some((x) => /error/.test(x.className));
  }

  async function runTool(call) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return ZS.FEEDBACK.parseError;
    // Virtual tool: list all available MCP tools with full parameter details.
    if (name === "list_tools") {
      await ensureTools();
      if (!A.toolList.length) return "No tools available — the bridge or Roblox Studio may be offline.";
      const lines = A.toolList.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        const params = Object.entries(props)
          .map(([k, v]) => `    ${k}${req.has(k) ? "" : "?"}: ${v.type || "any"}${v.description ? " — " + v.description : ""}`)
          .join("\n");
        return `${t.name}: ${(t.description || "").split("\n")[0]}${params ? "\n" + params : ""}`;
      });
      return `Output of 'list_tools':\nAvailable tools (${A.toolList.length}):\n\n${lines.join("\n\n")}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name)) {
      return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers (SW crash,
    // chrome.runtime hiccup), the loop gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    const r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout }), hardCap]);
    if (!r) return ZS.FEEDBACK.bridgeOffline;
    if (r.ok) {
      if (r.images && r.images.length) {
        ui.showImages(r.images, name);
        let attached = false;
        try { attached = await attachImagesToKimi(r.images); } catch (e) { log("attach failed", e); }
        if (!attached) { try { clearAttachments(); } catch {} } // drop a broken upload
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return attached
          ? `Output of '${name}':\n${caption}\n(The image is attached to THIS message — you can see it directly. Analyse it and continue.)`
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
        ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) — never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
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
    let emptyRetried = false;
    ui.showStop(true);
    try {
      while (!A.stop) {
        const res = await waitForResponse(base);
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", "Kimi reached its context limit",
            (res.detail || "") + "  —  click “New session” to start fresh.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "Conversation too long",
            "Kimi reports the conversation is getting too long. Start a new session.");
          break;
        }
        if (res.kind === "timeout") {
          ui.banner("warn", "No response from Kimi",
            "Kimi did not respond in time. The loop has stopped.");
          break;
        }
        if (res.kind === "busy") {
          ui.toast("Kimi is busy — retrying in 4s…");
          await sleep(4000);
          base = await submitAndGetBase(ZS.FEEDBACK.continue);
          continue;
        }
        if (res.kind === "empty") {
          if (!emptyRetried) {
            emptyRetried = true;
            ui.toast("Empty response — retrying…");
            base = await submitAndGetBase(ZS.FEEDBACK.emptyRetry);
            continue;
          }
          ui.banner("limit", "Repeated empty responses",
            "Kimi keeps returning empty responses — often a sign of a context limit. Start a new session.");
          break;
        }
        emptyRetried = false;

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
          const feedback = await runTool(call);
          A.toolRunning = false;
          if (A.stop) break;
          const isErr = feedback.startsWith("ERROR");
          decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
            true, feedback.replace(/^Output of '[^']*':\n?/, ""), category);
          base = await submitAndGetBase(feedback);
        }
      }
    } catch (e) {
      ui.banner("warn", "Internal loop error", String((e && e.message) || e));
    } finally {
      A.running = false;
      A.stop = false;
      A.toolRunning = false;
      ui.showStop(false);
    }
  }

  function stopLoop() {
    A.stop = true;
    const b = document.querySelector(S.stopBtn);
    if (b) try { b.click(); } catch {}
    ui.toast("Loop stopped.");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession() {
    if (A.running || A.starting) return;
    A.starting = true;
    ui.setStarting(true);
    try {
      await ensureTools();
      if (!A.toolList.length) {
        ui.banner("warn", "Bridge or Studio offline",
          "Could not fetch Roblox tools. Start the ZeroScript bridge and make sure Roblox Studio is open, then try again.");
        return;
      }
      const prompt = ZS.buildSystemPrompt(A.toolList);
      const base = await submitAndGetBase(prompt);
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      // If Kimi calls list_tools as instructed, run it and wait for the "ready" reply.
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 && startRes.calls[0].tool === "list_tools") {
        decorate.toolBox(startRes.item, "Loading tools", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        decorate.toolBox(startRes.item, "Loading tools", "done", `${A.toolList.length} tools`, true);
        const base2 = await submitAndGetBase(toolFeedback);
        await waitForResponse(base2); // wait for "I'm ready" reply
      }
      A.started = true;
      ui.setStarted(true);
      ui.toast("Agent ready. Ask Kimi to build something in Roblox.");
    } catch (e) {
      ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      A.starting = false;
      ui.setStarting(false);
      decorate.sweep(); // flip the chip from animated → settled
    }
  }

  // Explicit "New session" — only meaningful once a session already exists.
  // Guards against the #1 confusion: re-injecting the system prompt by accident.
  function newSessionClick() {
    if (A.running || A.starting) {
      ui.toast("Please wait — ZeroScript is busy.");
      return;
    }
    if (A.started) {
      const ok = window.confirm(
        "A ZeroScript session is already active in this chat.\n\n" +
        "Start a NEW session anyway? (only do this if Kimi seems confused or after a context limit)"
      );
      if (!ok) return;
    }
    startSession();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  USER-TURN DETECTION
  // ════════════════════════════════════════════════════════════════════════
  function hookUserSend() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        const text = editor.textContent.trim();
        if (text === "") return;

        if (A.injecting || A.running || A.starting) return;

        // First message of the session → auto-start, then run the loop.
        if (!A.started) {
          e.preventDefault();
          e.stopImmediatePropagation();
          (async () => {
            await startSession();
            if (!A.started) return;
            const base = await submitAndGetBase(text);
            agentLoop(base);
          })();
          return;
        }

        const base = assistantCount();
        setTimeout(() => { if (!A.running) agentLoop(base); }, 300);
      },
      true
    );

    // The keydown hook only catches Enter inside the editor. Users also send
    // by CLICKING the send button (mouse) — handle that path too so the loop
    // always runs (and the session auto-starts on the very first message).
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        const btn = t && t.closest && t.closest(".send-button-container");
        if (!btn || btn.classList.contains("stop") || btn.classList.contains("disabled")) return;
        if (A.injecting || A.running || A.starting) return;
        if (!A.started) {
          const editor = getEditor();
          const text = editor ? editor.textContent.trim() : "";
          if (!text) return;
          (async () => {
            await startSession();
            if (!A.started) return;
            const base = await submitAndGetBase(text);
            agentLoop(base);
          })();
          return;
        }
        const base = assistantCount();
        setTimeout(() => { if (!A.running) agentLoop(base); }, 300);
      },
      true
    );
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
  //  CAMOUFLAGE / DECORATION  (operates on .chat-content-item)
  //  Chips are real "tool cards": header (icon/label/detail) + an expandable
  //  body (real args / output), themed by tool category and execution state.
  // ════════════════════════════════════════════════════════════════════════
  const TOOL_MARKERS = ["###mcp_tool###", "###lua###", "###lua---",
    "###end_mcp_tool###", "###end-mcp_tool###", "###end_lua###"];

  const decorate = {
    // Hide the tool JSON/LUA paragraph(s) AND any surrounding code-block wrapper
    // (header bar + "Copy" + <pre>) so nothing of the raw call leaks through.
    // Returns where to insert the chip: {parent, ref} or null.
    _findToolEl(item, chip) {
      let parent = null, ref = null;
      const seen = new Set();
      const candidates = item.querySelectorAll(".paragraph, p, pre, code, [class*='code']");
      for (const el of candidates) {
        if (el === chip || (chip && el.contains(chip)) || (chip && chip.contains(el))) continue;
        const txt = el.textContent || "";
        const tLow = txt.toLowerCase();
        const isToolEl = TOOL_MARKERS.some((m) => tLow.includes(m)) ||
          /\{\s*"tool"\s*:/.test(txt);
        if (!isToolEl) continue;
        // Prefer hiding the whole code-block container if there is one, so the
        // language label / copy header disappears with the code.
        let hide = el;
        const wrap = el.closest("[class*='code']");
        if (wrap && item.contains(wrap) && wrap !== item) hide = wrap;
        if (seen.has(hide) || (chip && hide.contains(chip))) continue;
        seen.add(hide);
        hide.classList.add("zs-tool-hide");
        if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
      }
      return ref ? { parent, ref } : null;
    },

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
        if (!chip.parentElement) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        const spot = this._findToolEl(item, chip);
        if (spot) spot.parent.insertBefore(chip, spot.ref);
        else if (!chip.parentElement) item.insertBefore(chip, item.firstChild);
      }
      item.dataset.zs = cls || "1";
      return chip;
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
      if (item.dataset.zloop) return; // loop owns it
      const txt = itemText(item); // excludes thinking for assistant turns
      if (!txt) return;

      // System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zphase !== phase) {
          this.chip(item, { label: "Starting Up", category: "tool",
            phase: A.starting ? "run" : "sys", cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }
      // Tool-result turns we injected.
      if (
        /^\s*Output of '/.test(txt) ||
        /^\s*ERROR/.test(txt) ||
        txt.includes("System note: your previous response arrived empty")
      ) {
        if (!item.dataset.zs) {
          const m = txt.match(/Output of '([^']+)'/);
          const isErr = /^\s*ERROR/.test(txt);
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
        }
        return;
      }
      // Assistant tool-call turns → live loading while streaming, ✓ when done.
      if (txt.includes(START_M) || (txt.includes('"tool"') && txt.includes('"arguments"'))) {
        const live = item === lastAssistant() && (isGenerating() || A.running);
        const phase = live ? "run" : "done";
        if (item.dataset.zphase !== phase) this.toolBox(item, toolNameFromText(txt), phase, "", false);
        return;
      }
    },

    sweep() {
      for (const it of document.querySelectorAll(S.chatItem)) this.classify(it);
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, dot, stopBtn, cover, coverRaf, startBtn, hintEl, ctaEl, activeEl, stateEl;

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
          <div id="zs-cta">
            <button id="zs-start">▶  Start session</button>
            <div id="zs-hint">Click <b>Start</b>, then type what you want to build — Kimi will drive Roblox Studio for you.</div>
          </div>
          <div id="zs-active" hidden>
            <span class="zs-active-txt"><span class="zs-live-dot"></span>Session active — just type your request in Kimi</span>
            <button id="zs-new" title="Re-inject the system prompt (use after a context limit)">⟳ New session</button>
          </div>
          <button id="zs-stop" hidden>■ Stop</button>
        </div>
      `;
      document.documentElement.appendChild(root);
      dot = root.querySelector("#zs-dot");
      stopBtn = root.querySelector("#zs-stop");
      startBtn = root.querySelector("#zs-start");
      hintEl = root.querySelector("#zs-hint");
      ctaEl = root.querySelector("#zs-cta");
      activeEl = root.querySelector("#zs-active");
      stateEl = root.querySelector("#zs-state");
      startBtn.addEventListener("click", startSession);
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
      html += `<button class="zs-tip-opt zs-tip-kofi" data-u="${KOFI_URL}">☕ Ko-fi — any amount</button>`;
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

    // Toggle the onboarding CTA vs. the "session active" state.
    function setStarted(on) {
      if (!ctaEl) return;
      ctaEl.hidden = on;
      activeEl.hidden = !on;
    }

    function setStarting(on) {
      if (!startBtn) return;
      startBtn.disabled = on;
      startBtn.textContent = on ? "Starting…" : "▶  Start session";
    }

    function setStatus(s) {
      A.bridge = s;
      if (!dot) return;
      const servers = s.servers || [];
      const up = servers.filter((x) => x.alive).length;
      const ok = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
      dot.className = s.connected ? (ok ? "on" : "warn") : "off";
      let txt;
      if (!s.connected) txt = "Bridge offline — run the ZeroScript bridge";
      else if (!ok) txt = "Bridge OK — open Roblox Studio";
      else txt = `Connected · ${s.tools} Roblox tools ready`;
      stateEl.textContent = txt;
      // Gate the Start button on a usable bridge so the first click can't fail
      // silently — the hint explains what's missing.
      if (startBtn && !A.starting) {
        const ready = ok;
        startBtn.disabled = !ready;
        if (hintEl) {
          hintEl.innerHTML = ready
            ? `Click <b>Start</b>, then type what you want to build — Kimi will drive Roblox Studio for you.`
            : (!s.connected
                ? `⚠ Start the <b>ZeroScript bridge</b> on your PC first.`
                : `⚠ Open <b>Roblox Studio</b> so the tools become available.`);
        }
      }
    }

    function showStop(v) { if (stopBtn) stopBtn.hidden = !v; }

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
      const ed = getEditor();
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
        const e = getEditor();
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
      b.querySelector(".zs-banner-new").addEventListener("click", () => { b.remove(); startSession(); });
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
    return { setStatus, setStarted, setStarting, showStop, inputCover, toast, banner, showImages };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail (never on
  //    thinking or a plain answer). Updates text only, so the chip's spinner
  //    animation never restarts. ──────────────────────────────────────────────
  const TOKEN_CHARS = 4;
  let meterT0 = 0;

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    if (dt) dt.textContent = text;
  }

  setInterval(() => {
    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = ((Date.now() - A.toolStart) / 1000).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      meterT0 = 0;
      return;
    }
    // Kimi is streaming a tool call → token count + timer on its chip.
    if (isGenerating()) {
      const item = lastAssistant();
      const reply = item ? itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) — don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && hasToolSignature(reply)) {
        if (!meterT0) meterT0 = Date.now();
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round((Date.now() - meterT0) / 1000);
        setChipDetail(item, `~${tokens.toLocaleString()} tokens · ${s}s`);
        return;
      }
    }
    // Thinking, plain answer, or idle → no meter.
    meterT0 = 0;
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, tools: msg.tools, servers: msg.servers });
    }
  });

  bg({ type: "status" }).then((s) => s && ui.setStatus(s));
  setInterval(() => bg({ type: "status" }).then((s) => s && ui.setStatus(s)), 5000);

  // Session state is derived from the ACTUAL chat: a session is "active" only if
  // the system-prompt turn is present in the current conversation. Kimi is a SPA,
  // so switching to / opening a fresh chat must flip the panel back to "Start"
  // (the old code only ever latched started=true → every new chat looked active).
  // We never flip while busy, so an in-flight start/loop isn't disturbed.
  function syncSessionState() {
    if (A.starting || A.injecting || A.running) return;
    let has = false;
    for (const it of document.querySelectorAll(S.chatItem)) {
      if ((it.textContent || "").includes(ZS.SYS_MARKER)) { has = true; break; }
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  let sweepScheduled = false;
  const mo = new MutationObserver(() => {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => { sweepScheduled = false; syncSessionState(); decorate.sweep(); });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  syncSessionState();
  hookUserSend();

  // Auto-resume watchdog — the robust safety net that keeps the agentic loop
  // alive no matter how the user sent the message. If a finished assistant turn
  // contains a tool call the loop never picked up (loop had ended, message sent
  // by mouse, focus elsewhere…), resume it. Each turn is resumed at most once
  // (zResume marker) so a genuinely failing turn can't spin forever.
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (isGenerating()) return;
    const item = lastAssistant();
    if (!item || item.dataset.zloop || item.dataset.zResume) return;
    if (!hasToolSignature(itemText(item))) return;
    item.dataset.zResume = "1";
    agentLoop(assistantCount() - 1);
  }, 1000);

  log("ZeroScript content script ready (K2.6 detection)");
})();
