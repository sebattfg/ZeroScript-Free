# SPDX-License-Identifier: GPL-3.0-or-later
# launch_studio_mcp.py
# ──────────────────────────────────────────────────────────────────────────
#  Robust launcher for Roblox's StudioMCP.exe (the Studio MCP stdio server).
#
#  Roblox ships a %LOCALAPPDATA%\Roblox\mcp.bat, but it hard-codes ONE Studio
#  version path. When Studio auto-updates, that folder is eventually removed and
#  the .bat's fallback branch is broken batch syntax (`else` on its own line),
#  so StudioMCP.exe never launches -> the bridge sees 0 tools -> the extension
#  reports "Bridge or Studio offline".
#
#  This launcher sidesteps that entirely: it finds the NEWEST StudioMCP.exe
#  across all installed Studio versions and execs it, transparently forwarding
#  stdio (it's an MCP stdio server) and any CLI args. We control this code, so
#  there is no stale-path / broken-fallback class of bug.
# ──────────────────────────────────────────────────────────────────────────
import os
import subprocess
import sys


def _candidate_roots():
    """Directories that may contain Roblox Studio version folders."""
    roots = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(os.path.join(local, "Roblox", "Versions"))
    program_files = os.environ.get("ProgramFiles(x86)") or os.environ.get("ProgramFiles")
    if program_files:
        roots.append(os.path.join(program_files, "Roblox", "Versions"))
    return roots


def find_studio_mcp():
    """Return the path to the most recently modified StudioMCP.exe, or None."""
    found = []
    for root in _candidate_roots():
        if not os.path.isdir(root):
            continue
        try:
            for entry in os.listdir(root):
                exe = os.path.join(root, entry, "StudioMCP.exe")
                if os.path.isfile(exe):
                    found.append(exe)
        except OSError:
            continue
    if not found:
        return None
    # Newest by modification time = matches the current Studio install.
    found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return found[0]


def main():
    exe = find_studio_mcp()
    if not exe:
        sys.stderr.write(
            "launch_studio_mcp: no StudioMCP.exe found. Open Roblox Studio and "
            "enable 'Studio as MCP server' (Assistant Settings > MCP Servers).\n"
        )
        return 1
    sys.stderr.write(f"launch_studio_mcp: using {exe}\n")
    sys.stderr.flush()
    # Replace this process so StudioMCP owns the stdio pipes directly.
    proc = subprocess.Popen([exe] + sys.argv[1:])
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return proc.wait()


if __name__ == "__main__":
    sys.exit(main())
