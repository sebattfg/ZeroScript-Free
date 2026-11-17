#!/usr/bin/env python3
"""Build the NonZeroScript download packages.

Run by .github/workflows/check.yml, and runnable by hand:

    python .github/build.py            # build dist/*.zip + SHA256SUMS.txt
    python .github/build.py --check    # verify versions and prompt docs only
    python .github/build.py --out out  # write somewhere else

Standard library only; no pip install, no other build tool.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Files that must all carry the same version as version.txt.
# extension/manifest.json is checked separately: Chrome only accepts numbers in
# "version", so the real string (e.g. v0.1.0-dev) lives in "version_name".
VERSION_SOURCES = [
    ("controller/version.py", r'__version__\s*=\s*"([^"]+)"'),
    ("controller/tools.json", r'"version"\s*:\s*"([^"]+)"'),
    ("editor/godot-4.7.2/plugin.cfg", r'^version\s*=\s*"([^"]+)"'),
    ("editor/godot-4.7.2/core/commands.gd", r'const VERSION\s*:=\s*"([^"]+)"'),
    ("editor/godot-4.7.2/core/bridge.gd", r'const PLUGIN_VERSION\s*:=\s*"([^"]+)"'),
]


def manifest_numeric(version: str) -> str:
    """Chrome's plain-number form of the version: v0.1.0-dev -> 0.1.0."""
    v = version[1:] if version.startswith("v") else version
    return v.split("-", 1)[0]

SKIP_DIRS = {".git", ".github", "dist", "data", "__pycache__", "node_modules", ".godot", ".import"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".tmp", ".zip", ".log", ".uid"}


def read_version() -> str:
    text = (ROOT / "version.txt").read_text(encoding="utf-8").strip()
    return text or "0.0.0"


# --------------------------------------------------------------------------- checks


def check_versions() -> list[str]:
    expected = read_version()
    problems: list[str] = []
    if expected == "0.0.0":
        problems.append("version.txt is missing or empty")
    for rel, pattern in VERSION_SOURCES:
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            problems.append(f"{rel}: file is missing")
            continue
        match = re.search(pattern, text, re.MULTILINE)
        if not match:
            problems.append(f"{rel}: no version string found")
        elif match.group(1) != expected:
            problems.append(f"{rel}: {match.group(1)} != {expected}")
    try:
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"extension/manifest.json: {exc}")
    else:
        if manifest.get("version_name") != expected:
            problems.append(f"extension/manifest.json: version_name {manifest.get('version_name')!r} != {expected}")
        if manifest.get("version") != manifest_numeric(expected):
            problems.append(f"extension/manifest.json: version {manifest.get('version')!r} != {manifest_numeric(expected)}")
    return problems


