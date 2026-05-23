"""Parallel executor pool."""
from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from offloadmq_agent.context import ExecContext, TaskCancelled
from offloadmq_agent.executor import Executor
from offloadmq_agent.models import LogEntry, Task, TaskResult, TaskStatus

DoneCallback = Callable[[Task, TaskResult], None]
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
        *,
        progress_reporter: Callable[[str, str, str], None] | None = None,
        agent_transport: Any | None = None,
        legacy_transport: Any | None = None,
    ) -> None:
        transport = agent_transport if agent_transport is not None else legacy_transport
        self._pool.submit(
            self._run,
            task,
            executor,
            cancel_event,
            on_log,
            on_done,
            progress_reporter,
            transport,
        )

    def shutdown(self, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait, cancel_futures=True)

    def _run(
        self,
        task: Task,
        executor: Executor,
        cancel_event: threading.Event,
        on_log: LogCallback,
        on_done: DoneCallback,
        progress_reporter: Callable[[str, str, str], None] | None,
        agent_transport: Any | None,
    ) -> None:
        ctx = ExecContext(
            log_sink=lambda entry: on_log(task.id, entry),
            cancel_event=cancel_event,
            progress_reporter=progress_reporter,
            agent_transport=agent_transport,
        )
        try:
            result = asyncio.run(executor(task, ctx))
        except TaskCancelled:
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.CANCELLED,
                error="Cancelled by user",
            )
        except Exception as exc:  # noqa: BLE001
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                error=str(exc),
            )
        on_done(task, result)
