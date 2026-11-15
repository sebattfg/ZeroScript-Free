#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""End-to-end smoke test for the controller.

Starts a real controller on a free port with a temporary data folder, then
plays three roles against it:

  * a fake Godot editor that answers commands,
  * two fake browser sessions,

and checks that a task rotates from the first session to the second, that the
command really reached the editor, and that the second turn carries a memory
brief.

    python3 tools/smoke_test.py
    python3 tools/smoke_test.py --keep-logs

No third-party packages; runs on Windows and macOS (the supported hosts).
"""

from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTROLLER = ROOT / "controller" / "main.py"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def call(self, path: str, body: dict | None = None, timeout: float = 40.0) -> dict:
        data = json.dumps(body or {}).encode("utf-8")
        req = urllib.request.Request(
            self.base + path, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))


class FakeEditor(threading.Thread):
    def __init__(self, api: Api) -> None:
        super().__init__(daemon=True, name="fake-editor")
        self.api = api
        self.stop = threading.Event()
        self.commands: list[str] = []
        self.error: str | None = None

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                r = self.api.call(
                    "/api/editor/poll",
                    {
                        "editorId": "fake-godot",
                        "version": "0.1.0",
                        "project": "SmokeTest",
                        "projectPath": "res://",
                        "engine": "4.7.2",
                        "openScene": "res://main.tscn",
                        "playing": False,
                        "writeEnabled": True,
                        "csharp": True,
                        "dotnet": True,
                    },
                    timeout=10,
                )
                for cmd in r.get("commands") or []:
                    self.commands.append(cmd.get("command", ""))
                    result = {"ok": True, "result": {"smoke": True, "command": cmd.get("command")}}
                    if cmd.get("command") == "get_editor_state":
                        result["result"] = {
                            "project_name": "SmokeTest",
                            "engine": "4.7.2",
                            "open_scene": "res://main.tscn",
                            "scene_tree": [{"name": "Main", "type": "Node2D", "children": []}],
                        }
                    self.api.call(
                        "/api/editor/result",
                        {"id": cmd.get("id"), "ok": True, "result": result["result"]},
                        timeout=10,
                    )
            except Exception as exc:  # noqa: BLE001 - reported at the end
                if not self.stop.is_set():
                    self.error = f"{type(exc).__name__}: {exc}"
                    time.sleep(0.3)
            time.sleep(0.12)


class FakeSession(threading.Thread):
    def __init__(self, api: Api, sid: str, browser: str, provider: str, behaviour: str) -> None:
        super().__init__(daemon=True, name=f"fake-{sid}")
        self.api = api
        self.sid = sid
        self.browser = browser
        self.provider = provider
        self.behaviour = behaviour  # "command" or "finish"
        self.stop = threading.Event()
        self.assignments: list[dict] = []
        self.reports: list[dict] = []
        self.error: str | None = None
        self.registered = False

    def _register(self) -> None:
        self.api.call(
            "/api/session/register",
            {
                "sessionId": self.sid,
                "browser": self.browser,
                "browserId": self.browser.lower(),
                "provider": self.provider,
                "displayName": self.provider,
                "label": f"{self.browser} · {self.provider}",
                "pageUrl": f"https://example.invalid/{self.provider}",
                "version": "0.1.0",
                "state": "ready",
            },
        )
        self.registered = True

    def run(self) -> None:
        try:
            if not self.registered:
                self._register()
            while not self.stop.is_set():
                r = self.api.call(
                    "/api/session/poll",
                    {
                        "sessionId": self.sid,
                        "state": "ready",
                        "provider": self.provider,
                        "displayName": self.provider,
                    },
                    timeout=10,
                )
                assign = r.get("assign")
                if assign:
                    self.assignments.append(assign)
                    time.sleep(0.15)
                    if self.behaviour == "command":
                        body = {
                            "sessionId": self.sid,
                            "turnId": assign["turnId"],
                            "reply": "Let me inspect the project first.",
                            "command": {"command": "get_editor_state", "params": {}},
                        }
                    else:
                        body = {
                            "sessionId": self.sid,
                            "turnId": assign["turnId"],
                            "reply": "The project is ready. Nothing else to do.",
                            "done": True,
                        }
                    rep = self.api.call("/api/session/report", body, timeout=40)
                    self.reports.append(rep)
                time.sleep(0.15)
        except Exception as exc:  # noqa: BLE001
            if not self.stop.is_set():
                self.error = f"{type(exc).__name__}: {exc}"


def wait_status(api: Api, deadline: float) -> dict:
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return api.call("/api/status", {}, timeout=3)
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(0.2)
    raise RuntimeError(f"controller did not answer /api/status: {last}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="NonZeroScript controller end-to-end smoke test")
    ap.add_argument("--keep-logs", action="store_true", help="print the controller log at the end")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args(argv)

    port = args.port or free_port()
    tmp = Path(tempfile.mkdtemp(prefix="nzs-smoke-"))
    data = tmp / "data"
    log_path = tmp / "controller.log"
    log = log_path.open("w", encoding="utf-8")
    base = f"http://127.0.0.1:{port}"
    api = Api(base)
    proc: subprocess.Popen | None = None
    failures: list[str] = []

    print(f"NonZeroScript smoke test\n  controller : {base}\n  data       : {data}\n")

    try:
        proc = subprocess.Popen(
            [
                sys.executable,
                str(CONTROLLER),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-open",
                "--data",
                str(data),
            ],
            cwd=ROOT / "controller",
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        status = wait_status(api, time.monotonic() + 15)
        print(f"  [ok] controller v{status.get('version')} listening (pid {proc.pid})")

        editor = FakeEditor(api)
        editor.start()
        deadline = time.monotonic() + 8
        connected = False
        while time.monotonic() < deadline:
            st = api.call("/api/status", {}, timeout=3)
            if st.get("editor", {}).get("connected"):
                connected = True
                break
            time.sleep(0.2)
        if connected:
            print("  [ok] editor connected")
            if st.get("editor", {}).get("csharp") is True:
                print("  [ok] editor reports C# support (csharp/dotnet pass through)")
            else:
                failures.append(f"editor csharp not exposed: {st.get('editor')}")
        else:
            failures.append("fake editor never showed up as connected")

        tools = (api.call("/api/tools", {}, timeout=5).get("tools") or [])
        names = {t.get("name") for t in tools}
        if {"attach_script", "write_file", "get_editor_state"} <= names:
            print(f"  [ok] catalogue has {len(names)} tools incl. attach_script")
        else:
            failures.append(f"attach_script missing from the catalogue: {sorted(names)}")

        # Performance profile: the status must expose a label and a measured RSS,
        # and switching to eco must apply the profile's managed values.
        perf = st.get("perf") or {}
        if perf.get("mode") == "balanced" and perf.get("label") and "rss_mb" in perf:
            print(f"  [ok] perf profile reported ({perf.get('label')}, rss {perf.get('rss_mb')} MB)")
        else:
            failures.append(f"perf block missing/incomplete: {perf}")
        api.call("/api/settings", {"perf_mode": "eco"}, timeout=5)
        st2 = api.call("/api/status", {}, timeout=3)
        eco = st2.get("settings") or {}
        if eco.get("perf_mode") == "eco" and int(eco.get("log_limit", 0)) <= 200 and int(eco.get("max_result_chars", 0)) <= 6000:
            print("  [ok] eco profile applied (log ring + result cap reduced)")
        else:
            failures.append(f"eco profile not applied: {eco.get('perf_mode')} {eco.get('log_limit')} {eco.get('max_result_chars')}")
        api.call("/api/settings", {"perf_mode": "balanced"}, timeout=5)

        # Rotation block: no session is ticked yet at this point, so it must be idle.
        rot = st.get("rotation") or {}
        if {"switch", "eligible", "active", "mode"} <= set(rot):
            print(f"  [ok] rotation block present (mode={rot.get('mode')})")
        else:
            failures.append(f"rotation block missing: {rot}")

        a = FakeSession(api, "smoke-a", "Chrome", "deepseek", "command")
        b = FakeSession(api, "smoke-b", "Edge", "chatgpt", "finish")
        # Register sequentially so "first connected" is deterministic; the poll
        # threads then start and are treated equally by the rotation.
        a._register()
        b._register()
        a.start()
        b.start()
        time.sleep(0.6)

        st = api.call("/api/status", {}, timeout=3)
        if len(st.get("sessions") or []) != 2:
            failures.append(f"expected 2 sessions, got {len(st.get('sessions') or [])}")
        else:
            print("  [ok] two sessions registered")
        rot = st.get("rotation") or {}
        if rot.get("active") and rot.get("eligible") == 2:
            print("  [ok] two ticked sessions switch rotation on")
        else:
            failures.append(f"rotation not active with two ready sessions: {rot}")

        created = api.call("/api/task/add", {"prompt": "Smoke test: inspect the project."}, timeout=10)
        task_id = (created.get("task") or {}).get("id")
        if not task_id:
            failures.append("could not queue a task")
        else:
            print(f"  [ok] task queued ({task_id[:8]})")

        deadline = time.monotonic() + 25
        final: dict = {}
        while time.monotonic() < deadline:
            st = api.call("/api/status", {}, timeout=3)
            final = next((t for t in st.get("tasks") or [] if t.get("id") == task_id), {})
            if final.get("state") in ("done", "error", "paused", "stopped"):
                break
            time.sleep(0.25)

        if final.get("state") != "done":
            failures.append(f"task ended as {final.get('state')!r}, expected 'done'")
        else:
            print(f"  [ok] task done in {final.get('turns')} turns")

        if len(a.assignments) >= 1 and a.assignments[0].get("kind") == "task":
            print("  [ok] turn 1 dispatched to the first session")
        else:
            failures.append(f"first assignment unexpected: {a.assignments[:1]}")

        if not a.reports or not a.reports[0].get("executed"):
            failures.append("command was not executed by the controller/editor")
        else:
            print("  [ok] command executed through the editor")
        if "get_editor_state" not in editor.commands:
            failures.append(f"editor did not receive get_editor_state (got {editor.commands})")

        second = b.assignments[0] if b.assignments else None
        if not second:
            failures.append("rotation did not reach the second session")
        else:
            text = str(second.get("text") or "")
            if "MEMORY BRIEF" in text:
                print("  [ok] rotated turn carried a memory brief")
            else:
                failures.append("rotated turn has no MEMORY BRIEF preamble:\n" + text[:600])

        st = api.call("/api/status", {}, timeout=3)
        if (st.get("editor") or {}).get("queue"):
            failures.append(f"editor queue not drained: {st['editor']['queue']}")

        for who, obj in (("editor", editor), ("session-a", a), ("session-b", b)):
            if obj.error:
                failures.append(f"{who} error: {obj.error}")

        # Stop everything and make sure the API stays honest.
        stop = api.call("/api/task/stop", {}, timeout=10)
        if not stop.get("ok"):
            failures.append(f"/api/task/stop failed: {stop}")
        for obj in (editor, a, b):
            obj.stop.set()
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{type(exc).__name__}: {exc}")
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        log.flush()
        log.close()

    if failures:
        print("\nFAILED")
        for failure in failures:
            print("  - " + failure)
        print(f"\ncontroller log: {log_path}")
        print(log_path.read_text(encoding="utf-8", errors="replace")[-4000:])
        return 1

    print("\nPASS — rotation, memory brief, editor execution and shutdown all worked.")
    if args.keep_logs:
        print(f"\ncontroller log: {log_path}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
