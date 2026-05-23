"""Parallel executor pool.

Each task runs in its own OS thread (bounded by `max_workers`, default 1).
Inside the worker thread we drive the async executor with `asyncio.run`, so the
agent library stays fully async while core gets real thread-level parallelism.
"""
from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from offloadmq_agent.context import ExecContext, TaskCancelled
from offloadmq_agent.executor import Executor
from offloadmq_agent.models import LogEntry, Task, TaskResult, TaskStatus

# Called from the worker thread when the task reaches a terminal state.
DoneCallback = Callable[[Task, TaskResult], None]
# Called from the worker thread for every structured log entry.
LogCallback = Callable[[str, LogEntry], None]


class ExecutorPool:
    def __init__(self, max_workers: int = 1) -> None:
        self._max_workers = max(1, max_workers)
        self._pool = ThreadPoolExecutor(
            max_workers=self._max_workers,
            thread_name_prefix="omq-exec",
        )

    @property
    def max_workers(self) -> int:
        return self._max_workers

    def submit(
        self,
        task: Task,
        executor: Executor,
        cancel_event: threading.Event,
        on_log: LogCallback,
        on_done: DoneCallback,
    ) -> None:
        self._pool.submit(
            self._run, task, executor, cancel_event, on_log, on_done
        )

    def shutdown(self, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait, cancel_futures=True)

    # ------------------------------------------------------------------
    # Worker thread body
    # ------------------------------------------------------------------

    def _run(
        self,
        task: Task,
        executor: Executor,
        cancel_event: threading.Event,
        on_log: LogCallback,
        on_done: DoneCallback,
    ) -> None:
        ctx = ExecContext(
            log_sink=lambda entry: on_log(task.id, entry),
            cancel_event=cancel_event,
        )
        try:
            result = asyncio.run(executor(task, ctx))
        except TaskCancelled:
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.CANCELLED,
                error="Cancelled by user",
            )
        except Exception as exc:  # noqa: BLE001 — must never crash the worker
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                error=str(exc),
            )
        on_done(task, result)
