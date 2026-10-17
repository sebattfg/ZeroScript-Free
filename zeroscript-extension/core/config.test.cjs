// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("zeroscript-extension/core/config.js", "utf8");
const ZS = vm.runInNewContext(source + "\nglobalThis.ZS", {});

const tools = [
  {
    name: "workspace_info",
    description: "Get the selected project root and name.",
    inputSchema: { type: "object", properties: {} },
    server: "workspace",
  },
  {
    name: "workspace_write_file",
    description: "Create or replace a UTF-8 file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    server: "workspace",
  },
];

const prompt = ZS.buildSystemPrompt({ tools });
assert.match(prompt, /general-purpose local software development agent/);
assert.match(prompt, /workspace_info\(\)/);
assert.match(prompt, /path: string \(required\)/);
assert.match(prompt, /content: string \(required\)/);
assert.match(prompt, /bootstrap only, your first response MUST be one list_tools call/);
assert.doesNotMatch(prompt, /Roblox Studio place.*always connected/i);
assert.equal(ZS.toolCategory("workspace_read_file"), "read");
assert.equal(ZS.toolCategory("workspace_write_file"), "edit");
assert.equal(ZS.toolCategory("workspace_multi_edit"), "edit");
assert.equal(ZS.toolCategory("workspace_replace_in_files"), "edit");
assert.equal(ZS.toolCategory("workspace_run_task"), "edit");
assert.equal(ZS.toolCategory("workspace_git_stage_file"), "edit");
assert.equal(ZS.toolCategory("workspace_git_unstage_file"), "edit");
assert.equal(ZS.toolCategory("workspace_git_commit"), "edit");
assert.equal(ZS.toolCategory("workspace_recent_roots"), "read");
assert.equal(ZS.toolCategory("roblox/execute_luau"), "roblox");
assert.equal(ZS.toolCategory("roblox/screen_capture"), "screen");
assert.match(ZS.toolsReminder(tools), /workspace_info/);
assert.match(ZS.toolsReminder(tools), /\n\n/);

process.stdout.write("ZeroScript-Win config tests passed.\n");
