#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Parser smoke tests: node tools/test_parser.js
// The parser is pure string logic, so it can be tested without a browser.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(root, "extension", "core", "parser.js"), "utf8");
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src + "\n;globalThis.__P = ZSParse;", ctx);
const P = ctx.__P;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

function one(text) {
  const calls = P.parseToolCalls(text);
  assert.ok(calls.length >= 1, `expected a command, got ${calls.length}`);
  return calls[0];
}

console.log("parser");

test("JSON command in prose", () => {
  const c = one('Sure, let me look.\n{"command":"read_file","params":{"path":"res://project.godot"}}');
  assert.strictEqual(c.tool, "read_file");
  assert.strictEqual(c.arguments.path, "res://project.godot");
  assert.strictEqual(P.diagnose('{"command":"read_file","params":{"path":"a"}}'), null);
});

test("fenced JSON + GDSCRIPT block", () => {
  const text =
    '```json\n{"command":"write_file","params":{"path":"res://scripts/player.gd"}}\n```\n' +
    "###GDSCRIPT###\nextends CharacterBody2D\n\nfunc _ready():\n\tprint(\"hi\")\n###END_GDSCRIPT###";
  const c = one(text);
  assert.strictEqual(c.tool, "write_file");
  assert.ok(c.arguments.content.startsWith("extends CharacterBody2D"), "body missing");
  assert.ok(c.arguments.content.includes('print("hi")'), "body truncated");
});

test("legacy LUA markers still parse", () => {
  const text = '{"command":"write_file","params":{"path":"res://a.gd"}}\n###LUA###\nextends Node\n###END_LUA###';
  const c = one(text);
  assert.strictEqual(c.tool, "write_file");
  assert.strictEqual(c.arguments.content, "extends Node");
});

test("tool/arguments envelope with null content", () => {
  const text =
    '{"tool":"write_files","arguments":{"files":[' +
    '{"path":"res://a.gd","content":null},{"path":"res://b.gd","content":"extends Node"}]}}';
  const c = one(text);
  assert.strictEqual(c.tool, "write_files");
  assert.strictEqual(c.arguments.files.length, 2);
  assert.strictEqual(c.arguments.files[0].content, null);
});

test("a bare GDSCRIPT block is not a command (needs a JSON envelope)", () => {
  const text = "###GDSCRIPT###\nextends Node\nfunc _ready():\n\tpass\n###END_GDSCRIPT###";
  assert.strictEqual(P.parseToolCalls(text).length, 0);
  assert.ok(P.diagnose(text), "should ask the model for the envelope");
});

test("plain prose has no command and no diagnosis", () => {
  assert.strictEqual(P.parseToolCalls("I finished the task.").length, 0);
  assert.strictEqual(P.diagnose("I finished the task."), null);
});

test("truncated JSON is not mistaken for a command", () => {
  const text = '{"command":"add_node","params":{"parent_path":".","type":"Label","name":"Title"';
  assert.strictEqual(P.parseToolCalls(text).length, 0);
  assert.ok(["unclosed", "malformed"].includes(P.diagnose(text)), `unexpected diagnosis ${P.diagnose(text)}`);
});

test("a path-only object is not a command", () => {
  const text = '{"path":"res://x.gd"}';
  assert.strictEqual(P.parseToolCalls(text).length, 0);
});

test("two commands are reported, the agent loop uses the first", () => {
  const text =
    '{"command":"read_file","params":{"path":"a"}}\n{"command":"read_file","params":{"path":"b"}}';
  const calls = P.parseToolCalls(text);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].arguments.path, "a");
});

