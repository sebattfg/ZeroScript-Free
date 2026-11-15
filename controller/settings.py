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

# ── Performance modes ─────────────────────────────────────────────────────
# The console offers three profiles. A profile OWNS the keys in
# PROFILE_KEYS: switching mode applies them in one shot (and the settings file
# shows the resulting numbers, so they can still be fine-tuned afterwards).
PERF_MODES: tuple[str, ...] = ("eco", "balanced", "turbo")

PERF_PROFILES: dict[str, dict[str, Any]] = {
    "eco": {
        "label": "极致性能",
        "summary": "内存 / CPU / 磁盘占用最小（目标 < 30 MB），界面刷新较慢",
        "log_limit": 120,
        "keep_tasks": 12,
        "memory_context_entries": 3,
        "memory_context_chars": 700,
        "max_result_chars": 6000,
        "ui_refresh_ms": 2000,
        "session_poll_ms": 1500,
        "editor_poll_ms": 1000,
    },
    "balanced": {
        "label": "平均",
        "summary": "默认设置，速度和占用平衡",
        "log_limit": 800,
        "keep_tasks": 40,
        "memory_context_entries": 8,
        "memory_context_chars": 1800,
        "max_result_chars": 12000,
        "ui_refresh_ms": 900,
        "session_poll_ms": 1200,
        "editor_poll_ms": 400,
    },
    "turbo": {
        "label": "最快速度",
        "summary": "轮询最勤、结果最长、日志最多，把速度拉满",
        "log_limit": 2000,
        "keep_tasks": 120,
        "memory_context_entries": 12,
        "memory_context_chars": 2600,
        "max_result_chars": 20000,
        "ui_refresh_ms": 400,
        "session_poll_ms": 500,
        "editor_poll_ms": 250,
    },
}

# Keys owned by a profile (see PERF_PROFILES).
PROFILE_KEYS: tuple[str, ...] = (
    "log_limit",
    "keep_tasks",
    "memory_context_entries",
    "memory_context_chars",
    "max_result_chars",
    "ui_refresh_ms",
    "session_poll_ms",
    "editor_poll_ms",
)


def perf_profile(mode: str) -> dict[str, Any]:
    return PERF_PROFILES.get(str(mode), PERF_PROFILES["balanced"])


def apply_perf_profile(data: dict[str, Any], mode: str) -> dict[str, Any]:
    """Return a copy of `data` with the profile's managed keys applied."""
    merged = dict(data)
    profile = perf_profile(mode)
    merged["perf_mode"] = mode if mode in PERF_MODES else "balanced"
    for key in PROFILE_KEYS:
        merged[key] = profile[key]
    return merged


DEFAULTS: dict[str, Any] = {
    # ── Input pacing (the feature that makes automation feel human) ───────
    # Seconds to wait, chosen uniformly at random in [min_delay, max_delay],
    # before EVERY simulated input (startup prompt, task, tool result).
    "min_delay": 2.0,
    "max_delay": 6.0,
    # ── Performance mode ──────────────────────────────────────────────────
    # "eco" | "balanced" | "turbo" - see PERF_PROFILES. Managed keys below
    # follow the profile; changing one by hand afterwards is allowed.
    "perf_mode": "balanced",
    "log_limit": 800,
    "keep_tasks": 40,
    "ui_refresh_ms": 900,
    "session_poll_ms": 1200,
    "editor_poll_ms": 400,
    # ── Rotation / task limits ────────────────────────────────────────────
    "rotation": True,          # round-robin across ready browser sessions
    "max_turns": 60,           # hard cap per task
    "auto_start_queue": True,  # start the next queued task automatically
    # ── Memory ────────────────────────────────────────────────────────────
    "memory_context_entries": 8,   # timeline entries prepended for rotation
    "memory_context_chars": 1800,  # character budget of the memory brief
    "memory_keep_days": 0,         # delete timeline files older than N days (0 = keep)
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
    out["perf_mode"] = str(out.get("perf_mode") or "balanced").lower()
    if out["perf_mode"] not in PERF_MODES:
        out["perf_mode"] = "balanced"
    out["log_limit"] = int(_num(out.get("log_limit"), 800, 20, 5000))
    out["keep_tasks"] = int(_num(out.get("keep_tasks"), 40, 1, 500))
    out["ui_refresh_ms"] = int(_num(out.get("ui_refresh_ms"), 900, 250, 10000))
    out["session_poll_ms"] = int(_num(out.get("session_poll_ms"), 1200, 200, 15000))
    out["editor_poll_ms"] = int(_num(out.get("editor_poll_ms"), 400, 150, 10000))
    out["memory_keep_days"] = int(_num(out.get("memory_keep_days"), 0, 0, 3650))
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
            if "perf_mode" in (patch or {}):
                merged = apply_perf_profile(merged, str(merged.get("perf_mode")))
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
            "perf_mode": d["perf_mode"],
            "poll_ms": d["session_poll_ms"],
        }
