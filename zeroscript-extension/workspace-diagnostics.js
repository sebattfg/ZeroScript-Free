// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

(function initZeroScriptDiagnostics(global) {
function workspaceRelativeDiagnosticPath(rawPath, workspaceRoot = "") {
  let path = String(rawPath || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (!path) return null;
  path = path.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const root = workspaceRoot ? String(workspaceRoot).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (root && path.toLowerCase().startsWith((root + "/").toLowerCase())) {
    path = path.slice(root.length + 1);
  } else if (root && path.toLowerCase() === root.toLowerCase()) {
    return null;
  } else if (/^(?:[a-zA-Z]:\/|\/|\/\/)/.test(path)) {
    // Never turn an absolute path outside the selected project into a clickable
    // workspace path. Diagnostics are navigation hints, not permission grants.
    return null;
  }
  path = path.replace(/^\.\//, "");
  const stack = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!stack.length) return null;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.length ? stack.join("/") : null;
}

function parseTaskDiagnostics(rawOutput, workspaceRoot = "") {
  const lines = String(rawOutput || "").split(/\r?\n/);
  const diagnostics = [];
  const seen = new Set();
  let previousSeverity = "error";
  let previousDiagnosticMessage = "";
  let pythonFrame = null;
  let eslintFile = null;

  const add = (rawPath, lineNumber, columnNumber, severity, message, sourceLine) => {
    const path = workspaceRelativeDiagnosticPath(rawPath, workspaceRoot);
    const line = Number.parseInt(lineNumber, 10);
    const column = Number.parseInt(columnNumber || "1", 10);
    const safeSeverity = /warn/i.test(severity || "") ? "warning" : /note|info/i.test(severity || "") ? "info" : "error";
    const diagnostic = {
      path,
      line: Number.isInteger(line) && line > 0 ? line : null,
      column: Number.isInteger(column) && column > 0 ? column : 1,
      severity: safeSeverity,
      message: String(message || sourceLine || "Diagnostic reported").trim(),
      source: String(sourceLine || "").trim(),
    };
    const key = [diagnostic.path, diagnostic.line, diagnostic.column, diagnostic.severity, diagnostic.message].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  const patterns = [
    /^\s*(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s*(?:[A-Z]+\d+)?\s*:?\s*(.*)$/i,
    /^\s*(.+):(\d+):(\d+):\s*(fatal error|error|warning|note):?\s*(.*)$/i,
    /^\s*(.+):(\d+):(\d+)\s*-\s*(error|warning)\s+(.+)$/i,
    /^\s*(.+):(\d+):\s*(error|warning|note):\s*(.*)$/i,
    /^\s*(.+\.py):(\d+):\s*(.+)$/i,
  ];

  for (const rawLine of lines) {
    let line = rawLine.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const severityContext = line.match(/^\s*(error(?:\[[^\]]+\])?|warning|warn|note|info|fatal error)\s*:\s*(.*)$/i);
    if (severityContext) {
      previousSeverity = /warning|warn/i.test(severityContext[1]) ? "warning" : /note|info/i.test(severityContext[1]) ? "info" : "error";
      previousDiagnosticMessage = severityContext[2] || severityContext[1];
    }
    let prefixSeverity = "";
    const prefixedDiagnostic = line.match(/^\s*(fatal error|error|warning|warn|info|note)\s*:\s*(.+)$/i);
    if (prefixedDiagnostic) {
      prefixSeverity = /warning|warn/i.test(prefixedDiagnostic[1]) ? "warning" : /note|info/i.test(prefixedDiagnostic[1]) ? "info" : "error";
      line = prefixedDiagnostic[2];
    }

    const rustLocation = line.match(/^\s*-->\s+(.+):(\d+):(\d+)\s*$/);
    if (rustLocation && previousDiagnosticMessage) {
      add(rustLocation[1], rustLocation[2], rustLocation[3], previousSeverity, previousDiagnosticMessage, rawLine);
      continue;
    }

    const frame = line.match(/File ["'](.+?)["'], line (\d+)/);
    if (frame) {
      pythonFrame = { path: frame[1], line: frame[2] };
      continue;
    }
    const pythonError = line.trim().match(/^([A-Za-z_][\w.]*(?:Error|Exception)):\s*(.*)$/);
    if (pythonError && pythonFrame) {
      add(pythonFrame.path, pythonFrame.line, "1", "error", pythonError[1] + ": " + pythonError[2], rawLine);
      pythonFrame = null;
    }

    const fileHeader = line.trim().match(/^(.+\.(?:js|jsx|mjs|cjs|ts|tsx|py|pyw|go|rs|java|cs|cpp|c|h|hpp|luau|lua|rb|php|sql))\s*$/i);
    if (fileHeader) eslintFile = fileHeader[1];

    const eslintRow = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$/i);
    if (eslintRow && eslintFile) {
      add(eslintFile, eslintRow[1], eslintRow[2], eslintRow[3], eslintRow[4], rawLine);
      continue;
    }

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      if (pattern === patterns[0]) add(match[1], match[2], match[3], match[4], match[5], rawLine);
      else if (pattern === patterns[1]) add(match[1], match[2], match[3], match[4], match[5], rawLine);
      else if (pattern === patterns[2]) add(match[1], match[2], match[3], match[4], match[5], rawLine);
      else if (pattern === patterns[3]) add(match[1], match[2], "1", match[3], match[4], rawLine);
      else add(match[1], match[2], "1", prefixSeverity || "error", match[3], rawLine);
      break;
    }
  }
  return diagnostics.slice(0, 250);
}


  const api = Object.freeze({ parseTaskDiagnostics, workspaceRelativeDiagnosticPath });
  global.ZSDiagnostics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
