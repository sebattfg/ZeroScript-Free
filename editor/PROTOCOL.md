# Editor bridge protocol (v1)

NonZeroScript is editor-agnostic. The browser extension and the controller
never talk to an editor directly: they only use the two HTTP endpoints below.
Each editor ships one adapter folder under `editor/` that implements them.

The **reference adapter is `editor/godot-4.7.2/`** (GDScript + C#). Any other
editor — Unity, Unreal, LÖVE, a custom engine — can be added without touching
the extension, the controller or the prompt.

```
AI chat page ──extension──▶ controller (127.0.0.1:8790) ──poll──▶ editor adapter
                                   ▲                                 │
                                   └──────── result (id, ok, …) ─────┘
```

## Rules the adapter must follow

1. **Outbound polling only.** The adapter POSTs to the controller; it never
   listens on a port. No firewall prompt, no inbound surface.
2. **One command at a time**, executed on the editor's main thread.
3. **The adapter owns safety.** It decides which paths are writable, protects
   its own files and version control, and offers a read-only switch.
4. **Results are JSON-safe and compact** (the controller truncates them).
5. **No secrets.** The adapter stores its config in the editor's own user
   directory, never in the project.

## `POST /api/editor/poll`

Heartbeat + work queue, called every ~0.4 s (the controller can ask for a
different cadence, see `settings.poll_ms`).

Request body:

| Field | Type | Meaning |
|---|---|---|
| `editorId` | string | Stable id, e.g. `godot-1a2b3c4d` |
| `version` | string | Adapter version |
| `project` | string | Project / solution name |
| `projectPath` | string | Absolute path on the machine |
| `engine` | string | Engine + version, e.g. `4.7.2` |
| `openScene` | string | Current scene/document, or `""` |
| `playing` | bool | Is a play-test running |
| `writeEnabled` | bool | The human's write toggle |
| `csharp` | bool | (optional) C# toolchain available |
| `dotnet` | bool | (optional) project has `.csproj`/`.sln` |

Response:

```json
{
  "ok": true,
  "commands": [{"id": "ab12cd", "command": "read_file", "params": {"path": "res://project.godot"}}],
  "queue": 0,
  "settings": {"max_result_chars": 12000, "poll_ms": 400, "perf_mode": "balanced"},
  "controller": {"version": "v0.1.0-dev", "now": "2026-11-15T11:00:00Z"}
}
```

- `commands` is at most 24 entries; execute them in order.
- `settings.poll_ms` is the cadence the controller wants (eco mode slows it
  down). `max_result_chars` is the cap applied to the result text.
- A command name the adapter does not implement must return an `ok: false`
  result with a clear error, never an exception.

## `POST /api/editor/result`

```json
{"id": "ab12cd", "ok": true, "result": {"path": "res://project.godot", "written": true}}
```

```json
{"id": "ab12cd", "ok": false, "error": "path is protected: res://project.godot"}
```

- `id` must be the one from the poll; unknown ids are ignored (idempotent retry).
- `result` must be JSON-serialisable. If it is a string, it is used as-is.
- The controller maps `ok: false` to an `ERROR: …` turn, so the AI can repair.

## Command catalogue

The commands themselves live in `controller/tools.json` (29 for the Godot
adapter). The prompt is generated from that file, so an adapter can ship a
different catalogue by pointing the controller at another JSON file — the
extension never hard-codes tool names.

Groups used by the console and the prompt: `read`, `edit`, `scene`, `run`,
`tool`.

## Adding an adapter

```
editor/
  PROTOCOL.md
  godot-4.7.2/      the reference adapter (installs as addons/nonzeroscript)
  your-engine/      one folder per editor, one download each
```

1. Implement the two endpoints and the status fields above.
2. Describe the commands in `controller/tools.json` (or a per-adapter copy), so
   the prompt the AI receives lists the new tools.
3. Add the engine to the table below.

## Supported adapters

| Editor | Folder | Languages | Status |
|---|---|---|---|
| Godot 4.7.2 | `godot-4.7.2/` | GDScript, C# | ✅ shipped |
| Unity | — | C# | planned |
| Unreal Engine | — | C++, Blueprint | planned |

"Planned" means the protocol supports it, not that a plugin exists yet. Do not
claim support for an editor that has no folder here.
