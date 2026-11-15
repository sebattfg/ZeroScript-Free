# SPDX-License-Identifier: GPL-3.0-or-later
"""HTTP relay + console server.

One port, no dependencies:

    /                       visual console (ui/)
    /api/status             console + popup status
    /api/tools              command catalogue (system prompt source of truth)
    /api/sessions/*         browser session register/poll/report/stop/close
    /api/editor/*           Godot plugin poll/result
    /api/task/*             queue tasks, stop everything
    /api/execute            manual command (console test)
    /api/settings           read/update
    /api/memory             timeline listing / detail
    /api/logs               incremental console log

Browser tabs and the Godot plugin both POLL over plain HTTP. Polling keeps the
controller tiny (standard library only), survives service-worker sleep, and
works from an https page without WebSocket mixed-content rules.
"""

from __future__ import annotations

import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

try:
    from .hub import Hub
    from .version import __version__
except ImportError:
    from hub import Hub
    from version import __version__

JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}


class NonZeroServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    hub: Hub
    ui_dir: Path

    def __init__(self, addr: tuple[str, int], hub: Hub, ui_dir: Path):
        self.hub = hub
        self.ui_dir = Path(ui_dir)
        super().__init__(addr, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = f"NonZeroScript/{__version__}"
    protocol_version = "HTTP/1.1"

    # ── plumbing ──────────────────────────────────────────────────────────
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass  # the console has its own log

    def _host_ok(self) -> bool:
        """Block DNS-rebinding when bound to loopback.

        A page on evil.example that resolves to 127.0.0.1 sends
        `Host: evil.example`; with a permissive Host check it could reach the
        controller. On loopback we only accept local Host names. In remote mode
        (--host 0.0.0.0, e.g. a preview proxy) the Host header is whatever the
        proxy forwards, so it cannot be restricted here.
        """
        if str(getattr(self.hub, "host", "127.0.0.1")) == "0.0.0.0":
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return True
        if host.startswith("["):
            name = host.split("]")[0] + "]"
        else:
            name = host.rsplit(":", 1)[0]
        return name in ("127.0.0.1", "localhost", "[::1]")

    def _origin_ok(self) -> bool:
        """Reject cross-site API calls.

        The controller can write files, so a random website must not be able to
        POST to it. The extension talks to us from its background worker (an
        extension origin) and the Godot plugin sends no Origin at all; a normal
        web page may only call us when it is served from the same host, which
        includes reverse-proxied preview URLs.
        """
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return True
        try:
            parsed = urlparse(origin)
        except ValueError:
            return False
        if parsed.scheme in ("chrome-extension", "moz-extension", "safari-web-extension"):
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        return bool(host) and parsed.netloc.lower() == host

    def _send(self, code: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj: Any, code: int = 200) -> None:
        try:
            body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        except Exception as e:
            body = json.dumps({"ok": False, "error": f"serialization error: {e}"}).encode("utf-8")
            code = 500
        self._send(code, body, "application/json; charset=utf-8")

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > 8 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _query(self) -> dict[str, str]:
        q = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        return {k: (v[0] if v else "") for k, v in q.items()}

    @property
    def hub(self) -> Hub:
        return self.server.hub  # type: ignore[attr-defined]

    # ── verbs ─────────────────────────────────────────────────────────────
    def do_OPTIONS(self) -> None:  # noqa: N802
        # No CORS headers on purpose: cross-site JSON posts must fail their
        # preflight. The extension has host permissions, so it is not affected.
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def _route(self, method: str) -> None:
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path in ("/app.js", "/style.css", "/icon.png", "/favicon.ico"):
            return self._static("favicon.ico" if path == "/favicon.ico" else path.lstrip("/"))

        if not path.startswith("/api/"):
            return self._json({"ok": False, "error": "not found", "path": path}, 404)

        try:
            return self._api(path, method)
        except Exception as e:
            self.hub.log("error", f"{path}: {e}")
            return self._json({"ok": False, "error": str(e)}, 500)

    def _static(self, name: str) -> None:
        ui: Path = self.server.ui_dir  # type: ignore[attr-defined]
        target = (ui / name).resolve()
        try:
            target.relative_to(ui.resolve())
        except ValueError:
            return self._json({"ok": False, "error": "forbidden"}, 403)
        if not target.exists() or not target.is_file():
            return self._json({"ok": False, "error": "not found"}, 404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".png":
            ctype = "image/png"
        self._send(200, target.read_bytes(), ctype)

    # ── API ───────────────────────────────────────────────────────────────
    def _api(self, path: str, method: str) -> None:
        if not self._host_ok():
            self.hub.log("warn", f"拒绝异常 Host：{self.headers.get('Host')}")
            return self._json({"ok": False, "error": "forbidden host"}, 403)
        if not self._origin_ok():
            self.hub.log("warn", f"拒绝跨站请求：{path}")
            return self._json({"ok": False, "error": "forbidden origin"}, 403)
        hub = self.hub
        q = self._query()
        p = self._body() if method == "POST" else {}

        if path == "/api/status":
            return self._json(hub.status())

        if path == "/api/tools":
            return self._json({"ok": True, "version": __version__, "engine": "Godot 4.7.2", "tools": hub.tools()})

        if path == "/api/logs":
            try:
                since = int(q.get("since", "0"))
            except ValueError:
                since = 0
            return self._json(hub.logs_since(since))

        if path == "/api/settings":
            if method == "POST":
                data = hub.settings.update(p)
                hub.host = str(data.get("host"))
                hub.port = int(data.get("port"))
                hub.apply_runtime_settings()
                hub.log("settings", "设置已更新")
                keep_days = int(data.get("memory_keep_days") or 0)
                if keep_days > 0:
                    removed = hub.memory.prune(keep_days)
                    if removed:
                        hub.log("memory", f"清理了 {removed} 个超过 {keep_days} 天的时间线文件")
                return self._json({"ok": True, "settings": data})
            return self._json({"ok": True, "settings": hub.settings.data})

        # ── sessions ──────────────────────────────────────────────────────
        if path == "/api/session/register":
            return self._json(hub.register_session(p))
        if path == "/api/session/poll":
            return self._json(hub.session_poll(p))
        if path == "/api/session/report":
            return self._json(hub.session_report(p))
        if path == "/api/session/stop":
            return self._json(hub.session_stop(str(p.get("sessionId") or ""), str(p.get("reason") or "user")))
        if path == "/api/session/close":
            sid = str(p.get("session") or q.get("session") or "")
            return self._json(hub.close_session(sid))
        if path == "/api/session/enable":
            return self._json(hub.enable_session(str(p.get("sessionId") or ""), bool(p.get("enabled", True))))

        # ── editor plugin ─────────────────────────────────────────────────
        if path == "/api/editor/poll":
            return self._json(hub.editor_poll(p))
        if path == "/api/editor/result":
            return self._json(hub.editor_result(p))

        # ── tasks ─────────────────────────────────────────────────────────
        if path == "/api/task/add":
            return self._json(hub.add_task(str(p.get("prompt") or ""), str(p.get("provider") or "")))
        if path == "/api/task/stop":
            if p.get("taskId"):
                return self._json(hub.pause_task(str(p["taskId"])))
            return self._json(hub.stop_all())
        if path == "/api/task/pause":
            return self._json(hub.pause_task(str(p.get("taskId") or "")))

        # ── manual execution ──────────────────────────────────────────────
        if path == "/api/execute":
            command = str(p.get("command") or "")
            params = p.get("params") if isinstance(p.get("params"), dict) else {}
            res = hub.execute(command, params, source="console")
            return self._json(res)

        # ── memory ────────────────────────────────────────────────────────
        if path == "/api/memory":
            mem = hub.memory
            if q.get("file"):
                name = q["file"]
                if q.get("kind") == "session":
                    return self._json({"ok": True, "events": mem.find_session_by_file(name)})
                return self._json({"ok": True, "events": mem.find_task_by_file(name)})
            if q.get("task"):
                try:
                    limit = int(q.get("limit", "500"))
                except ValueError:
                    limit = 500
                return self._json({"ok": True, "events": mem.read_task(q["task"], limit)})
            if q.get("session"):
                return self._json({"ok": True, "events": mem.read_session(q["session"], 500)})
            return self._json(
                {
                    "ok": True,
                    "root": str(mem.root),
                    "disk": mem.disk_usage(),
                    "tasks": mem.list_tasks(),
                    "sessions": mem.list_sessions(),
                }
            )

        return self._json({"ok": False, "error": f"unknown endpoint {path}", "version": __version__}, 404)


def create_server(hub: Hub, ui_dir: Path, host: str, port: int) -> NonZeroServer:
    server = NonZeroServer((host, port), hub, ui_dir)
    return server
