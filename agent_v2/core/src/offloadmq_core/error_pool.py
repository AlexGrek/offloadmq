"""Pending agent-log entries that wait for a live server connection.

Anything the orchestrator considers worth telling the server about — connection
failures, registration errors, poll loop crashes, executor failures — is pushed
here. The supervisor drains the pool every time it (re)connects, so the server
ends up with the full story of what happened during any disconnected interval.

The pool is intentionally in-memory only. It is bounded so an offline agent
can't grow it without limit; oldest entries are dropped first.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

Severity = Literal["CRITICAL", "ERROR", "INFO"]


@dataclass(slots=True)
class PendingLog:
    severity: Severity
    text: str
    captured_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def render(self) -> str:
        """Render the entry as a single log line for the server.

        The server adds its own ingest timestamp, so we prepend the original
        capture time to preserve the actual moment of failure.
        """
        return f"[{self.captured_at.isoformat(timespec='seconds')}] {self.text}"


class ErrorPool:
    """Bounded thread-safe queue of unsent log entries."""

    def __init__(self, capacity: int = 500) -> None:
        self._capacity = max(1, capacity)
        self._lock = threading.Lock()
        self._items: list[PendingLog] = []
        self._dropped = 0

    def push(self, severity: Severity, text: str) -> None:
        with self._lock:
            self._items.append(PendingLog(severity=severity, text=text))
            overflow = len(self._items) - self._capacity
            if overflow > 0:
                # Drop the oldest entries first. We track the count so the
                # server can be told how many entries we lost.
                del self._items[:overflow]
                self._dropped += overflow

    def drain(self) -> tuple[list[PendingLog], int]:
        """Atomically remove and return all pending entries.

        Returns a tuple of (entries, dropped_since_last_drain). The dropped
        counter resets — callers are expected to report it to the server in
        the same flush call.
        """
        with self._lock:
            items = self._items
            self._items = []
            dropped = self._dropped
            self._dropped = 0
        return items, dropped

    def restore(self, items: list[PendingLog]) -> None:
        """Push items back at the front when a flush fails partway."""
        if not items:
            return
        with self._lock:
            # Restored entries go to the front so the next drain processes
            # them before any newer failures.
            self._items = items + self._items
            overflow = len(self._items) - self._capacity
            if overflow > 0:
                del self._items[:overflow]
                self._dropped += overflow

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def snapshot(self) -> list[PendingLog]:
        """Read-only copy for diagnostics — does not drain."""
        with self._lock:
            return list(self._items)
