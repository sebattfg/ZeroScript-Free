# SPDX-License-Identifier: GPL-3.0-or-later
"""The hub: sessions, editor, tasks, rotation, execution and memory.

This module is deliberately transport-agnostic (no HTTP here). `server.py`
exposes it to the browser extension, the visual console and the Godot plugin.

Key ideas
---------
* A browser tab registers once, then polls. The controller decides which tab
  gets the next turn (round-robin) - that is the multi-browser rotation.
* One task runs at a time. Each turn = one AI reply = at most one command.
  The command is executed against the connected Godot editor and the result
  becomes the next turn's prompt, which may be assigned to a DIFFERENT tab.
* Every turn is written to a timeline. Before a tab that has not seen the task
  gets a turn, the controller prepends a compact memory brief.
"""

from __future__ import annotations

import json
import random
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:  # package import (python -m controller.main)
    from .memory import Memory
    from .settings import PROVIDERS, Settings
    from .version import __version__
except ImportError:  # standalone import (python controller/main.py)
    from memory import Memory
    from settings import PROVIDERS, Settings
    from version import __version__


def now() -> float:
    return time.time()


def iso(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or now(), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def ago(ts: float) -> float:
    return round(max(0.0, now() - ts), 1)


@dataclass
class Pending:
    id: str
    command: str
    params: dict[str, Any]
    created: float
    event: threading.Event = field(default_factory=threading.Event)
    ok: bool = False
    result: Any = None
    error: str = ""


@dataclass
class Turn:
    id: str
    task_id: str
    prompt: str
    kind: str
    created: float
    session_id: str = ""
    assigned_at: float = 0.0
    acked: bool = False


@dataclass
class Task:
    id: str
    prompt: str
    provider: str = ""
    state: str = "queued"  # queued|running|waiting|done|paused|stopped|error
    created: float = field(default_factory=now)
    steps: list[str] = field(default_factory=list)
    turns: int = 0
    repairs: int = 0
    rr: int = 0
    current_turn: Optional[Turn] = None
    last_reply: str = ""
    error: str = ""
    finished_at: float = 0.0
    dead_retries: int = 0


@dataclass
class Session:
    id: str
    browser: str
    browser_id: str
    provider: str
    display_name: str
    label: str
    page_url: str
    version: str
    conversation: str = ""
    state: str = "registered"
    enabled: bool = True
    registered_at: float = field(default_factory=now)
    last_seen: float = field(default_factory=now)
    turn: Optional[Turn] = None
    assign_sent: bool = False
    stop_flag: bool = False
    stats: dict[str, int] = field(default_factory=lambda: {"turns": 0, "commands": 0, "errors": 0})

    def alive(self, timeout: float) -> bool:
        return now() - self.last_seen <= timeout


@dataclass
class Editor:
    id: str = ""
    project: str = ""
    project_path: str = ""
    engine: str = ""
    open_scene: str = ""
    playing: bool = False
    write_enabled: bool = True
    version: str = ""
    last_seen: float = 0.0
    connected: bool = False
    queue: list[Pending] = field(default_factory=list)
    pending: dict[str, Pending] = field(default_factory=dict)


class Hub:
    def __init__(self, settings: Settings, data_dir: Path, controller_dir: Path):
        self.settings = settings
        self.data_dir = Path(data_dir)
        self.memory = Memory(data_dir)
        self.lock = threading.RLock()
        self.started = now()
        self.sessions: dict[str, Session] = {}
        self.editor = Editor()
        self.tasks: dict[str, Task] = {}
        self.task_order: list[str] = []
        self.active_task_id: Optional[str] = None
        self.logs: deque[dict[str, Any]] = deque(maxlen=800)
        self.log_seq = 0
        self._stop = False
        self._tools: list[dict[str, Any]] = []
        self._tools_by_name: dict[str, dict[str, Any]] = {}
        self._load_tools(controller_dir / "tools.json")
        self.host = str(settings.get("host"))
        self.port = int(settings.get("port"))
        threading.Thread(target=self._reaper, name="nzs-reaper", daemon=True).start()
        threading.Thread(target=self._log_flusher, name="nzs-stdout", daemon=True).start()

    # ══════════════════════════════════════════════════════════════════════
    #  TOOLS
    # ══════════════════════════════════════════════════════════════════════
    def _load_tools(self, path: Path) -> None:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            tools = data.get("tools", [])
            if isinstance(tools, list):
                self._tools = [t for t in tools if isinstance(t, dict) and t.get("name")]
                self._tools_by_name = {t["name"]: t for t in self._tools}
        except Exception as e:
            self.log("error", f"could not load tools.json: {e}")
        if not self._tools:
            self._tools = [{"name": "list_tools", "description": "List commands.", "params": {}}]
            self._tools_by_name = {"list_tools": self._tools[0]}

    def tools(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self._tools)

    def tools_text(self) -> str:
        lines = []
        for t in self.tools():
            params = t.get("params") or {}
            args = ", ".join(k + ("" if (p or {}).get("required") else "?") for k, p in params.items())
            lines.append(f"{t['name']}({args}) - {(t.get('description') or '').splitlines()[0]}")
        return "\n".join(lines)

    # ══════════════════════════════════════════════════════════════════════
    #  LOGGING
    # ══════════════════════════════════════════════════════════════════════
    def log(self, level: str, message: str, **extra: Any) -> None:
        with self.lock:
            self.log_seq += 1
            entry = {"seq": self.log_seq, "ts": iso(), "level": level, "message": message, "extra": extra or {}}
            self.logs.append(entry)
        print(f"[{entry['ts'][11:19]}] {level.upper():5s} {message}", flush=True)

    def logs_since(self, since: int) -> dict[str, Any]:
        with self.lock:
            entries = [e for e in self.logs if e["seq"] > since]
            return {"ok": True, "entries": entries, "last": self.log_seq}

    def _log_flusher(self) -> None:
        # stdout is flushed on write; this thread only keeps the process alive
        # cheaply and could later forward logs to a file.
        while not self._stop:
            time.sleep(5)

    # ══════════════════════════════════════════════════════════════════════
    #  SESSIONS
    # ══════════════════════════════════════════════════════════════════════
    def register_session(self, p: dict[str, Any]) -> dict[str, Any]:
        sid = str(p.get("sessionId") or "").strip() or uuid.uuid4().hex[:12]
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                s = Session(
                    id=sid,
                    browser=str(p.get("browser") or "Browser"),
                    browser_id=str(p.get("browserId") or ""),
                    provider=str(p.get("provider") or "unknown"),
                    display_name=str(p.get("displayName") or p.get("provider") or "AI"),
                    label=str(p.get("label") or ""),
                    page_url=str(p.get("pageUrl") or ""),
                    version=str(p.get("version") or ""),
                )
                if not s.label:
                    s.label = f"{s.browser} · {s.display_name}"
                self.sessions[sid] = s
                self.log("session", f"浏览器会话接入：{s.label}", session=sid)
            else:
                s.browser = str(p.get("browser") or s.browser)
                s.browser_id = str(p.get("browserId") or s.browser_id)
                s.provider = str(p.get("provider") or s.provider)
                s.display_name = str(p.get("displayName") or s.display_name)
                s.page_url = str(p.get("pageUrl") or s.page_url)
                s.version = str(p.get("version") or s.version)
                if p.get("label"):
                    s.label = str(p.get("label"))
            s.last_seen = now()
            s.conversation = str(p.get("conversation") or s.conversation)
            # A page reload reports "registered", so it is never auto-ready.
            # A reconnect from a page that is still bootstrapped reports "ready"
            # and keeps that state.
            incoming = str(p.get("state") or "registered")
            if s.turn is None:
                s.state = incoming if incoming in ("registered", "starting", "ready", "busy", "stopped") else "registered"
            editor = self._editor_status_locked()
            self._dispatch_locked()
            return {
                "ok": True,
                "sessionId": sid,
                "settings": self.settings.public(),
                "tools": self.tools(),
                "editor": editor,
                "state": s.state,
            }

    def session_poll(self, p: dict[str, Any]) -> dict[str, Any]:
        sid = str(p.get("sessionId") or "")
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                return {"ok": False, "error": "unknown session; re-register", "code": "unknown_session"}
            s.last_seen = now()
            if p.get("conversation"):
                s.conversation = str(p["conversation"])
            incoming = str(p.get("state") or "").strip()
            if incoming and s.turn is None:
                # Never overwrite "assigned" while a turn is out.
                s.state = incoming
            elif incoming in ("busy", "starting") and s.turn is not None:
                s.turn.acked = True

            if s.stop_flag:
                s.stop_flag = False
                s.state = "ready" if s.state == "stopped" else s.state
                return {"ok": True, "stop": True, "settings": self.settings.public(), "editor": self._editor_status_locked()}

            self._dispatch_locked()
            payload = self._turn_payload_locked(s)
            return {
                "ok": True,
                "assign": payload,
                "settings": self.settings.public(),
                "editor": self._editor_status_locked(),
                "state": s.state,
            }

    def _turn_payload_locked(self, s: Session) -> Optional[dict[str, Any]]:
        turn = s.turn
        if not turn or s.assign_sent:
            return None
        task = self.tasks.get(turn.task_id)
        if not task or turn.task_id != task.id:
            return None
        s.assign_sent = True
        s.state = "assigned"
        turn.assigned_at = now()
        self.memory.append_task(
            task.id,
            {
                "kind": "dispatch",
                "turn": task.turns,
                "session": s.id,
                "label": s.label,
                "provider": s.provider,
                "text": turn.prompt[:1200],
                "state": task.state,
            },
        )
        self.log("assign", f"回合 {task.turns} → {s.label}", task=task.id, session=s.id, kind=turn.kind)
        return {
            "turnId": turn.id,
            "taskId": task.id,
            "taskPrompt": task.prompt,
            "kind": turn.kind,
            "text": turn.prompt,
            "turnIndex": task.turns,
            "minDelay": self.settings.get("min_delay"),
            "maxDelay": self.settings.get("max_delay"),
            "provider": task.provider or "",
        }

    def session_report(self, p: dict[str, Any]) -> dict[str, Any]:
        sid = str(p.get("sessionId") or "")
        turn_id = str(p.get("turnId") or "")
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                return {"ok": False, "error": "unknown session"}
            s.last_seen = now()
            turn = s.turn
            if not turn or turn.id != turn_id:
                return {"ok": True, "ignored": True, "state": s.state}
            task = self.tasks.get(turn.task_id)
            if not task:
                s.turn = None
                return {"ok": True, "ignored": True}
            reply = str(p.get("reply") or "")[:120000]
            cmd = p.get("command") if isinstance(p.get("command"), dict) else None
            parse_error = str(p.get("parseError") or "").strip() or None
            error = str(p.get("error") or "").strip() or None
            done = bool(p.get("done")) and not cmd and not parse_error

            # Close the turn on the controller side before executing, so a
            # concurrent poll can never see it as still pending.
            s.turn = None
            s.assign_sent = False
            s.state = "finishing"
            s.stats["turns"] += 1
            task.current_turn = None
            task.dead_retries = 0
            task.last_reply = reply
            self.log("turn", f"{s.label} 回合完成：{len(reply)} 字符", task=task.id, done=done, error=error)

            mem = {
                "kind": "reply",
                "session": s.id,
                "label": s.label,
                "provider": s.provider,
                "text": reply[:4000],
                "done": done,
                "error": error,
                "turn": task.turns,
                "state": task.state,
            }
            self.memory.append_task(task.id, mem)
            self.memory.append_session(s, mem)

        exec_info = None
        cmd_name = ""
        if cmd:
            cmd_name = str(cmd.get("command") or "").strip()
            params = cmd.get("params") if isinstance(cmd.get("params"), dict) else {}
            exec_info = self.execute(cmd_name, params, source=f"session:{s.id}")
            with self.lock:
                s.stats["commands"] += 1
                if not exec_info.get("ok"):
                    s.stats["errors"] += 1
                self.memory.append_task(
                    task.id,
                    {
                        "kind": "tool",
                        "session": s.id,
                        "label": s.label,
                        "command": cmd_name,
                        "ok": bool(exec_info.get("ok")),
                        "preview": str(exec_info.get("preview") or "")[:1500],
                        "text": str(exec_info.get("text") or "")[:1500],
                        "turn": task.turns,
                    },
                )
                self.memory.append_session(
                    s,
                    {
                        "kind": "tool",
                        "label": s.label,
                        "command": cmd_name,
                        "ok": bool(exec_info.get("ok")),
                        "preview": str(exec_info.get("preview") or "")[:500],
                    },
                )

        with self.lock:
            # Keep the reporting tab in "finishing" until its next poll says
            # "ready". That prevents the controller from handing the same tab
            # the next turn while it is still processing this report.
            if task.state in ("stopped", "paused", "error", "done"):
                return {"ok": True, "ignored": True, "taskState": task.state}

            if error == "stopped":
                task.state = "paused"
                task.error = "浏览器侧停止了任务"
                task.finished_at = now()
                self._finish_task_locked(task, "paused")
                return {"ok": True, "taskState": task.state, "executed": bool(cmd)}

            if error:
                task.state = "done"
                task.error = error
                task.finished_at = now()
                self.memory.append_task(task.id, {"kind": "note", "text": f"task ended with error: {error}", "state": "error"})
                self._finish_task_locked(task, "error")
                return {"ok": True, "taskState": task.state, "executed": bool(cmd)}

            if done:
                task.state = "done"
                task.error = ""
                task.finished_at = now()
                self.memory.append_task(task.id, {"kind": "note", "text": "task finished", "state": "done"})
                self.log("task", f"任务完成：{task.prompt[:60]}", task=task.id)
                self._finish_task_locked(task, "done")
                return {"ok": True, "taskState": task.state, "executed": bool(cmd), "done": True}

            if task.turns >= int(self.settings.get("max_turns")):
                task.state = "error"
                task.error = f"达到最大回合数（{self.settings.get('max_turns')}）"
                task.finished_at = now()
                self.log("warn", task.error, task=task.id)
                self._finish_task_locked(task, "error")
                return {"ok": True, "taskState": task.state, "executed": bool(cmd)}

            if exec_info is not None:
                if exec_info.get("ok"):
                    next_prompt = f"Output of '{cmd_name}':\n{exec_info.get('text')}"
                else:
                    next_prompt = f"ERROR: {exec_info.get('text')}"
            elif parse_error:
                task.repairs += 1
                feedback = str(p.get("feedback") or "").strip()
                if not feedback:
                    feedback = (
                        f"ERROR: the reply used an invalid command format ({parse_error}). "
                        'Reply with ONE JSON object: {"command": "name", "params": { ... }}.'
                    )
                next_prompt = feedback
                self.memory.append_task(task.id, {"kind": "note", "text": f"repair requested: {parse_error}", "state": "repair"})
            else:
                next_prompt = "Continue."

            task.steps.insert(0, next_prompt)
            task.state = "running"
            self._dispatch_locked()
            return {
                "ok": True,
                "taskState": task.state,
                "executed": bool(cmd),
                "okResult": bool(exec_info.get("ok")) if exec_info else None,
                "resultPreview": str(exec_info.get("preview") or "")[:400] if exec_info else "",
            }

    def session_stop(self, sid: str, reason: str = "user") -> dict[str, Any]:
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                return {"ok": True}
            s.state = "stopped"
            s.stop_flag = False
            turn = s.turn
            s.turn = None
            s.assign_sent = False
            if turn:
                task = self.tasks.get(turn.task_id)
                if task and task.current_turn is turn:
                    task.current_turn = None
                    task.state = "paused"
                    task.error = f"会话停止：{reason}"
                    task.finished_at = now()
                    self.memory.append_task(task.id, {"kind": "note", "text": task.error, "state": "paused"})
                    self.log("warn", f"{s.label} 停止：{reason}", task=task.id)
                    self._finish_task_locked(task, "paused")
            return {"ok": True, "state": s.state}

    def close_session(self, sid: str) -> dict[str, Any]:
        with self.lock:
            s = self.sessions.pop(sid, None)
            if s:
                self.log("session", f"会话断开：{s.label}", session=sid)
                if s.turn:
                    self._dead_turn_locked(s, "browser tab closed")
            return {"ok": True}

    def enable_session(self, sid: str, enabled: bool) -> dict[str, Any]:
        with self.lock:
            s = self.sessions.get(sid)
            if not s:
                return {"ok": False, "error": "unknown session"}
            s.enabled = bool(enabled)
            self.log("session", f"{s.label} 轮换 {'启用' if s.enabled else '停用'}", session=sid)
            if s.enabled:
                self._dispatch_locked()
            return {"ok": True, "enabled": s.enabled}

    # ══════════════════════════════════════════════════════════════════════
    #  TASKS / ROTATION
    # ══════════════════════════════════════════════════════════════════════
    def add_task(self, prompt: str, provider: str = "") -> dict[str, Any]:
        prompt = str(prompt or "").strip()
        if not prompt:
            return {"ok": False, "error": "task prompt is empty"}
        provider = str(provider or "").strip()
        if provider and provider not in {p["id"] for p in PROVIDERS}:
            return {"ok": False, "error": f"unknown provider '{provider}'"}
        with self.lock:
            task = Task(
                id=uuid.uuid4().hex[:8],
                prompt=prompt,
                provider=str(provider or ""),
                steps=[prompt],
            )
            self.tasks[task.id] = task
            self.task_order.append(task.id)
            self.memory.append_task(task.id, {"kind": "task", "text": prompt, "provider": task.provider, "state": "queued"})
            self.log("task", f"新任务：{prompt[:70]}", task=task.id, provider=task.provider or "any")
            self._dispatch_locked()
            return {"ok": True, "task": self._task_dict_locked(task)}

    def stop_all(self) -> dict[str, Any]:
        with self.lock:
            for s in self.sessions.values():
                s.stop_flag = True
                s.turn = None
                s.assign_sent = False
                if s.state in ("assigned", "busy", "finishing"):
                    s.state = "ready"
            for t in self.tasks.values():
                if t.state in ("queued", "running", "waiting"):
                    t.state = "stopped"
                    t.finished_at = now()
                    if t.current_turn:
                        t.current_turn = None
                    self.memory.append_task(t.id, {"kind": "note", "text": "stopped by console", "state": "stopped"})
            self.active_task_id = None
            self.log("warn", "已停止全部任务与会话")
            return {"ok": True}

    def pause_task(self, task_id: str = "") -> dict[str, Any]:
        with self.lock:
            tid = task_id or self.active_task_id or ""
            task = self.tasks.get(tid)
            if not task:
                return {"ok": False, "error": "no active task"}
            task.state = "paused"
            task.error = "paused by console"
            task.finished_at = now()
            if task.current_turn:
                s = self.sessions.get(task.current_turn.session_id)
                if s and s.turn is task.current_turn:
                    s.turn = None
                    s.assign_sent = False
                    s.stop_flag = True
                task.current_turn = None
            self._finish_task_locked(task, "paused")
            return {"ok": True, "task": self._task_dict_locked(task)}

    def _start_next_task_locked(self) -> bool:
        if self.active_task_id:
            return True
        for tid in self.task_order:
            t = self.tasks.get(tid)
            if t and t.state == "queued":
                if not t.steps:
                    t.steps = [t.prompt]
                t.state = "running"
                self.active_task_id = tid
                self.log("task", f"开始任务：{t.prompt[:60]}", task=tid)
                return True
        return False

    def _pick_session_locked(self, task: Task) -> Optional[Session]:
        timeout = float(self.settings.get("session_timeout"))
        cands = [
            s
            for s in self.sessions.values()
            if s.enabled and s.state == "ready" and s.turn is None and s.alive(timeout)
        ]
        if task.provider:
            cands = [s for s in cands if s.provider == task.provider]
        if not cands:
            return None
        # Registration order, not alphabetical: the first tab the user connected
        # gets the first turn, which is what the console list implies.
        cands.sort(key=lambda s: (s.registered_at, s.id))
        if self.settings.get("rotation") and len(cands) > 1:
            idx = task.rr % len(cands)
            task.rr += 1
            return cands[idx]
        return cands[0]

    def _dispatch_locked(self) -> None:
        if not self.active_task_id:
            if not self._start_next_task_locked():
                return
        task = self.tasks.get(self.active_task_id)
        if not task or task.current_turn or not task.steps:
            return
        if task.state not in ("running", "waiting", "queued"):
            return
        s = self._pick_session_locked(task)
        if not s:
            task.state = "waiting"
            return
        prompt = task.steps.pop(0)
        task.turns += 1
        kind = "task" if task.turns == 1 else ("repair" if prompt.startswith("ERROR:") else "result")
        text = prompt
        if task.turns > 1:
            brief = self.memory.brief(
                task.id,
                entries=int(self.settings.get("memory_context_entries")),
                chars=int(self.settings.get("memory_context_chars")),
            )
            if brief:
                text = f"{brief}\n\n────────────────────────\n\n{prompt}"
        turn = Turn(
            id=uuid.uuid4().hex[:10],
            task_id=task.id,
            prompt=text,
            kind=kind,
            created=now(),
            session_id=s.id,
        )
        task.current_turn = turn
        task.state = "running"
        s.turn = turn
        s.assign_sent = False
        s.state = "assigned"

    def _finish_task_locked(self, task: Task, state: str) -> None:
        task.state = state
        task.finished_at = now()
        if self.active_task_id == task.id:
            self.active_task_id = None
        if self.settings.get("auto_start_queue"):
            if self._start_next_task_locked():
                self._dispatch_locked()

    # ══════════════════════════════════════════════════════════════════════
    #  EXECUTION
    # ══════════════════════════════════════════════════════════════════════
    def _format_result(self, raw: Any) -> str:
        if isinstance(raw, str):
            text = raw
        else:
            try:
                text = json.dumps(raw, ensure_ascii=False, indent=2)
            except Exception:
                text = str(raw)
        text = text.strip() or "(no output)"
        cap = int(self.settings.get("max_result_chars"))
        if len(text) > cap:
            text = text[:cap] + f"\n… [result truncated, {len(text) - cap} chars omitted]"
        return text

    def execute(self, command: str, params: dict[str, Any], source: str = "") -> dict[str, Any]:
        command = str(command or "").strip()
        if command == "list_tools":
            text = "Available commands:\n" + self.tools_text()
            return {"ok": True, "text": text, "preview": f"{len(self._tools)} commands", "result": {"count": len(self._tools)}}
        if command not in self._tools_by_name:
            valid = ", ".join(t["name"] for t in self._tools)
            return {"ok": False, "text": f'unknown command "{command}". Valid commands: {valid}', "preview": "unknown command"}

        timeout = float(self.settings.get("editor_timeout"))
        with self.lock:
            ed = self.editor
            if not ed.connected or ago(ed.last_seen) > float(self.settings.get("editor_seen_timeout")):
                return {
                    "ok": False,
                    "text": (
                        "the Godot editor plugin is not connected to the controller. Open the Godot project, "
                        "enable the NonZeroScript plugin, and check that it points at this controller URL."
                    ),
                    "preview": "Godot editor offline",
                }
            pending = Pending(id=uuid.uuid4().hex[:10], command=command, params=params or {}, created=now())
            ed.pending[pending.id] = pending
            ed.queue.append(pending)
            self.log("tool", f"执行 {command}", command=command, source=source, request=pending.id)

        if not pending.event.wait(timeout):
            with self.lock:
                self.editor.pending.pop(pending.id, None)
                self.editor.queue = [p for p in self.editor.queue if p.id != pending.id]
            msg = f"timed out after {timeout:.0f}s waiting for the Godot editor to answer '{command}'"
            self.log("warn", msg, command=command)
            return {"ok": False, "text": msg, "preview": "timeout"}

        if pending.ok:
            text = self._format_result(pending.result)
            self.log("tool", f"完成 {command}", command=command, ms=int((now() - pending.created) * 1000))
            return {"ok": True, "text": text, "preview": text[:280], "result": pending.result}

        err = pending.error or "command failed"
        self.log("warn", f"失败 {command}: {err}", command=command)
        return {"ok": False, "text": err, "preview": err[:280]}

    # ══════════════════════════════════════════════════════════════════════
    #  EDITOR ENDPOINTS
    # ══════════════════════════════════════════════════════════════════════
    def editor_poll(self, p: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            ed = self.editor
            was = ed.connected
            ed.id = str(p.get("editorId") or ed.id or "godot")
            ed.project = str(p.get("project") or ed.project)
            ed.project_path = str(p.get("projectPath") or ed.project_path)
            ed.engine = str(p.get("engine") or ed.engine)
            ed.open_scene = str(p.get("openScene") or "")
            ed.playing = bool(p.get("playing"))
            ed.write_enabled = bool(p.get("writeEnabled", True))
            ed.version = str(p.get("version") or ed.version)
            ed.last_seen = now()
            ed.connected = True
            if not was:
                self.log("editor", f"Godot 插件已连接：{ed.project or ed.project_path}", project=ed.project)
            cmds = [{"id": x.id, "command": x.command, "params": x.params} for x in ed.queue[:24]]
            if cmds:
                ed.queue = ed.queue[24:]
            return {
                "ok": True,
                "commands": cmds,
                "queue": len(ed.queue),
                "settings": {"max_result_chars": self.settings.get("max_result_chars")},
                "controller": {"version": __version__, "now": iso()},
            }

    def editor_result(self, p: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            ed = self.editor
            ed.last_seen = now()
            ed.connected = True
            req = ed.pending.pop(str(p.get("id") or ""), None)
            if not req:
                return {"ok": False, "error": "unknown request id"}
            req.ok = bool(p.get("ok"))
            req.result = p.get("result")
            req.error = str(p.get("error") or "")
            req.event.set()
            return {"ok": True}

    def _editor_status_locked(self) -> dict[str, Any]:
        ed = self.editor
        connected = bool(ed.connected and ago(ed.last_seen) <= float(self.settings.get("editor_seen_timeout")))
        return {
            "connected": connected,
            "id": ed.id,
            "project": ed.project,
            "project_path": ed.project_path,
            "engine": ed.engine or "Godot 4.7.2",
            "open_scene": ed.open_scene,
            "playing": ed.playing,
            "write_enabled": ed.write_enabled,
            "version": ed.version,
            "queue": len(ed.queue),
            "last_seen": iso(ed.last_seen) if ed.last_seen else None,
            "seen_ago": ago(ed.last_seen) if ed.last_seen else None,
        }

    # ══════════════════════════════════════════════════════════════════════
    #  STATUS
    # ══════════════════════════════════════════════════════════════════════
    def _session_dict_locked(self, s: Session) -> dict[str, Any]:
        return {
            "id": s.id,
            "short": s.id[:8],
            "browser": s.browser,
            "provider": s.provider,
            "display_name": s.display_name,
            "label": s.label,
            "state": s.state,
            "enabled": s.enabled,
            "alive": s.alive(float(self.settings.get("session_timeout"))) or s.turn is not None,
            "ready": s.state == "ready" and s.turn is None,
            "busy": s.turn is not None,
            "task_id": s.turn.task_id if s.turn else None,
            "last_seen": iso(s.last_seen),
            "seen_ago": ago(s.last_seen),
            "stats": dict(s.stats),
            "version": s.version,
        }

    def _task_dict_locked(self, t: Task) -> dict[str, Any]:
        return {
            "id": t.id,
            "prompt": t.prompt,
            "provider": t.provider,
            "state": t.state,
            "created": iso(t.created),
            "finished_at": iso(t.finished_at) if t.finished_at else None,
            "turns": t.turns,
            "rr": t.rr,
            "repairs": t.repairs,
            "error": t.error,
            "last_reply": t.last_reply[:600],
            "current_turn": t.current_turn.id if t.current_turn else None,
            "session_id": t.current_turn.session_id if t.current_turn else None,
        }

    def status(self) -> dict[str, Any]:
        with self.lock:
            sessions = sorted(self.sessions.values(), key=lambda s: (s.provider, s.browser, s.id))
            tasks = [self.tasks[tid] for tid in reversed(self.task_order[-40:]) if tid in self.tasks]
            stats = {
                "sessions": len(self.sessions),
                "ready": sum(1 for s in sessions if s.state == "ready"),
                "enabled": sum(1 for s in sessions if s.enabled),
                "turns": sum(s.stats["turns"] for s in sessions),
                "commands": sum(s.stats["commands"] for s in sessions),
                "errors": sum(s.stats["errors"] for s in sessions),
            }
            active = self.tasks.get(self.active_task_id) if self.active_task_id else None
            return {
                "ok": True,
                "version": __version__,
                "engine": "Godot 4.7.2",
                "uptime": int(now() - self.started),
                "host": self.host,
                "port": self.port,
                "editor": self._editor_status_locked(),
                "sessions": [self._session_dict_locked(s) for s in sessions],
                "tasks": [self._task_dict_locked(t) for t in tasks],
                "active_task": self._task_dict_locked(active) if active else None,
                "settings": self.settings.data,
                "public_settings": self.settings.public(),
                "providers": PROVIDERS,
                "stats": stats,
            }

    # ══════════════════════════════════════════════════════════════════════
    #  REAPER
    # ══════════════════════════════════════════════════════════════════════
    def _dead_turn_locked(self, s: Session, reason: str) -> None:
        turn = s.turn
        if not turn:
            return
        s.turn = None
        s.assign_sent = False
        task = self.tasks.get(turn.task_id)
        if not task or task.current_turn is not turn:
            return
        task.current_turn = None
        task.dead_retries += 1
        self.log("warn", f"回合丢失（{reason}）：{s.label}", task=task.id)
        if task.dead_retries >= 3 or task.state != "running":
            task.state = "error"
            task.error = f"浏览器会话反复中断：{reason}"
            task.finished_at = now()
            self.memory.append_task(task.id, {"kind": "note", "text": task.error, "state": "error"})
            self._finish_task_locked(task, "error")
            return
        # Give the same prompt to another session.
        task.steps.insert(0, turn.prompt)
        task.state = "running"
        if s.state != "offline":
            s.state = "ready" if s.alive(float(self.settings.get("session_timeout"))) else "offline"
        self._dispatch_locked()

    def _reaper(self) -> None:
        while not self._stop:
            time.sleep(1.5)
            try:
                with self.lock:
                    timeout = float(self.settings.get("session_timeout"))
                    lease = float(self.settings.get("session_lease"))
                    for s in list(self.sessions.values()):
                        if s.state == "offline":
                            continue
                        if s.turn:
                            # A turn in flight means the tab is typing and
                            # waiting for the AI, so it deliberately stops
                            # polling. Judge it by the (generous) turn lease,
                            # NOT by the heartbeat timeout, which only applies
                            # to idle tabs.
                            started = s.turn.assigned_at or s.turn.created or now()
                            if now() - started > lease:
                                s.state = "offline"
                                self.log("warn", f"会话超时未回传：{s.label}", session=s.id)
                                self._dead_turn_locked(s, "turn lease expired")
                            continue
                        if not s.alive(timeout):
                            s.state = "offline"
                            self.log("warn", f"会话离线：{s.label}", session=s.id)
                    for s in list(self.sessions.values()):
                        if s.turn and s.assign_sent and not s.turn.acked and s.turn.assigned_at:
                            if now() - s.turn.assigned_at > 45:
                                self._dead_turn_locked(s, "assignment never picked up")
                    ed = self.editor
                    if ed.connected and ago(ed.last_seen) > float(self.settings.get("editor_seen_timeout")):
                        ed.connected = False
                        self.log("warn", "Godot 插件已离线", last_seen=iso(ed.last_seen))
            except Exception as e:
                self.log("error", f"reaper: {e}")

    def shutdown(self) -> None:
        self._stop = True
