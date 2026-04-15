from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import quote

import requests

from .httphelpers import HttpClient
from .models import TaskId, TaskProgressReport, TaskResultReport
from .url_utils import qpart


class AgentTransport(Protocol):
    """Task-plane transport abstraction for polling and reporting."""

    def get(self, *segments: str, timeout: int = 60) -> requests.Response:
        ...

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> requests.Response:
        ...

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        ...

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        ...

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> requests.Response:
        ...

    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> requests.Response:
        ...

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        """Upload a file to an output bucket. Returns the file_uid assigned by the server."""
        ...


class HttpAgentTransport:
    """HTTP transport implementation for agent task operations."""

    def __init__(self, server_base: str, jwt_token: str):
        self._http = HttpClient(server_base, jwt_token)

    def get(self, *segments: str, timeout: int = 60) -> requests.Response:
        return self._http.get(*segments, timeout=timeout)

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> requests.Response:
        return self._http.post(*segments, json_body=json_body, timeout=timeout)

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        resp = self._http.get("private", "agent", "task", "poll", timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        return dict(data) if data is not None else {}

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        q_cap = qpart(raw_cap)
        resp = self._http.post(
            "private",
            "agent",
            "take",
            q_cap,
            qpart(raw_id),
            json_body={},
            timeout=timeout,
        )
        resp.raise_for_status()
        return dict(resp.json())

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> requests.Response:
        q = task_id.quoted()
        return self._http.post(
            "private",
            "agent",
            "task",
            "progress",
            q.cap,
            q.id,
            json_body=report.to_wire(),
            timeout=timeout,
        )

    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> requests.Response:
        q = report.task_id.quoted()
        return self._http.post(
            "private",
            "agent",
            "task",
            "resolve",
            q.cap,
            q.id,
            json_body=report.to_wire(),
            timeout=timeout,
        )

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        q_bucket = quote(bucket_uid, safe="")
        url = f"{self._http.base}/private/agent/bucket/{q_bucket}/upload"
        resp = requests.post(
            url,
            headers=self._http.headers,
            files={"file": (filename, content, content_type)},
            timeout=timeout,
        )
        resp.raise_for_status()
        return str(resp.json()["file_uid"])
