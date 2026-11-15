# Changelog

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
  line required; double-click launchers for Windows, macOS and Linux.
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
