"""Background capability scan state shared with the UI."""
from __future__ import annotations

import threading
from typing import Any


class ScanState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._caps: list[str] = []
        self._sysinfo: dict[str, Any] = {}
        self._scanning = False

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "caps": list(self._caps),
                "sysinfo": dict(self._sysinfo),
                "scanning": self._scanning,
            }

    def set_scanning(self, scanning: bool) -> None:
        with self._lock:
            self._scanning = scanning

    def set_result(self, caps: list[str], sysinfo: dict[str, Any]) -> None:
        with self._lock:
            self._caps = list(caps)
            self._sysinfo = dict(sysinfo)
            self._scanning = False
