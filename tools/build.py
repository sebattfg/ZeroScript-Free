#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the NonZeroScript release archives.

This is a manual, offline build. There is deliberately no CI job that runs it.

    python3 tools/build.py            # dist/*.zip + SHA256SUMS.txt
    python3 tools/build.py --clean    # remove dist/ first
    python3 tools/build.py --exe      # also build a single-file controller exe
                                      # (requires: pip install pyinstaller)

Archives produced:
    controller.zip            controller/ (console, relay, launchers)
    extension.zip             extension/  (load unpacked in Chrome/Edge)
    editor-<folder>.zip       one per folder under editor/, contents placed at
                              that folder's build.json "target" path
    NonZeroScript-<ver>.zip   everything + docs, for a normal download
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SKIP_NAMES = {"__pycache__", "node_modules", ".git", ".godot", "dist", ".arena"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".zip", ".DS_Store"}
DOC_FILES = ["README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "CHANGELOG.md", "version.txt"]


def read_version() -> str:
    try:
        return (ROOT / "version.txt").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def iter_files(base: Path, skip_top: tuple[str, ...] = ()):
    """Yield files under *base* in stable order, skipping junk."""
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if rel.parts and rel.parts[0] in skip_top:
            continue
        if any(part in SKIP_NAMES for part in rel.parts):
            continue
        if path.suffix in SKIP_SUFFIXES or path.name in SKIP_NAMES:
            continue
        if path.name.startswith(".") and path.name != ".gitignore":
            continue
        yield rel


def add_tree(zf: zipfile.ZipFile, base: Path, prefix: str, skip_top: tuple[str, ...] = ()) -> int:
    count = 0
    for rel in iter_files(base, skip_top):
        arcname = "/".join(p for p in (prefix, rel.as_posix()) if p)
        zf.write(base / rel, arcname)
        count += 1
    return count


def add_bytes(zf: zipfile.ZipFile, arcname: str, text: str) -> None:
    zf.writestr(arcname, text.replace("\r\n", "\n"), compress_type=zipfile.ZIP_DEFLATED)


def install_text(kind: str) -> str:
    version = read_version()
    common = f"NonZeroScript {version}\n{'=' * (16 + len(version))}\n\n"
    if kind == "controller":
        return common + (
            "Controller (visual console + local relay)\n\n"
            "1. Install Python 3.9 or newer: https://www.python.org/downloads/\n"
            "2. Double-click one of:\n"
            "     Windows   controller/start.bat\n"
            "     macOS     controller/start.command  (right-click > Open the first time)\n"
            "     Linux     controller/start.sh\n"
            "3. The console opens at http://127.0.0.1:8790/\n\n"
            "Keep the window open while you work. Standard library only: no pip install.\n"
        )
    if kind == "extension":
        return common + (
            "Browser extension (Chrome and Edge; the same folder works in both)\n\n"
            "Chrome:  chrome://extensions  -> Developer mode -> Load unpacked -> extension/\n"
            "Edge:    edge://extensions    -> Developer mode -> Load unpacked -> extension/\n\n"
            "Then open a supported AI chat (for example https://chat.deepseek.com),\n"
            "start a new conversation, and press Start in the NonZeroScript bar.\n"
        )
    if kind == "combined":
        return common + (
            "Everything you need is in this archive.\n\n"
            "  controller/   double-click the launcher for your OS (Python 3.9+)\n"
            "  extension/    load unpacked in Chrome or Edge\n"
            "  editor/       copy editor/godot-4.7.2 into your project as\n"
            "                addons/nonzeroscript, then enable the plugin\n\n"
            "Read README.md (English) or README.zh-CN.md (中文) for the full tutorial.\n"
        )
    return common


def make_zip(path: Path, build) -> int:
    tmp = path.with_suffix(".zip.tmp")
    if tmp.exists():
        tmp.unlink()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        count = build(zf)
    tmp.replace(path)
    return count


def build_controller(path: Path) -> int:
    def build(zf: zipfile.ZipFile) -> int:
        add_bytes(zf, "INSTALL.txt", install_text("controller"))
        return add_tree(zf, ROOT / "controller", "controller", skip_top=("data",))

    return make_zip(path, build)


def build_extension(path: Path) -> int:
    def build(zf: zipfile.ZipFile) -> int:
        add_bytes(zf, "INSTALL.txt", install_text("extension"))
        return add_tree(zf, ROOT / "extension", "extension")

    return make_zip(path, build)


def editor_folders() -> list[Path]:
    base = ROOT / "editor"
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))


