"""Execution context handed to every executor.

Carries the structured-log sink and the cooperative cancellation flag.
Created by the orchestrator (core), consumed by executors (agent).
"""
from __future__ import annotations

import threading
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    pass

from offloadmq_agent.models import LogEntry, LogLevel


class TaskCancelled(Exception):
    """Raised by raise_if_cancelled() when a task has been asked to stop."""


ProgressReporter = Callable[[str, str, str], None]


class ExecContext:
    def __init__(
        self,
        log_sink: Callable[[LogEntry], None],
        cancel_event: threading.Event | None = None,
        *,
        progress_reporter: ProgressReporter | None = None,
        legacy_transport: Any | None = None,
        agent_transport: Any | None = None,
    ) -> None:
        self._log_sink = log_sink
        self._cancel_event = cancel_event or threading.Event()
        self._progress_reporter = progress_reporter
        self.agent_transport = agent_transport if agent_transport is not None else legacy_transport
        self.legacy_transport = self.agent_transport

    # ------------------------------------------------------------------
    # Logging — all structured
    # ------------------------------------------------------------------

    async def progress(self, stage: str, message: str, **data: Any) -> None:
        self._emit(LogLevel.PROGRESS, stage, message, data)
        if self._progress_reporter is not None:
            self._progress_reporter(stage, message, "")

    async def info(self, message: str, **data: Any) -> None:
        self._emit(LogLevel.INFO, "", message, data)

    async def warn(self, message: str, **data: Any) -> None:
        self._emit(LogLevel.WARN, "", message, data)

    async def error(self, message: str, **data: Any) -> None:
        self._emit(LogLevel.ERROR, "", message, data)

    def _emit(self, level: LogLevel, stage: str, message: str, data: dict[str, Any]) -> None:
        self._log_sink(LogEntry(level=level, stage=stage, message=message, data=data))

    # ------------------------------------------------------------------
    # Cancellation — cooperative
    # ------------------------------------------------------------------

    @property
    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._cancel_event.is_set():
            raise TaskCancelled()

    @property
    def cancel_event(self) -> threading.Event:
        return self._cancel_event
