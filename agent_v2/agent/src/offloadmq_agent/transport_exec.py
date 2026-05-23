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
    def poll_task(self, timeout: int = 60) -> dict[str, Any]: ...
    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]: ...
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

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        return self._inner.poll_task(timeout=timeout)

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        return self._inner.take_task(raw_id, raw_cap, timeout=timeout)

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> requests.Response:
        from offloadmq_agent.exec.reporting import TaskCancelled

        if report.log_update:
            msg = report.log_update[:500]
        elif report.stage:
            msg = report.stage
        else:
            msg = ""
        if self._progress_hook:
            self._progress_hook(report.stage or "", msg)
        try:
            return self._inner.post_task_progress(task_id, report, timeout=timeout)
        except Exception as exc:
            if "499" in str(exc):
                raise TaskCancelled("cancelled") from exc
            resp = self._inner.post_task_progress(task_id, report, timeout=timeout)
            if resp.status_code == 499:
                raise TaskCancelled("cancelled")
            return resp

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
