# SPDX-License-Identifier: GPL-3.0-or-later
"""Tiny runtime metrics for the console (standard library only).

The performance modes promise a small footprint, so the console shows the real
resident set size instead of asking the user to trust a number in the docs.
Windows, macOS and Python 3.9+ are supported; anything unknown returns 0.0 and
the console simply hides the figure.
"""

from __future__ import annotations

import sys


def rss_mb() -> float:
    """Resident set size of this process in MiB (0.0 when unavailable)."""
    try:
        if sys.platform == "win32":
            return _rss_windows()
        return _rss_unix()
    except Exception:
        return 0.0


def _rss_windows() -> float:
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    process = ctypes.windll.kernel32.GetCurrentProcess()  # type: ignore[attr-defined]
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(  # type: ignore[attr-defined]
        process, ctypes.byref(counters), counters.cb
    )
    if not ok:
        return 0.0
    return round(int(counters.WorkingSetSize) / (1024 * 1024), 1)


def _rss_unix() -> float:
    import resource

    usage = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    # macOS reports bytes, every other Unix reports kilobytes.
    kb = usage / 1024 if sys.platform == "darwin" else usage
    return round(kb / 1024, 1)