def catalogue_rows(path: Path) -> dict[str, list[str]]:
    """Read the summary tables of prompts/tool-catalogue.md.

    Summary rows look like ``| `read_file` | `path`, `start_line?` |`` (two
    columns). The per-parameter tables further down have four columns and are
    skipped.
    """
    rows: dict[str, list[str]] = {}
    row_re = re.compile(r"^\|\s*`([a-z_]+)`\s*\|\s*([^|]*)\|\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = row_re.match(line.strip())
        if not match:
            continue
        params = match.group(2).strip()
        rows[match.group(1)] = [] if params in {"—", "-", ""} else re.findall(r"`([a-z_]+)\??`", params)
    return rows


def check_prompts() -> list[str]:
    """prompts/tool-catalogue.md must describe exactly what tools.json exposes."""
    tools_path = ROOT / "controller" / "tools.json"
    cat_path = ROOT / "prompts" / "tool-catalogue.md"
    try:
        tools = json.loads(tools_path.read_text(encoding="utf-8")).get("tools") or []
    except (OSError, ValueError) as exc:
        return [f"controller/tools.json: {exc}"]
    if not cat_path.exists():
        return ["prompts/tool-catalogue.md is missing"]

    expected = {t.get("name"): list(t.get("params") or {}) for t in tools}
    actual = catalogue_rows(cat_path)
    text = cat_path.read_text(encoding="utf-8")
    problems: list[str] = []

    for name in expected:
        if name not in actual:
            problems.append(f"tool-catalogue.md: `{name}` is missing from the summary tables")
        elif actual[name] != expected[name]:
            problems.append(f"tool-catalogue.md: `{name}` params {actual[name]} != {expected[name]}")
        if f"### `{name}`" not in text:
            problems.append(f"tool-catalogue.md: no description section for `{name}`")
    for name in actual:
        if name not in expected:
            problems.append(f"tool-catalogue.md: `{name}` is not in controller/tools.json")
    return problems


# ---------------------------------------------------------------------------- build


def iter_files(base: Path, skip_top: tuple[str, ...] = ()):
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if rel.parts and rel.parts[0] in skip_top:
            continue
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if path.suffix in SKIP_SUFFIXES or path.name.startswith("."):
            continue
        yield rel


def add_tree(zf: zipfile.ZipFile, base: Path, prefix: str, skip_top: tuple[str, ...] = ()) -> int:
    count = 0
    for rel in iter_files(base, skip_top):
        zf.write(base / rel, "/".join(p for p in (prefix, rel.as_posix()) if p))
        count += 1
    return count


def add_text(zf: zipfile.ZipFile, name: str, text: str) -> None:
    zf.writestr(name, text.replace("\r\n", "\n"), compress_type=zipfile.ZIP_DEFLATED)


def install_text(kind: str, version: str, extra: str = "") -> str:
    head = f"NonZeroScript {version}\n{'=' * (16 + len(version))}\n\n"
    if kind == "controller":
        body = (
            "Controller (visual console + local relay)\n\n"
            "1. Install Python 3.9 or newer: https://www.python.org/downloads/\n"
            "2. Double-click one of:\n"
            "     Windows 10/11   controller/start.bat\n"
            "     macOS           controller/start.command  (right-click > Open the first time)\n"
            "   Windows and macOS are supported in 64-bit and 32-bit; Linux is not supported.\n"
            "3. The console opens at http://127.0.0.1:8790/\n\n"
            "Keep the window open while you work. No pip install is needed.\n"
        )
    elif kind == "extension":
        body = (
            "Browser extension (Chrome and Edge; the same folder works in both)\n\n"
            "Chrome:  chrome://extensions  -> Developer mode -> Load unpacked -> extension/\n"
            "Edge:    edge://extensions    -> Developer mode -> Load unpacked -> extension/\n\n"
            "Then open a supported AI chat (for example https://chat.deepseek.com),\n"
            "start a new conversation, and press Start in the NonZeroScript bar.\n"
        )
    elif kind == "combined":
        body = (
            "Everything you need is in this archive.\n\n"
            "  controller/   double-click the launcher for your OS (Python 3.9+)\n"
            "  extension/    load unpacked in Chrome or Edge\n"
            "  editor/       copy editor/godot-4.7.2 into your project as\n"
            "                addons/nonzeroscript, then enable the plugin\n\n"
            "Read README.md (English) or README.zh-CN.md (中文) for the full tutorial.\n"
        )
    else:
        body = ""
    return head + body + extra


def make_zip(path: Path, build) -> int:
    tmp = path.with_suffix(".zip.tmp")
    if tmp.exists():
        tmp.unlink()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        count = build(zf)
    tmp.replace(path)
    return count


def editor_folders() -> list[Path]:
    base = ROOT / "editor"
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))


def editor_target(folder: Path) -> str:
    """Where the adapter installs inside a project (build.json may override)."""
    meta = folder / "build.json"
    if meta.exists():
        try:
            loaded = json.loads(meta.read_text(encoding="utf-8"))
            target = loaded.get("target")
            if isinstance(target, str) and target.strip():
                return target.strip().strip("/")
        except (OSError, ValueError):
            pass
    return "addons/nonzeroscript"


