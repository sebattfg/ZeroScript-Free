# SPDX-License-Identifier: GPL-3.0-or-later
"""Settings for the NonZeroScript controller.

Everything lives in one JSON file inside the data directory so the visual
console, the relay and a future installer all read the same values. No command
line flags are required to change any of this.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    # ── Input pacing (the feature that makes automation feel human) ───────
    # Seconds to wait, chosen uniformly at random in [min_delay, max_delay],
    # before EVERY simulated input (startup prompt, task, tool result).
    "min_delay": 2.0,
    "max_delay": 6.0,
    # ── Rotation / task limits ────────────────────────────────────────────
    "rotation": True,          # round-robin across ready browser sessions
    "max_turns": 60,           # hard cap per task
    "auto_start_queue": True,  # start the next queued task automatically
    # ── Memory ────────────────────────────────────────────────────────────
    "memory_context_entries": 8,   # timeline entries prepended for rotation
    "memory_context_chars": 1800,  # character budget of the memory brief
    # ── Relay ─────────────────────────────────────────────────────────────
    "max_result_chars": 12000,  # tool result cap sent back to the AI
    "editor_timeout": 30.0,     # seconds to wait for a tool result
    "session_timeout": 12.0,    # an IDLE browser tab is offline after this silence
    "session_lease": 300.0,     # a busy tab may hold a turn this long (AI thinking)
    "editor_seen_timeout": 8.0, # editor considered disconnected after this
    # ── Prompting ─────────────────────────────────────────────────────────
    "custom_prompt": "",       # appended to the system prompt
    # ── Host ──────────────────────────────────────────────────────────────
    "host": "127.0.0.1",
    "port": 8790,
    "auto_open_console": True,
}

PROVIDERS = [
    {"id": "chatgpt", "name": "ChatGPT", "url": "https://chatgpt.com/"},
    {"id": "deepseek", "name": "DeepSeek", "url": "https://chat.deepseek.com/"},
    {"id": "gemini", "name": "Gemini", "url": "https://gemini.google.com/"},
    {"id": "kimi", "name": "Kimi", "url": "https://www.kimi.ai/"},
    {"id": "glm", "name": "GLM", "url": "https://chat.z.ai/"},
    {"id": "qwen", "name": "Qwen", "url": "https://chat.qwen.ai/"},
    {"id": "meta", "name": "Meta AI", "url": "https://www.meta.ai/"},
    {"id": "arena", "name": "Arena", "url": "https://arena.ai/"},
]


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a safe, complete settings dict."""
    out = dict(DEFAULTS)
    if isinstance(raw, dict):
        out.update({k: v for k, v in raw.items() if k in DEFAULTS})
    out["min_delay"] = _num(out.get("min_delay"), DEFAULTS["min_delay"], 0.0, 120.0)
    out["max_delay"] = _num(out.get("max_delay"), DEFAULTS["max_delay"], 0.0, 300.0)
    if out["max_delay"] < out["min_delay"]:
        out["max_delay"] = out["min_delay"]
    out["max_turns"] = int(_num(out.get("max_turns"), 60, 1, 500))
    out["memory_context_entries"] = int(_num(out.get("memory_context_entries"), 8, 0, 100))
    out["memory_context_chars"] = int(_num(out.get("memory_context_chars"), 1800, 0, 20000))
    out["max_result_chars"] = int(_num(out.get("max_result_chars"), 12000, 1000, 200000))
    out["editor_timeout"] = _num(out.get("editor_timeout"), 30.0, 3.0, 300.0)
    out["session_timeout"] = _num(out.get("session_timeout"), 12.0, 3.0, 120.0)
    out["session_lease"] = _num(out.get("session_lease"), 300.0, 30.0, 1800.0)
    out["editor_seen_timeout"] = _num(out.get("editor_seen_timeout"), 8.0, 2.0, 120.0)
    out["port"] = int(_num(out.get("port"), 8790, 1, 65535))
    out["rotation"] = bool(out.get("rotation"))
    out["auto_start_queue"] = bool(out.get("auto_start_queue"))
    out["auto_open_console"] = bool(out.get("auto_open_console"))
    out["custom_prompt"] = str(out.get("custom_prompt") or "")
    host = str(out.get("host") or "127.0.0.1")
    out["host"] = "0.0.0.0" if host == "0.0.0.0" else "127.0.0.1"
    return out


class Settings:
    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "settings.json"
        self._lock = threading.RLock()
        self._data = dict(DEFAULTS)
        self.load()

    def load(self) -> dict[str, Any]:
        with self._lock:
            if self.path.exists():
                try:
                    raw = json.loads(self.path.read_text(encoding="utf-8"))
                    self._data = normalize(raw)
                except Exception:
                    self._data = dict(DEFAULTS)
            else:
                self._data = dict(DEFAULTS)
                self.save()
            return dict(self._data)

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, DEFAULTS.get(key, default))

    @property
    def data(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            merged = dict(self._data)
            merged.update({k: v for k, v in (patch or {}).items() if k in DEFAULTS})
            self._data = normalize(merged)
            self.save()
            return dict(self._data)

    def public(self) -> dict[str, Any]:
        """Settings the browser extension needs (no secrets, no host config)."""
        d = self.data
        return {
            "min_delay": d["min_delay"],
            "max_delay": d["max_delay"],
            "max_turns": d["max_turns"],
            "rotation": d["rotation"],
            "memory_context_entries": d["memory_context_entries"],
            "memory_context_chars": d["memory_context_chars"],
            "custom_prompt": d["custom_prompt"],
        }
