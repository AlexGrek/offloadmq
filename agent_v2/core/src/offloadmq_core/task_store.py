"""In-memory store of task records with structured per-task logs.

Cleared on every agent (process) restart — intentionally not persisted.
Thread-safe: the polling thread and executor-pool worker threads both write.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from pydantic import BaseModel, Field

from offloadmq_agent.models import LogEntry, Task, TaskResult, TaskStatus

_MAX_TERMINAL_TASKS = 200  # cap on retained finished/failed/cancelled records


class TaskRecord(BaseModel):
    id: str
    capability: str
    payload: dict[str, Any] = Field(default_factory=dict)
    status: TaskStatus = TaskStatus.RUNNING
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    logs: list[LogEntry] = Field(default_factory=list)
    result: TaskResult | None = None
    error: str | None = None

    @property
    def is_terminal(self) -> bool:
        return self.status in (
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        )

    @property
    def duration(self) -> float | None:
        if self.started_at is None:
            return None
        end = self.finished_at if self.finished_at is not None else time.time()
        return end - self.started_at


class TaskStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, TaskRecord] = {}
        # Per-task cancel flags, shared with the executor pool.
        self._cancel_events: dict[str, threading.Event] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def create(self, task: Task) -> tuple[TaskRecord, threading.Event]:
        with self._lock:
            record = TaskRecord(
                id=task.id,
                capability=task.capability,
                payload=task.payload,
                status=TaskStatus.RUNNING,
                started_at=time.time(),
            )
            event = threading.Event()
            self._records[task.id] = record
            self._cancel_events[task.id] = event
            return record, event

    def append_log(self, task_id: str, entry: LogEntry) -> None:
        with self._lock:
            record = self._records.get(task_id)
            if record is not None:
                record.logs.append(entry)

    def finish(self, task_id: str, result: TaskResult) -> None:
        with self._lock:
            record = self._records.get(task_id)
            if record is None:
                return
            record.status = result.status
            record.result = result
            record.error = result.error
            record.finished_at = time.time()
            self._cancel_events.pop(task_id, None)
            self._evict_locked()

    def request_cancel(self, task_id: str) -> bool:
        with self._lock:
            event = self._cancel_events.get(task_id)
            if event is None:
                return False
            event.set()
            return True

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            record = self._records.get(task_id)
            return record.model_copy(deep=True) if record else None

    def list(self) -> list[TaskRecord]:
        with self._lock:
            return [r.model_copy(deep=True) for r in self._records.values()]

    def active_count(self) -> int:
        with self._lock:
            return sum(1 for r in self._records.values() if not r.is_terminal)

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
            self._cancel_events.clear()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _evict_locked(self) -> None:
        terminal = [r for r in self._records.values() if r.is_terminal]
        if len(terminal) <= _MAX_TERMINAL_TASKS:
            return
        terminal.sort(key=lambda r: r.finished_at or 0)
        for record in terminal[: len(terminal) - _MAX_TERMINAL_TASKS]:
            self._records.pop(record.id, None)
