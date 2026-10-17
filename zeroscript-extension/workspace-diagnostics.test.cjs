// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const assert = require("node:assert/strict");
const { parseTaskDiagnostics, workspaceRelativeDiagnosticPath } = require("./workspace-diagnostics.js");

{
  const items = parseTaskDiagnostics("/workspace/src/main.c:10:5: error: expected ';' before return", "/workspace");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/main.c");
  assert.equal(items[0].line, 10);
  assert.equal(items[0].column, 5);
  assert.equal(items[0].severity, "error");
}

{
  const items = parseTaskDiagnostics("C:\\project\\src\\app.ts(12,4): error TS2345: Type mismatch", "C:\\project");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/app.ts");
  assert.equal(items[0].line, 12);
  assert.equal(items[0].column, 4);
  assert.match(items[0].message, /Type mismatch/);
}

{
  const items = parseTaskDiagnostics("error[E0425]: cannot find value `x` in this scope\n  --> src/main.rs:9:8", "/workspace");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/main.rs");
  assert.equal(items[0].line, 9);
  assert.equal(items[0].column, 8);
  assert.match(items[0].message, /cannot find value/);
}

{
  const items = parseTaskDiagnostics('Traceback (most recent call last):\n  File "/project/app.py", line 7, in main\nNameError: name \'missing\' is not defined', "/project");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "app.py");
  assert.equal(items[0].line, 7);
  assert.match(items[0].message, /^NameError:/);
}

{
  const items = parseTaskDiagnostics("src/app.js\n  2:3  error  'foo' is not defined  no-undef", "/workspace");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/app.js");
  assert.equal(items[0].line, 2);
  assert.equal(items[0].column, 3);
  assert.equal(items[0].severity, "error");
}

{
  const items = parseTaskDiagnostics("WARNING: src/cleanup.py:4: deprecated function", "/workspace");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/cleanup.py");
  assert.equal(items[0].line, 4);
  assert.equal(items[0].severity, "warning");
  assert.match(items[0].message, /deprecated function/);
}

{
  const items = parseTaskDiagnostics("C:/outside/secret.py:1: error: rejected path", "C:/workspace");
  assert.equal(items.length, 1);
  assert.equal(items[0].path, null, "absolute paths outside the workspace must not become navigable");
  assert.equal(workspaceRelativeDiagnosticPath("../../outside.js", "/workspace"), null);
  assert.equal(parseTaskDiagnostics("All tests passed; 12 tests completed", "/workspace").length, 0);
}

process.stdout.write("ZeroScript diagnostics tests passed.\n");
