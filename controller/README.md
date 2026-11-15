# controller — visual console + local relay

The controller is the only piece that knows the whole picture. It is a single
Python program with **no third-party dependencies** (Python 3.9+ standard
library only).

```
controller/
  main.py           entry point (starts the server, opens the console)
  metrics.py        real RSS figure shown in the console (Windows/macOS)
  server.py         HTTP routing (console + JSON API)
  hub.py            sessions, editor, tasks, rotation, execution
  memory.py         timeline files (tasks/ and sessions/)
  settings.py       settings.json + defaults
  tools.json        command catalogue (single source of truth)
  ui/               console page (plain HTML/CSS/JS, no build)
  data/             created on first run: settings.json + memory/
  start.bat / start.command        (Windows 10/11 and macOS; no Linux support)
```

## Run

Double-click the launcher for your OS, or:

```bash
python3 main.py
python3 main.py --port 9000 --no-open
python3 main.py --host 0.0.0.0      # remote demo only; exposes file editing
```

Supported hosts: **Windows 10/11 (64/32-bit)** and **macOS (64/32-bit)**. The
relay is plain standard-library Python, so any 32-bit Python 3.9+ works. Linux is
not supported and not tested.

The console is served at <http://127.0.0.1:8790/> and opens automatically.

## How turns flow

```
POST /api/task/add                console queues a task
POST /api/session/poll            browser tab asks for work
   ← assign {turnId, text, minDelay, maxDelay}
POST /api/session/report          tab returns one reply + at most one command
   → hub executes the command through /api/editor/*
   → memory.append(...)
   → next turn is created and assigned to the NEXT ready session
```

One task runs at a time; `max_turns` caps it. `rotation` or a per-task provider
filter decides which tab is eligible. A tab is eligible only while its state is
`ready`, it has no turn in flight, and it was seen within `session_timeout`.

## API (short version)

| Endpoint | Purpose |
|---|---|
| `POST /api/status` | console + popup status |
| `POST /api/tools` | command catalogue |
| `POST /api/settings` | update settings |
| `POST /api/session/register` | tab hello (returns tools, editor, settings) |
| `POST /api/session/poll` | heartbeat + optional assignment |
| `POST /api/session/report` | reply, command, parse error, done |
| `POST /api/session/stop` | detach a tab (also pauses its task) |
| `POST /api/session/close` | tab closed |
| `POST /api/session/enable` | include/exclude a tab from rotation (the console's 轮换 checkbox) |
| `POST /api/editor/poll` | plugin heartbeat + queued commands |
| `POST /api/editor/result` | plugin result |
| `POST /api/task/add` | queue a task |
| `POST /api/task/stop` | stop everything (or pause one with `taskId`) |
| `POST /api/execute` | manual command (console test button) |
| `POST /api/memory` | timeline list / task / session / file detail |
| `POST /api/logs?since=N` | incremental log |

Every response is JSON with `ok`. The server binds `127.0.0.1` by default.

## Performance modes

`settings.json` carries `perf_mode` (`eco`, `balanced`, `turbo`). A profile owns
eight keys — `log_limit`, `keep_tasks`, `memory_context_entries`,
`memory_context_chars`, `max_result_chars`, `ui_refresh_ms`, `session_poll_ms`,
`editor_poll_ms` — and switching mode applies them in one shot, so the file
always shows the numbers that are in use and they can still be fine-tuned.

| Mode | log ring | result cap | console poll | browser poll | editor poll |
|---|---|---|---|---|---|
| `eco` | 120 | 6 000 | 2 000 ms | 1 500 ms | 1 000 ms |
| `balanced` | 800 | 12 000 | 900 ms | 1 200 ms | 400 ms |
| `turbo` | 2 000 | 20 000 | 400 ms | 500 ms | 250 ms |

- `/api/status` exposes the active profile plus `perf.rss_mb`, the **measured**
  resident set size of the relay process (`metrics.py`).
- The log ring is rebuilt on settings change (`Hub.apply_runtime_settings`), and
  finished tasks beyond `keep_tasks` are dropped from memory (the timeline files
  stay).
- `memory_keep_days` prunes old timeline files at startup and on save.
- The editor adapter receives `settings.poll_ms` on every poll, so eco mode also
  slows the Godot bridge.

## Memory

```
data/memory/tasks/20261115-103000-a1b2c3d4.jsonl
data/memory/sessions/Chrome-deepseek-9f3a2c11.jsonl
```

Each line is `{ts, t, kind, ...}` with `kind` one of `task`, `dispatch`,
`reply`, `tool`, `note`. `brief()` compresses the newest N entries into the
text that is prepended to a rotated turn. Delete the folder to forget
everything; nothing leaves the machine.

Rotation is opt-in **per session**: the console lists every connected tab with a
**轮换** checkbox. One ticked session runs everything on itself; two or more
switch `/api/status.rotation.active` to `true` and the hub round-robins between
them. `GET /api/status.rotation` reports `{switch, eligible, active, mode}`.

## Safety notes

- The controller has no authentication. Keep it on `127.0.0.1`; `--host 0.0.0.0`
  is only for a deliberate demo and exposes project file editing to your LAN.
- On loopback it rejects cross-site API calls (no CORS headers, Origin checked)
  and non-local `Host` headers, so a random website cannot drive the relay.
- Tool execution is gated by the Godot dock's **允许 AI 写入** checkbox and the
  plugin's path guards.
- Commands time out after `editor_timeout` (30 s default). A lost browser turn
  is retried up to 3 times on another session before the task fails.

## Test

From the repository root:

```bash
python3 tools/smoke_test.py    # controller + fake editor + two fake browsers
```