def editor_meta(folder: Path) -> dict:
    meta = {"artifact": f"editor-{folder.name}", "target": f"addons/{folder.name}"}
    cfg = folder / "build.json"
    if cfg.exists():
        try:
            loaded = json.loads(cfg.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta.update({k: v for k, v in loaded.items() if isinstance(v, str)})
        except (OSError, ValueError) as exc:
            print(f"  [!] {cfg.relative_to(ROOT)}: {exc}")
    return meta


def build_editor(folder: Path, path: Path) -> int:
    meta = editor_meta(folder)

    def build(zf: zipfile.ZipFile) -> int:
        title = (
            f"Editor plugin for {meta.get('engine', folder.name)}\n\n"
            f"{meta.get('install', 'Extract into your project and enable the plugin in the editor settings.')}\n\n"
            "The files are already placed under the correct path in this archive:\n"
            f"  {meta['target']}/\n\n"
            "Copy that folder into your project root, so your project contains\n"
            f"  {meta['target']}/plugin.cfg\n"
            "Then enable NonZeroScript in the editor's plugin settings.\n"
        )
        add_bytes(zf, "INSTALL.txt", install_text("editor") + "\n" + title)
        return add_tree(zf, folder, meta["target"], skip_top=("build.json",))

    return make_zip(path, build)


def build_combined(path: Path, version: str, editor_zips: list[tuple[Path, Path, dict]]) -> int:
    def build(zf: zipfile.ZipFile) -> int:
        count = 0
        add_bytes(zf, "INSTALL.txt", install_text("combined"))
        add_bytes(
            zf,
            "BUILD-INFO.txt",
            f"NonZeroScript {version}\nbuilt {date.today().isoformat()}\n"
            f"python {sys.version.split()[0]}\n",
        )
        for name in DOC_FILES:
            src = ROOT / name
            if src.exists():
                zf.write(src, name)
                count += 1
        count += add_tree(zf, ROOT / "assets", "assets")
        count += add_tree(zf, ROOT / "controller", "controller", skip_top=("data",))
        count += add_tree(zf, ROOT / "extension", "extension")
        for folder, _zip_path, meta in editor_zips:
            count += add_tree(zf, folder, f"editor/{folder.name}", skip_top=("build.json",))
        return count

    return make_zip(path, build)


def build_exe(version: str) -> Path | None:
    if shutil.which("pyinstaller") is None:
        try:
            import PyInstaller  # noqa: F401
        except ImportError:
            print("  [!] --exe requested but PyInstaller is not installed; skipping.")
            print("      pip install pyinstaller   then run again.")
            return None
    out = DIST / "exe"
    work = DIST / "_pyinstaller"
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    sep = ";" if os.name == "nt" else ":"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "NonZeroScript",
        "--distpath",
        str(out),
        "--workpath",
        str(work),
        "--specpath",
        str(work),
        "--add-data",
        f"ui{sep}ui",
        "--add-data",
        f"tools.json{sep}.",
        "main.py",
    ]
    print("  $ " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=ROOT / "controller")
    if result.returncode != 0:
        print("  [!] PyInstaller failed.")
        return None
    exe = out / ("NonZeroScript.exe" if os.name == "nt" else "NonZeroScript")
    if not exe.exists():
        print("  [!] PyInstaller reported success but no executable was found.")
        return None
    print(f"  [ok] {exe.relative_to(ROOT)}  ({exe.stat().st_size / 1048576:.1f} MB)")
    return exe


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_versions(version: str) -> None:
    checks = [
        (ROOT / "extension" / "manifest.json", ("version",), json.loads),
        (ROOT / "controller" / "version.py", ("__version__",), None),
    ]
    cfg = ROOT / "editor" / "godot-4.7.2" / "plugin.cfg"
    if cfg.exists():
        for line in cfg.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("version="):
                found = line.split("=", 1)[1].strip().strip('"')
                if found != version:
                    print(f"  [!] editor/godot-4.7.2/plugin.cfg is {found}, expected {version}")
                break
    for path, _keys, loader in checks:
        if not path.exists():
            continue
        try:
            if loader is json.loads:
                found = json.loads(path.read_text(encoding="utf-8")).get("version")
            else:
                found = None
                for line in path.read_text(encoding="utf-8").splitlines():
                    if line.strip().startswith("__version__"):
                        found = line.split("=", 1)[1].strip().strip('"\'')
                        break
            if found and found != version:
                print(f"  [!] {path.relative_to(ROOT)} is {found}, expected {version}")
        except (OSError, ValueError) as exc:
            print(f"  [!] could not read {path.relative_to(ROOT)}: {exc}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build NonZeroScript release archives (manual, offline)")
    ap.add_argument("--clean", action="store_true", help="delete dist/ before building")
    ap.add_argument("--exe", action="store_true", help="also build a single-file controller with PyInstaller")
    args = ap.parse_args(argv)

    version = read_version()
    if args.clean and DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True, exist_ok=True)

    print(f"\nNonZeroScript {version} — building release archives\n")
    print("Version check:")
    check_versions(version)

    produced: list[Path] = []

    print("\nController")
    p = DIST / "controller.zip"
    n = build_controller(p)
    produced.append(p)
    print(f"  [ok] {p.name}  {n} files  {p.stat().st_size / 1024:.0f} KB")

    print("\nExtension")
    p = DIST / "extension.zip"
    n = build_extension(p)
    produced.append(p)
    print(f"  [ok] {p.name}  {n} files  {p.stat().st_size / 1024:.0f} KB")

    print("\nEditor plugins (one archive per folder under editor/)")
    editors = editor_folders()
    if not editors:
        print("  [!] no folders under editor/")
    editor_zips: list[tuple[Path, Path, dict]] = []
    for folder in editors:
        meta = editor_meta(folder)
        p = DIST / f"{meta['artifact']}.zip"
        n = build_editor(folder, p)
        produced.append(p)
        editor_zips.append((folder, p, meta))
        print(f"  [ok] {p.name}  {n} files -> {meta['target']}/")

    print("\nCombined")
    p = DIST / f"NonZeroScript-{version}.zip"
    n = build_combined(p, version, editor_zips)
    produced.append(p)
    print(f"  [ok] {p.name}  {n} files  {p.stat().st_size / 1024:.0f} KB")

    if args.exe:
        print("\nController executable (optional)")
        exe = build_exe(version)
        if exe:
            produced.append(exe)

    sums = DIST / "SHA256SUMS.txt"
    lines = [f"{sha256(p)}  {p.relative_to(DIST).as_posix()}" for p in produced if p.exists()]
    sums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nChecksums -> {sums.relative_to(ROOT)}")
    for line in lines:
        print("  " + line)
    print("\nDone. Archives are in dist/ (not committed; see .gitignore).\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
