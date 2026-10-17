# ZeroScript-Win — Local-First AI Development Environment

ZeroScript-Win is a GPL-3.0-or-later fork of ZeroScript Free evolving into a local-first, VS Code-inspired development environment powered through supported AI chat sites.

The extension preserves the existing browser-provider integrations and Roblox Studio capabilities. General project editing and Roblox Studio automation are separate domains: the local workspace layer works with Studio closed, while live Roblox tools use the explicit `roblox/` namespace.

## Current status

**Workspace-first IDE remaster in progress (v1.11.0).**

The bridge exposes an expanded, project-scoped toolset:

- Persistent local workspace selection, native folder picker, and a recent-project list for switching between saved workspaces.
- Project metadata, detected package manager, popular framework/tooling hints, package scripts, and source inventory.
- An agent-facing declared-task runner (`workspace_run_task`) that refuses scripts not present in the root `package.json`.
- Bounded file reads that preserve original CRLF/LF line endings, a depth-limited project tree, recursive file listing, glob search, regex/case-sensitive text search, and line/column matches.
- Source-file outlines for imports, headings, variables, and declarations, plus cross-language declaration/symbol discovery.
- Exact-match patch edits, validated multi-file edit batches, preview-first Replace in Files for literal or regex replacements, stale-preview protection, and complete-file writes that return unified diffs.
- Safe no-overwrite file/directory creation, rename/move, and single-file delete operations. Directory deletion and symbolic-link mutation are refused.
- Git status, structured changed-file listing, staged/unstaged diffs, branch listing, recent history, single-file stage/unstage, and confirmed local commits (no automatic push).
- A dedicated Workspace Explorer page with file tree, multi-tab text editor with independent unsaved buffers, lightweight syntax coloring and line numbers, keyboard indentation, Save All, close-tab controls, fuzzy Quick Open, a searchable Command Palette, in-file Find/Replace, folder-scoped search and preview-first multi-file replace, outline/project panes, per-file Git diff/stage/unstage actions, output/problems panes, clickable build/test diagnostics, and argv-based command runner.
- Dedicated editor utility and diagnostic-parser modules with automated tests. Build/test diagnostics normalize common compiler/linter output into safe workspace-relative file/line links; absolute paths outside the selected workspace are not navigable.
- One-click project Test/Build/Lint/Check tasks discovered from package.json and package manager metadata, each with an explicit confirmation.
- Bounded command execution from the selected project directory using an argument array and `shell=False`.

## Choose a workspace

On a fresh install, the agent asks which project folder to use before inspecting or changing files. Reply with the absolute folder path, or use **Choose workspace folder** in the extension popup to open the native folder picker. The picker only proposes a folder; ZeroScript activates and saves it after the selection is confirmed. The choice is saved in a private local `.zs-workspace.json` file and reused on subsequent starts.

An optional environment override is also supported:

```powershell
$env:ZS_WORKSPACE_ROOT = 'D:\Projects\MyApp'
py -3 bridge.py
```

The environment setting takes precedence over the saved folder. To change projects, use the popup folder picker or provide a new absolute path to the agent. The default fallback is the installation directory only for compatibility; the AI must not inspect it as a project until the user explicitly selects it.

## Two distinct tool domains

- **Workspace tools** (`workspace_*`) read and edit files on disk, inspect project structure, run relevant commands, and query Git.
- **Roblox Studio tools** (`roblox/*`) operate against the live Studio/DataModel through the optional Roblox MCP adapter.

The local workspace root and the open Roblox place are not interchangeable. Use each domain only for the actions it actually controls; use both only when a task needs both.

## Run the workspace tests

Requires Python 3.10 or later.

```powershell
py -3 -m unittest workspace_agent.test_tools workspace_agent.test_bridge -v
node zeroscript-extension/core/config.test.cjs
node zeroscript-extension/workspace-diagnostics.test.cjs
node zeroscript-extension/workspace-editor-utils.test.cjs
```

## Security notes

The workspace layer checks resolved paths against the selected root, bounds text operations, and launches commands without shell expansion. These controls reduce accidental scope and shell-injection risk, but do **not** make arbitrary programs harmless or constitute a security sandbox. Command execution does not yet have a per-command approval dialog. Select only trusted folders and do not expose the local bridge beyond loopback.

See [Workspace Agent Remaster](docs/WORKSPACE_AGENT.md) for tool details and boundaries.

## Upstream project

This project is derived from [sebattfg/ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free). Preserve original license and copyright notices; identify modifications made in this fork.

Licensed under [GNU GPL v3](LICENSE).
