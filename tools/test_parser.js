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

test("command names are normalised", () => {
  const c = one('{"command":"Read File","params":{"path":"a"}}');
  assert.strictEqual(c.tool, "read_file");
  assert.strictEqual(P.normalizeToolName("getNodeInfo"), "get_node_info");
  assert.strictEqual(P.normalizeToolName("functions.write_file"), "write_file");
  assert.strictEqual(P.normalizeToolName("create_node"), "add_node");
});

console.log(failures.length ? `\n${failures.length} failed, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failures.length ? 1 : 0);
