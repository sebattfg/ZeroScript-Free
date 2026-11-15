// SPDX-License-Identifier: GPL-3.0-or-later
// core/parser.js - NonZeroScript command parsing. PURE string logic, no DOM.
//
// The AI replies with ONE command per turn:
//
//   {"command": "read_file", "params": {"path": "res://player.gd"}}
//
// or, for a long script, a JSON envelope plus a code block whose language
// matches the file extension - GDScript:
//
//   {"command": "write_file", "params": {"path": "res://player.gd"}}
//   ###GDSCRIPT###
//   extends CharacterBody2D
//   ###END_GDSCRIPT###
//
// or C#:
//
//   {"command": "write_file", "params": {"path": "res://Player.cs"}}
//   ###CSHARP###
//   using Godot;
//   ###END_CSHARP###
//
// The markers are deliberately explicit: chat sites render fenced code blocks
// into DOM without the backticks, so ` ```gdscript ` is not reliable after the
// provider extracts text. Markers survive plain textContent.
//
// The exported names keep the historical `LUA_*` spelling because the provider
// adapters use them when they hide the raw command block behind a chip.
// eslint-disable-next-line no-unused-vars
const ZSParse = (() => {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";

  // Code blocks carry their language. GDScript keeps the legacy LUA aliases so
  // an old-habit model still parses; C# is a first-class alternative.
  //   ###GDSCRIPT### ... ###END_GDSCRIPT###   (.gd)
  //   ###CSHARP###   ... ###END_CSHARP###     (.cs, also ###C# ###)
  const LUA_START_RE = /###\s*(?:gdscript|gds|gd|csharp|c#|cs|dotnet|lua)\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?(?:gdscript|gds|gd|csharp|c#|cs|dotnet|lua)\s*###/i;
  const LUA_DEFAULT_DM = "Edit"; // kept for provider compatibility

  const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;
  const ANY_KEY_RE = /"(?:command|tool|name|functionName|function|action)"\s*:\s*"/;
  const DSML_RE = /<[\s/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;

  const PATH_RE = /(?:res|user):\/\/[A-Za-z0-9_\-./]+/g;

  function findLuaStart(text, from = 0) {
    const m = LUA_START_RE.exec(String(text || "").slice(from));
    return m ? { pos: from + m.index, len: m[0].length, dm: LUA_DEFAULT_DM } : { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }

  function findLuaEnd(text, from = 0) {
    const m = LUA_END_RE.exec(String(text || "").slice(from));
    return m ? from + m.index : -1;
  }

  // Strip a code-block UI label that some sites bleed into text ("Copy", "gd").
  function stripCodeChrome(code) {
    return String(code || "").replace(/^(?:json|copy|gdscript|gd|csharp|cs|c#)\s+/i, "");
  }

  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Tolerant JSON parser: handles trailing commas and raw newlines/tabs inside
  // strings (a model occasionally writes a multi-line script that way).
  function parseLoose(raw) {
    raw = String(raw || "").trim();
    if (!raw) throw new Error("empty");
    try {
      return JSON.parse(raw);
    } catch {}
    let out = "";
    let inStr = false, esc = false;
    for (const c of raw) {
      if (inStr) {
        if (esc) {
          out += c;
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          out += c;
          continue;
        }
        if (c === '"') {
          inStr = false;
          out += c;
          continue;
        }
        if (c === "\n") {
          out += "\\n";
          continue;
        }
        if (c === "\r") {
          out += "\\r";
          continue;
        }
        if (c === "\t") {
          out += "\\t";
          continue;
        }
        out += c;
        continue;
      }
      if (c === '"') inStr = true;
      out += c;
    }
    // Drop trailing commas before a closing brace/bracket (outside strings).
    out = out.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(out);
  }

  function extractJson(raw) {
    raw = String(raw || "").trim();
    raw = raw.replace(/^(?:json|JSON)\s*/, "");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const s = raw.indexOf("{");
    if (s === -1) return null;
    const e = matchBrace(raw, s);
    if (e === -1) return null;
    try {
      return parseLoose(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }

  // Models occasionally emit "Read File", "getNodeInfo" or a short synonym.
  // Normalise so the controller only ever sees catalogue names.
  const TOOL_ALIASES = {
    read: "read_file", write: "write_file", edit: "edit_file",
    create_file: "write_file", mkdir: "create_dir",
    list_dir: "list_files", ls: "list_files", dir: "list_files",
    search: "search_in_files", grep: "search_in_files",
    scene_tree: "get_scene_tree", tree: "get_scene_tree",
    get_node: "get_node_info", node_info: "get_node_info",
    add: "add_node", create_node: "add_node",
    remove: "remove_node", delete_node: "remove_node",
    set_property: "set_node_property", set_node_prop: "set_node_property",
    instantiate: "instantiate_scene", open: "open_scene", save: "save_scene",
    attach: "attach_script", set_script: "attach_script", add_script: "attach_script",
    attach_script_to_node: "attach_script",
    run: "run_project", play: "run_project", stop: "stop_project",
    settings: "get_project_settings", set_setting: "set_project_setting",
    set_project_settings: "set_project_setting",
    log: "get_editor_log", logs: "get_editor_log",
    screenshot: "capture_editor_viewport", capture: "capture_editor_viewport",
    scan: "scan_filesystem", rescan: "scan_filesystem",
    rename: "rename_path", move: "rename_path",
    delete: "delete_path", rm: "delete_path",
    state: "get_editor_state", editor_state: "get_editor_state", inspect: "get_editor_state",
    tools: "list_tools",
  };

  function normalizeToolName(name) {
    let n = String(name == null ? "" : name).trim();
    if (!n) return "";
    n = n
      .replace(/^functions\s*\.\s*/i, "")
      .replace(/^(?:nzs|mcp)[_-]/i, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return TOOL_ALIASES[n] || n;
  }

  function normalizeCall(o) {
    if (!o || typeof o !== "object") return null;
    if (o.function && typeof o.function === "object") o = { ...o, ...o.function };
    let name = o.command != null ? o.command : o.tool != null ? o.tool : o.name != null ? o.name : o.action;
    if (typeof name !== "string" || !name.trim()) return null;
    name = normalizeToolName(name);
    if (!name) return null;
    let args = o.params != null ? o.params : o.arguments != null ? o.arguments : o.args != null ? o.args : o.parameters;
    if (typeof args === "string") {
      try {
        args = parseLoose(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    return { tool: name, arguments: args };
  }

  // Which language the reply's code block is written in: "gd", "cs" or null.
  // The extension uses this to warn when a block and its path disagree.
  function codeLanguage(text) {
    const m = String(text || "").match(/###\s*(gdscript|gds|gd|csharp|c#|cs|dotnet|lua)\s*(?:###|---)/i);
    if (!m) return null;
    const tag = m[1].toLowerCase();
    if (tag === "csharp" || tag === "c#" || tag === "cs" || tag === "dotnet") return "cs";
    return "gd";
  }

  // Empty string when the block language matches every path, otherwise a
  // human-readable warning. Language is decided by the extension, so a
  // ###CSHARP### block aimed at res://x.gd would silently produce a broken file.
  function codeLanguageWarning(command, text) {
    const lang = codeLanguage(text);
    if (!lang || !command) return "";
    if (!/^(write_file|write_files|edit_file)$/.test(String(command.command || command.tool || ""))) return "";
    const params = command.params || command.arguments || {};
    const paths = [];
    if (typeof params.path === "string") paths.push(params.path);
    if (Array.isArray(params.files)) {
      for (const f of params.files) if (f && typeof f.path === "string") paths.push(f.path);
    }
    for (const p of paths) {
      const ext = String(p).toLowerCase().split(".").pop();
      if (lang === "cs" && ext === "gd") {
        return `代码块是 C#（###CSHARP###），但路径是 .gd：${p}。语言由扩展名决定，请改用 .cs 或把它改写成 GDScript。`;
      }
      if (lang === "gd" && ext === "cs") {
        return `代码块是 GDScript（###GDSCRIPT###），但路径是 .cs：${p}。请改用 .gd 或把它改写成 C#。`;
      }
    }
    return "";
  }

  // All code blocks in the text: [{start, end, code, closed}]
  function codeBlocks(text) {
    const out = [];
    let from = 0;
    while (true) {
      const s = findLuaStart(text, from);
      if (s.pos === -1) break;
      const e = findLuaEnd(text, s.pos + s.len);
      const codeEnd = e === -1 ? text.length : e;
      const endMarker = e === -1 ? "" : (LUA_END_RE.exec(text.slice(e)) || [""])[0];
      out.push({
        start: s.pos,
        end: e === -1 ? text.length : e + endMarker.length,
        code: stripCodeChrome(text.slice(s.pos + s.len, codeEnd).replace(/^\s*\n/, "").replace(/\s+$/, "")),
        closed: e !== -1,
      });
      from = e === -1 ? text.length : e + endMarker.length;
      if (from <= s.pos) break;
    }
    return out;
  }

  function hasOpenToolBlock(text) {
    if (!text) return false;
    const s = findLuaStart(text);
    if (s.pos !== -1 && findLuaEnd(text, s.pos + s.len) === -1) return true;
    const sm = text.indexOf(START_M);
    if (sm !== -1) {
      const low = text.toLowerCase();
      if (low.indexOf("###end_mcp_tool###", sm) === -1 && low.indexOf("###end-mcp_tool###", sm) === -1) return true;
    }
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const open = text.lastIndexOf("{", k);
      if (open !== -1 && matchBrace(text, open) === -1) return true;
    }
    return false;
  }

  // Find JSON command objects anywhere in the reply. Returns {calls, blocks}.
  function scan(text) {
    const calls = [];
    let pos = 0;
    const seen = new Set();
    while (true) {
      const m = ANY_KEY_RE.exec(text.slice(pos));
      if (!m) break;
      const keyPos = pos + m.index;
      const start = text.lastIndexOf("{", keyPos);
      if (start === -1) {
        pos = keyPos + 1;
        continue;
      }
      const end = matchBrace(text, start);
      if (end === -1) {
        pos = keyPos + 1;
        continue;
      }
      const slice = text.slice(start, end + 1);
      const obj = extractJson(slice);
      const looksLikeEnvelope =
        obj && (obj.command != null || obj.tool != null || obj.action != null ||
          obj.params != null || obj.arguments != null || obj.args != null);
      const call = looksLikeEnvelope ? normalizeCall(obj) : null;
      if (call && !seen.has(start)) {
        seen.add(start);
        calls.push({ ...call, _start: start, _end: end });
      }
      pos = end + 1;
    }
    return calls;
  }

  function attachCode(calls, blocks) {
    if (!blocks.length) return calls;
    const used = new Set();
    for (const call of calls) {
      const a = call.arguments || {};
      const name = call.tool;
      const wantsCode =
        (name === "write_file" && a.content == null) ||
        (name === "edit_file" && (a.replace == null || a.replace === "")) ||
        name === "write_files";
      if (!wantsCode) continue;

      // Prefer a block that starts after this JSON object; fall back to the first.
      let block = blocks.find((b) => !used.has(b) && b.start > call._end) || blocks.find((b) => !used.has(b));
      if (!block) continue;
      used.add(block);

      if (name === "write_files") {
        const files = Array.isArray(a.files) ? a.files : [];
        if (!files.length) {
          const path = findPathBefore(call, blocks, block);
          if (path) a.files = [{ path, content: block.code }];
        } else {
          for (const f of files) {
            if (f && f.content == null) {
              f.content = block.code;
              break;
            }
          }
        }
      } else if (name === "edit_file") {
        if (a.replace == null || a.replace === "") a.replace = block.code;
      } else {
        a.content = block.code;
      }
      call.arguments = a;
    }
    return calls;
  }

  function findPathBefore(call, blocks, block) {
    const a = call.arguments || {};
    if (a.path) return a.path;
    const text = call._text || "";
    const upTo = block.start;
    const matches = [];
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(text))) {
      if (m.index > upTo) break;
      matches.push(m[0]);
    }
    return matches.length ? matches[matches.length - 1] : "";
  }

  // Main entry point. Returns [{tool, arguments}].
  function parseToolCalls(reply) {
    const text = String(reply || "");
    const blocks = codeBlocks(text);
    let calls = scan(text);
    for (const c of calls) c._text = text;

    // ###MCP_TOOL### wrappers: bodies may contain JSON or a bare code block.
    if (!calls.length && text.includes(START_M)) {
      const low = text.toLowerCase();
      let from = 0;
      while (true) {
        const sm = text.indexOf(START_M, from);
        if (sm === -1) break;
        const ea = low.indexOf("###end_mcp_tool###", sm);
        const eb = low.indexOf("###end-mcp_tool###", sm);
        const em = ea === -1 ? eb : eb === -1 ? ea : Math.min(ea, eb);
        if (em === -1) break;
        const body = text.slice(sm + START_M.length, em);
        const inner = scan(body);
        if (inner.length) calls.push(...inner);
        from = em + END_M.length;
      }
    }

    calls = attachCode(calls, blocks);

    // Bare code block with a res:// path mentioned just before it → write_file.
    if (!calls.length && blocks.length) {
      for (const b of blocks) {
        const before = text.slice(Math.max(0, b.start - 600), b.start);
        PATH_RE.lastIndex = 0;
        const matches = before.match(PATH_RE);
        if (matches && matches.length) {
          calls.push({ tool: "write_file", arguments: { path: matches[matches.length - 1], content: b.code } });
          break;
        }
      }
    }

    // Strip markers that a model embedded inside a JSON string value.
    return calls.map((c) => cleanCodeCall(c));
  }

  // If content/replace still starts with a marker (JSON-escaped block), peel it.
  function cleanCodeCall(call) {
    if (!call || !call.arguments) return call;
    const a = call.arguments;
    for (const key of ["content", "replace"]) {
      if (typeof a[key] !== "string") continue;
      const s = findLuaStart(a[key]);
      if (s.pos === -1) continue;
      const e = findLuaEnd(a[key], s.pos + s.len);
      a[key] = a[key].slice(s.pos + s.len, e === -1 ? a[key].length : e).replace(/\s+$/, "");
    }
    if (Array.isArray(a.files)) {
      for (const f of a.files) if (f && typeof f.content === "string") cleanCodeCall({ arguments: f });
    }
    return call;
  }

  // Last-resort salvage of a CUT-OFF JSON command (closing braces lost).
  const MAX_SALVAGE_CLOSERS = 2;
  function salvageCutOff(text) {
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const start = text.lastIndexOf("{", k);
      if (start === -1) continue;
      if (matchBrace(text, start) !== -1) continue;
      const stack = [];
      let inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") stack.push("}");
        else if (c === "[") stack.push("]");
        else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return null;
        }
      }
      if (inStr) return null;
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      if (!/["}\]0-9]$|(?:true|false|null)$/.test(body)) return null;
      try {
        const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
        if (call) return cleanCodeCall(call);
      } catch {}
      return null;
    }
    return null;
  }

  function toolNameFromText(txt) {
    const m = String(txt || "").match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
    if (!m) return "command";
    return m[1].trim() ? normalizeToolName(m[1]) : "command";
  }

  function hasCommandShape(txt) {
    return (
      String(txt || "").includes(START_M) ||
      LUA_START_RE.test(txt) ||
      DSML_RE.test(txt) ||
      CMD_KEY_RE.test(txt)
    );
  }

  function countCommandShapes(txt) {
    const text = String(txt || "");
    let n = 0;
    for (const key of ['"command"', '"tool"']) {
      let pos = 0;
      while (true) {
        const k = text.indexOf(key, pos);
        if (k === -1) break;
        n++;
        pos = k + key.length;
      }
    }
    return n;
  }

  // Human-readable reason for a reply that looked like a command but failed.
  function diagnose(txt) {
    const text = String(txt || "");
    // A parseable command is not a problem, whatever else the reply contains.
    if (parseToolCalls(text).length) return null;
    if (DSML_RE.test(text)) return "dsml";
    const blocks = codeBlocks(text);
    if (blocks.some((b) => !b.closed)) return "unclosedCode";
    if (countCommandShapes(text) > 1) return "multiple";
    if (hasCommandShape(text)) {
      if (hasOpenToolBlock(text)) return "unclosed";
      if (/"params"\s*:\s*\{[^}]*"path"\s*:/s.test(text) && !CMD_KEY_RE.test(text)) return "envelope";
      return "malformed";
    }
    return null;
  }

  return {
    START_M, END_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, DSML_RE,
    findLuaStart, findLuaEnd, matchBrace, extractJson, normalizeCall, normalizeToolName,
    hasToolSignature: hasCommandShape, hasOpenToolBlock, parseToolCalls, salvageCutOff,
    toolNameFromText, hasCommandShape, diagnose, codeBlocks, cleanCodeCall,
    codeLanguage, codeLanguageWarning,
  };
})();
