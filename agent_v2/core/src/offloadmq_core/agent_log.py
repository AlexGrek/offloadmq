"""Thread-safe global agent log ring buffer for the web UI."""
from __future__ import annotations

import threading
from collections import deque

_MAX_LINES = 500


class AgentLogBuffer:
    def __init__(self, maxlen: int = _MAX_LINES) -> None:
        self._buf: deque[str] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def append(self, line: str) -> None:
        with self._lock:
            self._buf.append(line)

    def tail(self, n: int = 100) -> list[str]:
        with self._lock:
            if n <= 0:
                return list(self._buf)
            return list(self._buf)[-n:]

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()