def build_editor(folder: Path, path: Path) -> int:
    target = editor_target(folder)

    def build(zf: zipfile.ZipFile) -> int:
        add_text(
            zf,
            "INSTALL.txt",
            install_text(
                "editor",
                read_version(),
                "\nEditor plugin\n\n"
                "The files are already placed under the correct path in this archive:\n"
                f"  {target}/\n\n"
                "Copy that folder into your project root, so your project contains\n"
                f"  {target}/plugin.cfg\n"
                "Then enable NonZeroScript in the editor's plugin settings.\n",
            ),
        )
        return add_tree(zf, folder, target, skip_top=("build.json",))

    return make_zip(path, build)


def build_prompts(path: Path) -> int:
    def build(zf: zipfile.ZipFile) -> int:
        add_text(
            zf,
            "INSTALL.txt",
            install_text(
                "prompts",
                read_version(),
                "\nThese are the instructions NonZeroScript gives the AI.\n\n"
                "  system-prompt.md    the full prompt, with {{PLACEHOLDERS}}\n"
                "  agent-rules.md      the same rules as a checklist\n"
                "  tool-catalogue.md   every command, parameter and description\n"
                "  repair-messages.md  the hints sent back when a reply cannot be parsed\n\n"
                "Nothing here is read at runtime: the live copies are in\n"
                "extension/core/config.js and controller/tools.json. Read these to see\n"
                "exactly what the AI is told, or adapt them to your own project.\n",
            ),
        )
        return add_tree(zf, ROOT / "prompts", "prompts")

    return make_zip(path, build)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(out: Path) -> int:
    version = read_version()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"\nNonZeroScript {version} — building download packages\n")

    n = make_zip(out / "controller.zip", lambda zf: (
        add_text(zf, "INSTALL.txt", install_text("controller", version)),
        add_tree(zf, ROOT / "controller", "controller", skip_top=("data",)),
    )[1])
    print(f"  [ok] controller.zip  {n} files  {(out / 'controller.zip').stat().st_size // 1024} KB")

    n = make_zip(out / "extension.zip", lambda zf: (
        add_text(zf, "INSTALL.txt", install_text("extension", version)),
        add_tree(zf, ROOT / "extension", "extension"),
    )[1])
    print(f"  [ok] extension.zip   {n} files  {(out / 'extension.zip').stat().st_size // 1024} KB")

    for folder in editor_folders():
        path = out / f"editor-{folder.name}.zip"
        n = build_editor(folder, path)
        print(f"  [ok] {path.name}  {n} files -> addons/nonzeroscript/")

    path = out / "prompts.zip"
    n = build_prompts(path)
    print(f"  [ok] prompts.zip     {n} files  {path.stat().st_size // 1024} KB")

    sums = out / "SHA256SUMS.txt"
    lines = []
    for path in sorted(out.glob("*.zip")):
        lines.append(f"{sha256(path)}  {path.name}")
    sums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        where = sums.relative_to(ROOT)
    except ValueError:
        where = sums
    print(f"\nChecksums -> {where}\n")
    for line in lines:
        print("  " + line)
    print()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build NonZeroScript download packages")
    ap.add_argument("--check", action="store_true", help="verify versions and prompt docs, build nothing")
    ap.add_argument("--out", default=None, help="output folder (default: dist/)")
    args = ap.parse_args(argv)

    problems = check_versions() + check_prompts()
    if args.check or problems:
        for problem in problems:
            print(f"FAIL {problem}")
        if problems:
            print(f"\n{len(problems)} problem(s).")
            return 1
        if args.check:
            print(f"OK NonZeroScript {read_version()}: versions and prompt docs are consistent")
        return 0

    return build(Path(args.out) if args.out else DIST)


if __name__ == "__main__":
    sys.exit(main())
