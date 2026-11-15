# Changelog

## 0.2.0 — 2026-11-15

### Added

- **Multi-editor architecture.** The relay and the extension only speak the
  bridge protocol now documented in `editor/PROTOCOL.md`; every editor gets one
  folder under `editor/` and one build artifact. Godot 4.7.2 stays the shipped
  adapter (29 commands, GDScript + C#); Unity/Unreal are listed as *planned*
  (protocol only, no plugin).
- **`prompts/`** — the instructions the AI runs on, in one reviewable folder:
  `system-prompt.md` (template + placeholders), `agent-rules.md` (checklist),
  `tool-catalogue.md` (generated from `controller/tools.json`),
  `repair-messages.md` (parse-error feedback). `tools/prompts.py` regenerates
  the catalogue and `--check` fails on drift.
- **Three performance modes** (`perf_mode`: `eco` / `balanced` / `turbo`). A
  profile owns the log ring, task retention, memory-brief size, result cap and
  the console/browser/editor poll cadences, and switching applies them at once.
  `eco` targets < 30 MB RSS; the console shows the **measured** value
  (`controller/metrics.py`, Windows + macOS) and the mode is forwarded to the
  Godot bridge (`settings.poll_ms`), so the plugin slows down too.
- **Rotation is chosen per browser.** Every session keeps its **轮换**
  checkbox, the session card gained **全选轮换 / 全不选**, and `/api/status`
  reports `rotation: {switch, eligible, active, mode}` — one ticked session is
  single-browser mode, two or more turn round-robin on.
- **Prebuilt releases are committed** in `dist/` (`controller.zip`,
  `extension.zip`, `editor-godot-4.7.2.zip`, `NonZeroScript-0.2.0.zip`,
  `SHA256SUMS.txt`).
- `tools/build.py --check` — verifies the version string in all seven places and
  the prompt docs, and refuses to build when they disagree.
- `tools/clean_master.sh` — builds a parentless `master` containing only
  `README.md`, `README.zh-CN.md`, `LICENSE` and `NOTICE` (taken from the current
  branch), with a dry run, a `--no-push` test mode and an explicit `--yes`.
- `memory_keep_days` (prune old timelines), bounded task retention
  (`keep_tasks`), `memory.disk_usage()` and a `/api/memory` disk figure.

### Changed

- **Platforms are Windows 10/11 and macOS, 64-bit and 32-bit.** Linux support
  was removed: `controller/start.sh` is gone and the docs, build script and
  install text no longer mention it.
- README (both languages) re-framed around "multi-editor", with a full Chinese
  introduction, the performance-mode table and the rotation selection.
- Version bumped to **0.2.0** in `version.txt`, `controller/version.py`,
  `extension/manifest.json`, `controller/tools.json`, `plugin.cfg`,
  `commands.gd` and `bridge.gd`.
- `.gitignore` tracks `dist/*.zip` (the repository is the download) and only
  ignores PyInstaller output.
- Console: 性能模式 card, performance pill with live RSS, 编辑器 wording,
  adaptive refresh interval taken from the active profile.

### Fixed

- Task list in `/api/status` is capped by `keep_tasks` instead of a hard-coded
  40, and finished tasks are pruned from memory (timeline files are kept).
- `Memory.list_tasks()` no longer reads every timeline file on each call
  (`limit`, default 40), which matters in eco mode.

## 0.1.0 — 2026-11-15

First release of **NonZeroScript**, the official Godot edition of ZeroScript.
Rebuilt from ZeroScript 1.5.5; the agent-loop idea, command protocol and
per-site provider adapters are derived from upstream and remain GPL-3.0.

### Added

- **Godot 4.7.2 editor plugin** (`editor/godot-4.7.2`). A 29-command toolset:
  project/file inspection and editing, scene tree and node editing (undoable),
  script attachment, scene creation/opening/saving, project settings,
  play-testing, editor log reading, filesystem rescans and editor screenshots.
  Outbound HTTP polling only; no inbound port. Path guards, write toggle and
  protected paths.
- **GDScript and C#** — `.gd` and `.cs` scripts go through the same
  write/edit/attach path. `###CSHARP###` code blocks, `attach_script`
  (undoable), `add_node`/`create_scene` `script_path`, and `get_editor_state`
  reporting `csharp`/`dotnet`/`language` so the AI picks a language that the
  open editor can actually compile. Standard (non-.NET) Godot builds still
  accept `.cs` writes but return a `warning` and refuse to attach them.
- **Visual controller** (`controller/`) — standard-library Python relay with a
  browser console at `http://127.0.0.1:8790`: task queue, live sessions, editor
  status, live log, timeline browser, command tester and settings. No command
  line required; double-click launchers for Windows 10/11 and macOS
  (64-bit and 32-bit; Linux is not supported).
- **Random input delay** between a configurable minimum and maximum (default
  2–6 s), applied before every simulated input and shown as a countdown in the
  page bar.
- **Multi-browser AI rotation** — round-robin across any number of ready tabs
  and providers, per-task provider filter, per-session enable/disable, retry on
  another session when a tab dies.
- **Timeline memory** — one JSONL timeline per task and per browser session in
  `controller/data/memory/`, with a compact memory brief prepended to rotated
  turns so a different AI can continue the work.
- **Browser extension for Chrome and Edge** (`extension/`, MV3) — rewritten
  agent loop and transport for the controller; in-page bar with start/stop,
  connection state, delay countdown and command chips; popup with controller
  status and address.
- **Eight providers:** ChatGPT (new composer support), DeepSeek, Gemini, Kimi,
  GLM (chat.z.ai), Qwen, Meta AI and Arena. Arena is locked to Direct mode.
- **Build and test tooling** — `tools/build.py` (one artifact per editor
  folder, one extension, one controller, one combined release, SHA-256 sums),
  `tools/smoke_test.py` (controller + fake editor + rotation end-to-end) and
  `tools/test_parser.js` (command parser cases). No CI; builds are manual.

### Changed from ZeroScript 1.5.5

- No Roblox Studio, Roblox MCP bridge, Luau or Studio-specific instructions.
- No command-line bridge: the relay is a visual console with a JSON API.
- Provider prompts and UI strings now describe Godot and NonZeroScript.
- Command catalogue moved to `controller/tools.json` (single source of truth
  for the prompt, the console and the editor plugin).
- Scripts are sent in explicit `###GDSCRIPT###` or `###CSHARP###` blocks instead
  of `###LUA###`; legacy `###LUA###` markers still parse.
- `.cs`, `.csproj` and `.sln` are pinned to LF in `.gitattributes`.

### Known limitations

- The Godot plugin targets 4.7.2; adjacent 4.x versions are untested.
- C# support is untested against a real .NET Godot build: it is implemented
  with feature detection (`CSharpScript`, `OS.has_feature("dotnet")`, the Script
  loader's extension list) and degrades to a clear error without .NET.
- v0.1.0 is text-first: screenshots are saved for the human but not sent to the
  AI, and there is no image/asset generation or asset-library browsing yet.
- AI website DOMs change; provider adapters may need selector updates.