test("fenced JSON + CSHARP block", () => {
  const text =
    '```json\n{"command":"write_file","params":{"path":"res://scripts/Player.cs"}}\n```\n' +
    "###CSHARP###\nusing Godot;\n\npublic partial class Player : CharacterBody2D\n{\n" +
    "    public override void _Ready()\n    {\n        GD.Print(\"hi\");\n    }\n}\n###END_CSHARP###";
  const c = one(text);
  assert.strictEqual(c.tool, "write_file");
  assert.strictEqual(c.arguments.path, "res://scripts/Player.cs");
  assert.ok(c.arguments.content.startsWith("using Godot;"), "body missing");
  assert.ok(c.arguments.content.includes("public partial class Player"), "body truncated");
  assert.ok(c.arguments.content.trimEnd().endsWith("}"), "closing brace lost");
});

test("###CS### and ###C# ### blocks parse too", () => {
  const short = one('{"command":"write_file","params":{"path":"res://A.cs"}}\n###CS###\npublic partial class A : Node { }\n###END_CS###');
  assert.strictEqual(short.arguments.content, "public partial class A : Node { }");
  const hash = one('{"command":"write_file","params":{"path":"res://B.cs"}}\n###C# ###\npublic partial class B : Node { }\n###END_C# ###');
  assert.strictEqual(hash.arguments.content, "public partial class B : Node { }");
});

test("a bare CSHARP block is not a command either", () => {
  const text = "###CSHARP###\npublic partial class A : Node { }\n###END_CSHARP###";
  assert.strictEqual(P.parseToolCalls(text).length, 0);
  assert.ok(P.diagnose(text), "should ask the model for the envelope");
});

test("attach_script aliases normalise", () => {
  assert.strictEqual(P.normalizeToolName("Attach Script"), "attach_script");
  assert.strictEqual(P.normalizeToolName("set_script"), "attach_script");
  assert.strictEqual(P.normalizeToolName("attachScript"), "attach_script");
});

test("code block language is detected", () => {
  assert.strictEqual(P.codeLanguage("###CSHARP###\nclass A {}\n###END_CSHARP###"), "cs");
  assert.strictEqual(P.codeLanguage("###CS###\nclass A {}\n###END_CS###"), "cs");
  assert.strictEqual(P.codeLanguage("###GDSCRIPT###\nextends Node\n###END_GDSCRIPT###"), "gd");
  assert.strictEqual(P.codeLanguage("###LUA###\nprint(1)\n###END_LUA###"), "gd");
  assert.strictEqual(P.codeLanguage("no block here"), null);
});

test("a block and its path must agree on the language", () => {
  const okCs = P.codeLanguageWarning(
    { command: "write_file", params: { path: "res://Player.cs" } },
    "###CSHARP###\nusing Godot;\n###END_CSHARP###"
  );
  assert.strictEqual(okCs, "");
  const bad = P.codeLanguageWarning(
    { command: "write_file", params: { path: "res://player.gd" } },
    "###CSHARP###\nusing Godot;\n###END_CSHARP###"
  );
  assert.ok(bad.includes("player.gd"), "should name the path");
  const badGd = P.codeLanguageWarning(
    { command: "write_files", params: { files: [{ path: "res://A.cs" }] } },
    "###GDSCRIPT###\nextends Node\n###END_GDSCRIPT###"
  );
  assert.ok(badGd.includes("A.cs"), "should look inside write_files");
  // Read-only commands never warn, even if the reply quotes code.
  assert.strictEqual(
    P.codeLanguageWarning(
      { command: "read_file", params: { path: "res://A.cs" } },
      "###GDSCRIPT###\nextends Node\n###END_GDSCRIPT###"
    ),
    ""
  );
});

test("command names are normalised", () => {
  const c = one('{"command":"Read File","params":{"path":"a"}}');
  assert.strictEqual(c.tool, "read_file");
  assert.strictEqual(P.normalizeToolName("getNodeInfo"), "get_node_info");
  assert.strictEqual(P.normalizeToolName("functions.write_file"), "write_file");
  assert.strictEqual(P.normalizeToolName("create_node"), "add_node");
});

console.log(failures.length ? `\n${failures.length} failed, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failures.length ? 1 : 0);
