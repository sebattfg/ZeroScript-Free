// SPDX-License-Identifier: GPL-3.0-or-later
// core/config.js - provider-agnostic constants for NonZeroScript.
//
// Nothing in this file may reference a specific AI website (DOM, selectors,
// site names) - that lives in providers/*.js. This is the Godot edition of
// ZeroScript: the tool catalogue describes the Godot editor plugin, and the
// transport is the local controller (HTTP on 127.0.0.1).
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  "use strict";

  const APP_NAME = "NonZeroScript";
  const EDITION = "Godot 4.7.2 edition";
  const DEFAULT_CONTROLLER = "http://127.0.0.1:8790";
  const SYS_MARKER = "⟦NZS-SYS⟧";
  const RESEND_MARKER = "⟦NZS-RE⟧";

  // ── Tool → chip category (icon + colour theme) ───────────────────────────
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : name || "";
    if (/^(list_tools|get_editor_state|list_files|read_file|search_in_files|get_scene_tree|get_node_info|get_project_settings|get_editor_log|capture_editor_viewport)$/.test(n))
      return "read";
    if (/^(write_file|write_files|edit_file|create_dir|delete_path|rename_path|scan_filesystem)$/.test(n))
      return "edit";
    if (/^(add_node|remove_node|set_node_property|select_nodes|instantiate_scene|open_scene|create_scene|save_scene)$/.test(n))
      return "scene";
    if (/^(run_project|stop_project)$/.test(n)) return "run";
    return "tool";
  }

  // ── Feedback strings sent back so the model can self-correct ─────────────
  const FEEDBACK = {
    parseError: (reason, toolName) => {
      const known = toolName && !["command", "unknown"].includes(toolName);
      const codeHint = known
        ? ""
        : " For a long GDScript file put the path in JSON and the code in a ###GDSCRIPT### ... ###END_GDSCRIPT### block.";
      const notes = {
        malformed:
          "ERROR: a NonZeroScript command was detected in your reply, but its JSON could not be parsed, " +
          'so nothing ran. Rewrite it as ONE valid JSON object in plain text, exactly like ' +
          '{"command": "name", "params": { ... }}.' + codeHint + " Please retry.",
        unclosed:
          "ERROR: your command was cut off before it finished - the JSON object never closed. " +
          'Rewrite the WHOLE command as one valid JSON object, exactly like {"command": "name", "params": { ... }}.' +
          codeHint + " Please retry.",
        unclosedCode:
          "ERROR: your ###GDSCRIPT### block was never closed, so the code was not written. " +
          "End the code with ###END_GDSCRIPT### and retry.",
        envelope:
          "ERROR: you wrote parameters as a bare JSON object without the command envelope, so nothing ran. " +
          'Wrap them like {"command": "name", "params": { ... }} - the keys go INSIDE "params". Please retry.',
        toolKey:
          "ERROR: you used the wrong key to name the command. The key must be exactly \"command\" - not " +
          '"toolName", "tool", "name", "function" or "action" - and every argument goes INSIDE "params", like ' +
          '{"command": "name", "params": { ... }}. Please retry.',
        multiple:
          "ERROR: you wrote more than one command in one reply. Send ONE command at a time and wait for its " +
          "result before the next. Please retry with only the first command.",
        dsml:
          "ERROR: you wrote the call in your own internal tool-call markup. NonZeroScript cannot read that, " +
          "so nothing ran. Never use those tags here. Write ONE plain-text JSON object instead, like " +
          '{"command": "name", "params": { ... }}. Please retry.',
        none:
          "ERROR: your reply did not contain a runnable NonZeroScript command. Reply with ONE JSON command, " +
          'exactly like {"command": "name", "params": { ... }} - or, if the task is finished or you need a ' +
          "decision from the human, reply in plain text with no command.",
      };
      return notes[reason] || notes.malformed;
    },
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". Valid commands are: ${valid.join(", ")}. ` +
      "Use an exact name and parameter keys from the system prompt.",
    editorOffline:
      "ERROR: the Godot editor plugin is not connected to the controller, so the command could not run. " +
      "This is an environment problem on the human's machine, NOT your mistake. Tell the user in one short " +
      "sentence to open their Godot project and enable the NonZeroScript plugin. Then stop and wait.",
    controllerOffline:
      "ERROR: the local NonZeroScript controller is unreachable. Tell the user in one short sentence to start " +
      "the controller, then stop and wait.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you finished. Continue from " +
      "exactly where you stopped. Do NOT restart and do NOT repeat what you already wrote.)",
    taskDone: "Task finished.",
  };

  const BT = "```";
  const clip = (s, n) => {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} chars]` : s;
  };

  // ── Tool catalogue formatting ────────────────────────────────────────────
  // `tools` is the array from controller/tools.json (served by /api/tools).
  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const props = t.params || {};
        const args = Object.keys(props)
          .map((k) => (props[k] && props[k].required ? `${k}` : `${k}?`))
          .join(", ");
        const desc = (t.description || "").split("\n")[0].trim();
        return `  ${t.name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ────────────────────────────────────────────────────────
  // opts: { siteName, tools, editor, providerNotes, customPrompt, memoryNote }
  function systemPrompt(opts = {}) {
    const siteName = opts.siteName || "the AI";
    const tools = compactTools(opts.tools);
    const ed = opts.editor || {};
    const env = [
      `- Engine: ${ed.engine || "Godot 4.7.2"}`,
      `- Project: ${ed.project || "(unknown - the editor plugin is not connected yet)"}`,
      `- Project path: ${ed.project_path || "(unknown)"}`,
      `- Open scene: ${ed.open_scene || "(none)"}`,
      `- Editor connected: ${ed.connected === false ? "no" : "yes"}`,
      `- Writing enabled: ${ed.write_enabled === false ? "no (ask the human to enable it in the plugin dock)" : "yes"}`,
    ].join("\n");

    const providerNote = opts.providerNotes ? `\n## Notes for ${siteName}\n${opts.providerNotes}\n` : "";

    return (
      SYS_MARKER + "\n" +
      `# NonZeroScript - Godot ${EDITION}\n\n` +
      `You are NonZeroScript, an AI agent that builds and edits a **Godot 4.7.2** project through the ` +
      `NonZeroScript editor plugin. This page (${siteName}) is only the brain: the plugin performs every ` +
      `file and scene change for real on the human's machine. You are NOT a normal chatbot in this ` +
      `conversation - act, do not describe.\n\n` +

      `## The one rule\n` +
      `Every reply must be exactly ONE of these two things:\n` +
      `1. **One command** - a single JSON object, optionally followed by a ###GDSCRIPT### code block.\n` +
      `2. **A finish** - plain text with NO command, either because the task is complete or because you ` +
      `genuinely need a decision from the human. This ends the run and returns control to them.\n\n` +
      `Never write two commands in one reply. Never invent a result. Never claim a change you did not ` +
      `receive a result for.\n\n` +

      `## Command format\n` +
      BT + `json\n{"command": "read_file", "params": {"path": "res://project.godot"}}\n` + BT + `\n\n` +
      `A short sentence of narration before the command is allowed. The JSON must be plain text in the ` +
      `reply (a fenced json block is fine). Keys other than "command"/"params" are not recognised.\n\n` +

      `## Writing GDScript\n` +
      `Do NOT escape a whole script into JSON. Put the path in JSON and the code in a block:\n\n` +
      BT + `\n{"command": "write_file", "params": {"path": "res://scripts/player.gd"}}\n` +
      `###GDSCRIPT###\nextends CharacterBody2D\n\n@export var speed: float = 300.0\n\n` +
      `func _physics_process(delta: float) -> void:\n\t# ...\n\tpass\n###END_GDSCRIPT###\n` + BT + `\n\n` +
      `The plugin writes the block to the path exactly as written. For small changes use ` +
      `edit_file(path, search, replace) - literal search, no regex. ` +
      `Never use ###LUA### blocks: this is Godot, not Roblox.\n\n` +

      `## How to work\n` +
      `- Start with get_editor_state, then inspect (list_files / read_file / get_scene_tree) before editing.\n` +
      `- Prefer many small, verifiable commands over one giant blind rewrite.\n` +
      `- New files and folders use res:// (project) or user://. Never use absolute paths.\n` +
      `- The plugin rescans the project after writes, so new scripts and scenes appear immediately.\n` +
      `- After run_project, wait for a human turn before reading get_editor_log; play-testing is interactive.\n` +
      `- If a result starts with ERROR, fix the call and retry, or explain the blocker in one sentence and ` +
      `finish. Do not repeat the same failing call.\n` +
      `- Keep the project runnable: typed GDScript, Godot 4.x APIs, no invented engine methods.\n\n` +

      `## Multi-browser rotation\n` +
      `This task can rotate between several AI browser tabs (same or different provider). A memory brief ` +
      `from earlier turns may be prepended to a task or result; treat it as your own history, do not repeat ` +
      `finished work, and continue from the latest state.\n` +
      providerNote + "\n" +

      `## Environment\n${env}\n\n` +
      `## Commands\n${tools || "  (catalogue unavailable - call list_tools)"}\n\n` +
      (opts.memoryNote ? `## Memory brief\n${opts.memoryNote}\n\n` : "") +
      (opts.customPrompt
        ? `## The human's extra instructions\n${opts.customPrompt}\n\n`
        : "") +
      `Reply READY now (plain text, no command) and wait for the first task.`
    );
  }

  // Random delay in [min, max] seconds. Used before every simulated input.
  function randomDelay(minSec, maxSec) {
    const lo = Math.max(0, Number(minSec) || 0);
    const hi = Math.max(lo, Number(maxSec) || lo);
    return Math.round((lo + Math.random() * (hi - lo)) * 1000);
  }

  return {
    APP_NAME, EDITION, DEFAULT_CONTROLLER, SYS_MARKER, RESEND_MARKER,
    toolCategory, FEEDBACK, compactTools, systemPrompt, randomDelay, clip,
  };
})();
