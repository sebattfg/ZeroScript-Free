// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

(function initZeroScriptEditorUtils(global) {
  function findAllMatches(content, query, matchCase = false) {
    const text = String(content == null ? "" : content);
    const needleText = String(query == null ? "" : query);
    if (!needleText) return [];
    const haystack = matchCase ? text : text.toLocaleLowerCase();
    const needle = matchCase ? needleText : needleText.toLocaleLowerCase();
    const matches = [];
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, offset);
      if (start < 0) break;
      matches.push({ start, end: start + needle.length });
      // Keep searches non-overlapping, as common editor Find controls do.
      offset = start + Math.max(needle.length, 1);
    }
    return matches;
  }

  function replaceRanges(content, matches, replacement) {
    let result = String(content == null ? "" : content);
    const value = String(replacement == null ? "" : replacement);
    if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
    let lastStart = result.length + 1;
    const ordered = matches.slice().sort((a, b) => b.start - a.start);
    for (const match of ordered) {
      if (!match || !Number.isInteger(match.start) || !Number.isInteger(match.end) ||
          match.start < 0 || match.end < match.start || match.end > result.length ||
          match.end > lastStart) {
        throw new RangeError("match ranges must be valid, non-overlapping positions within the source text");
      }
      result = result.slice(0, match.start) + value + result.slice(match.end);
      lastStart = match.start;
    }
    return result;
  }

  function normalizeWorkspaceRelativeScope(rawScope) {
    let scope = String(rawScope == null ? "." : rawScope).trim() || ".";
    if (/^[\\/]/.test(scope) || /^[a-zA-Z]:/.test(scope)) {
      throw new Error("Folder scope must be relative to the selected workspace (for example src/ or .).");
    }
    scope = scope.replace(/\\/g, "/");
    const segments = [];
    for (const segment of scope.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) {
          throw new Error("Folder scope cannot escape the selected workspace.");
        }
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    return segments.join("/") || ".";
  }

  const api = Object.freeze({
    findAllMatches,
    replaceRanges,
    normalizeWorkspaceRelativeScope,
  });
  global.ZSEditorUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
