// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const assert = require("node:assert/strict");
const {
  findAllMatches,
  replaceRanges,
  normalizeWorkspaceRelativeScope,
} = require("./workspace-editor-utils.js");

assert.deepEqual(findAllMatches("apple Apple banana apple", "apple"), [
  { start: 0, end: 5 },
  { start: 6, end: 11 },
  { start: 19, end: 24 },
]);
assert.deepEqual(findAllMatches("apple Apple banana apple", "apple", true), [
  { start: 0, end: 5 },
  { start: 19, end: 24 },
]);
assert.deepEqual(findAllMatches("aaaa", "aa", true), [
  { start: 0, end: 2 },
  { start: 2, end: 4 },
]);
assert.deepEqual(findAllMatches("any text", ""), []);
assert.equal(
  replaceRanges("apple Apple banana apple", [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 19, end: 24 },
  ], "pear"),
  "pear pear banana pear",
);
assert.equal(
  replaceRanges("one--two--three", [
    { start: 0, end: 3 },
    { start: 5, end: 8 },
    { start: 10, end: 15 },
  ], ""),
  "----",
);
assert.equal(normalizeWorkspaceRelativeScope("."), ".");
assert.equal(normalizeWorkspaceRelativeScope(""), ".");
assert.equal(normalizeWorkspaceRelativeScope("src/"), "src");
assert.equal(normalizeWorkspaceRelativeScope("src\\client"), "src/client");
assert.equal(normalizeWorkspaceRelativeScope("src/../tests"), "tests");
assert.equal(normalizeWorkspaceRelativeScope("./src/./client/../shared"), "src/shared");
assert.throws(() => normalizeWorkspaceRelativeScope("../outside"), /cannot escape/);
assert.throws(() => normalizeWorkspaceRelativeScope("src/../../outside"), /cannot escape/);
assert.throws(() => normalizeWorkspaceRelativeScope("/workspace/src"), /must be relative/);
assert.throws(() => normalizeWorkspaceRelativeScope("C:\\workspace\\src"), /must be relative/);
assert.throws(() => normalizeWorkspaceRelativeScope("\\rooted"), /must be relative/);
assert.throws(() => replaceRanges("abc", [{ start: -1, end: 2 }], "x"), /valid, non-overlapping/);
assert.throws(() => replaceRanges("abcdef", [
  { start: 1, end: 4 },
  { start: 3, end: 5 },
], "x"), /valid, non-overlapping/);

process.stdout.write("ZeroScript editor utility tests passed.\n");
