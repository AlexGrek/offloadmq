"""Refuse to start GPU work on a memory-starved Windows machine.

With little free RAM or commit, Windows fails GPU allocations even though video memory
is free, and other programs (Ollama, the editor) die with them.
"""

from __future__ import annotations

import ctypes

#: Required free RAM and free commit (GiB).
MIN_FREE_GIB = 10.0


class _MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
        (name, ctypes.c_ulonglong) for name in
        ("total_phys", "free_phys", "total_commit", "free_commit", "total_virtual", "free_virtual", "free_extended")
    ]


def require_memory(minimum: float = MIN_FREE_GIB) -> None:
    status = _MemoryStatus(length=ctypes.sizeof(_MemoryStatus))
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise SystemExit("cannot read the system memory status")
    ram, commit = status.free_phys / 2**30, status.free_commit / 2**30
    print(f"free memory: RAM {ram:.1f} GiB, commit {commit:.1f} GiB", flush=True)
    if min(ram, commit) < minimum:
        raise SystemExit(f"need {minimum:g} GiB of both free before using the GPU; not starting")
