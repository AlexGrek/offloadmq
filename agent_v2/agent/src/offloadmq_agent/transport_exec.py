"""Executor-facing HTTP transport (sync requests, capture mode for v2 resolve)."""
from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

import requests

from offloadmq_agent.context import ExecContext
from offloadmq_agent.transport_sync import SyncAgentTransport
from offloadmq_agent.wire import TaskId, TaskProgressReport, TaskResultReport

logger = logging.getLogger(__name__)


@runtime_checkable
class AgentTransport(Protocol):
    def get(self, *segments: str, timeout: int = 60) -> requests.Response: ...
    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> requests.Response: ...
    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> requests.Response: ...
    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> requests.Response: ...
    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str: ...


class _FakeResponse:
    def __init__(self, status: int = 200, data: Any = None) -> None:
        self.status_code = status
        self._data = data
        self.content = b""

    def json(self) -> Any:
        return self._data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)  # type: ignore[arg-type]


class CaptureTransport:
    """Wraps sync transport: forwards I/O, captures final result, maps progress to ctx."""

    def __init__(
        self,
        inner: SyncAgentTransport,
        ctx: ExecContext,
        *,
        progress_hook: Any | None = None,
    ) -> None:
        self._inner = inner
        self._ctx = ctx
        self._progress_hook = progress_hook
        self.captured_report: TaskResultReport | None = None

    def get(self, *segments: str, timeout: int = 60) -> requests.Response:
        return self._inner.get(*segments, timeout=timeout)

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> requests.Response:
        return self._inner.post(*segments, json_body=json_body, timeout=timeout)

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> requests.Response:
        from offloadmq_agent.exec.reporting import TaskCancelled

        # Forward the progress upstream. The hook routes it to the orchestrator,
        # which sends it to the server over the WebSocket (no HTTP progress call).
        msg = report.log_update or report.stage or ""
        if self._progress_hook:
            self._progress_hook(report.stage or "", msg)
        # Cancellation now arrives as a server WS push that sets the ctx cancel
        # event; routed executors learn about it on their next progress call,
        # preserving the previous HTTP-499 behavior.
        if self._ctx.cancelled:
            raise TaskCancelled("cancelled")
        return _FakeResponse(200)  # type: ignore[return-value]

    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> requests.Response:
        self.captured_report = report
        return _FakeResponse(200)  # type: ignore[return-value]

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        return self._inner.upload_file(
            bucket_uid, filename, content, content_type, timeout=timeout
        )
