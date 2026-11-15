# SPDX-License-Identifier: GPL-3.0-or-later
"""Timeline memory.

Every task and every browser session gets an append-only JSONL timeline inside
`<data>/memory/`. This is what lets several browser tabs rotate: each AI has its
own private chat context, and the controller prepends a compact "memory brief"
from the shared task timeline whenever the next turn lands on another browser.

Layout:
    memory/tasks/20261115-103000-a1b2c3d4.jsonl
    memory/sessions/Chrome-deepseek-9f3a2c11.jsonl

One JSON object per line, always with `ts` (UTC ISO-8601) and `t` (epoch).
"""

from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clip(text: Any, n: int) -> str:
    s = "" if text is None else str(text)
    s = s.replace("\r", "")
    return s if len(s) <= n else s[:n] + f" …(+{len(s) - n} chars)"


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", str(name or "x"))[:64]


class Memory:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "memory"
        self.tasks_dir = self.root / "tasks"
        self.sessions_dir = self.root / "sessions"
        self.tasks_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._task_files: dict[str, Path] = {}

    # ── files ─────────────────────────────────────────────────────────────
    def task_file(self, task_id: str) -> Path:
        with self._lock:
            if task_id in self._task_files and self._task_files[task_id].exists():
                return self._task_files[task_id]
            found = sorted(self.tasks_dir.glob(f"*-{task_id}.jsonl"))
            if found:
                self._task_files[task_id] = found[-1]
                return found[-1]
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = self.tasks_dir / f"{stamp}-{_safe(task_id)}.jsonl"
            path.touch()
            self._task_files[task_id] = path
            return path

    def session_file(self, session: Any) -> Path:
        if isinstance(session, dict):
            sid = session.get("id")
            browser = session.get("browser", "Browser")
            provider = session.get("provider", "ai")
        else:
            sid = getattr(session, "id", None)
            browser = getattr(session, "browser", "Browser")
            provider = getattr(session, "provider", "ai")
        short = _safe(str(sid or "session"))[:8]
        path = self.sessions_dir / f"{_safe(str(browser))}-{_safe(str(provider))}-{short}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    # ── writes ────────────────────────────────────────────────────────────
    def append_task(self, task_id: str, entry: dict[str, Any]) -> None:
        self._append(self.task_file(task_id), {"ts": utc_now(), "t": datetime.now(timezone.utc).timestamp(), **entry})

    def append_session(self, session: dict[str, Any], entry: dict[str, Any]) -> None:
        self._append(self.session_file(session), {"ts": utc_now(), "t": datetime.now(timezone.utc).timestamp(), **entry})

    def _append(self, path: Path, entry: dict[str, Any]) -> None:
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            try:
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass

    # ── reads ─────────────────────────────────────────────────────────────
    def _read(self, path: Path, limit: int = 0) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        out: list[dict[str, Any]] = []
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            return []
        if limit > 0:
            lines = lines[-limit:]
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    out.append(obj)
            except Exception:
                continue
        return out

    def read_task(self, task_id: str, limit: int = 0) -> list[dict[str, Any]]:
        return self._read(self.task_file(task_id), limit)

    def read_session(self, session_id: str, limit: int = 0) -> list[dict[str, Any]]:
        found = sorted(self.sessions_dir.glob(f"*-{_safe(session_id[:8])}.jsonl"))
        return self._read(found[-1], limit) if found else []

    def brief(self, task_id: str, entries: int = 8, chars: int = 1800) -> str:
        """Compact timeline handed to whichever browser gets the next turn."""
        if entries <= 0 or chars <= 0:
            return ""
        evs = self.read_task(task_id)
        if not evs:
            return ""
        pieces: list[str] = []
        for e in evs[-entries:]:
            kind = e.get("kind")
            who = e.get("label") or e.get("provider") or "controller"
            ts = str(e.get("ts") or "")[11:19]
            if kind == "task":
                pieces.append(f"[TASK] {_clip(e.get('text'), 600)}")
            elif kind == "dispatch":
                kind_label = "task prompt" if e.get("turn") == 1 else "tool result"
                pieces.append(f"[{ts}] {who} got {kind_label}: {_clip(e.get('text'), 260)}")
            elif kind == "reply":
                tail = " (finished)" if e.get("done") else ""
                pieces.append(f"[{ts}] {who} replied{tail}: {_clip(e.get('text'), 330)}")
            elif kind == "tool":
                status = "OK" if e.get("ok") else "ERROR"
                arg = e.get("command") or "?"
                pieces.append(f"[{ts}] tool {arg} -> {status}: {_clip(e.get('preview') or e.get('text'), 240)}")
            elif kind == "note":
                pieces.append(f"[{ts}] {_clip(e.get('text'), 240)}")
        text = "\n".join(pieces)
        if len(text) > chars:
            text = "…\n" + text[-chars:]
        return (
            "MEMORY BRIEF (earlier turns of this task, newest last - possibly handled by another browser):\n"
            + text
            + "\nContinue from the latest state. Do not repeat finished work."
        )

    # ── listing (console) ─────────────────────────────────────────────────
    def prune(self, keep_days: int) -> int:
        """Delete timeline files older than `keep_days` (0 = keep everything)."""
        days = int(keep_days or 0)
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        removed = 0
        for folder in (self.tasks_dir, self.sessions_dir):
            for path in folder.glob("*.jsonl"):
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink()
                        removed += 1
                except OSError:
                    continue
        with self._lock:
            self._task_files = {k: v for k, v in self._task_files.items() if v.exists()}
        return removed

    def disk_usage(self) -> dict[str, Any]:
        """Counts and bytes of the timeline folder (shown in the console)."""
        files = 0
        total = 0
        for folder in (self.tasks_dir, self.sessions_dir):
            for path in folder.glob("*.jsonl"):
                files += 1
                try:
                    total += path.stat().st_size
                except OSError:
                    pass
        return {"files": files, "bytes": total, "mb": round(total / (1024 * 1024), 1)}

    def list_tasks(self, limit: int = 40) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted(self.tasks_dir.glob("*.jsonl"), reverse=True)[: max(1, int(limit))]:
            evs = self._read(path)
            if not evs:
                continue
            first = next((e for e in evs if e.get("kind") == "task"), evs[0])
            last = evs[-1]
            out.append(
                {
                    "task_id": path.stem.split("-", 2)[-1],
                    "file": path.name,
                    "created": first.get("ts"),
                    "prompt": _clip(first.get("text"), 240),
                    "entries": len(evs),
                    "state": last.get("state") or ("done" if last.get("done") else "in progress"),
                }
            )
        return out

    def list_sessions(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted(self.sessions_dir.glob("*.jsonl"), reverse=True):
            evs = self._read(path)
            if not evs:
                continue
            out.append(
                {
                    "file": path.name,
                    "entries": len(evs),
                    "last": evs[-1].get("ts"),
                    "label": evs[-1].get("label") or path.stem,
                    "preview": _clip(evs[-1].get("text"), 160),
                }
            )
        return out[:80]

    def find_task_by_file(self, filename: str) -> list[dict[str, Any]]:
        path = self.tasks_dir / _safe(filename)
        if path.suffix != ".jsonl" or not path.exists():
            return []
        return self._read(path)

    def find_session_by_file(self, filename: str) -> list[dict[str, Any]]:
        path = self.sessions_dir / _safe(filename)
        if path.suffix != ".jsonl" or not path.exists():
            return []
        return self._read(path)


def summarize(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    evs = list(events)
    return {
        "turns": sum(1 for e in evs if e.get("kind") == "reply"),
        "tools": sum(1 for e in evs if e.get("kind") == "tool"),
        "errors": sum(1 for e in evs if e.get("kind") == "tool" and not e.get("ok")),
        "started": evs[0].get("ts") if evs else None,
        "updated": evs[-1].get("ts") if evs else None,
    }
