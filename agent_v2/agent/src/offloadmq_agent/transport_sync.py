"""Synchronous HTTP transport for legacy executor integration."""
from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import quote

import requests

from offloadmq_agent.models import Task

logger = logging.getLogger("agent")

# Output uploads are retried: they happen after the job is already done, so a
# transient network failure there would discard finished work.
_UPLOAD_ATTEMPTS = 3
_UPLOAD_RETRY_BACKOFF_SECS = 2.0


class SyncAgentTransport:
    """Minimal AgentTransport-compatible wrapper using requests."""

    def __init__(self, server_base: str, jwt_token: str) -> None:
        self._base = server_base.rstrip("/")
        self._headers = {"Authorization": f"Bearer {jwt_token}"}

    def _url(self, *segments: str) -> str:
        return "/".join([self._base, *[quote(s, safe="") for s in segments]])

    def get(self, *segments: str, timeout: int = 60) -> requests.Response:
        return requests.get(self._url(*segments), headers=self._headers, timeout=timeout)

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> requests.Response:
        return requests.post(
            self._url(*segments), headers=self._headers, json=json_body, timeout=timeout
        )

    def post_task_progress(
        self, task_id: Any, report: Any, timeout: int = 10
    ) -> requests.Response:
        q = task_id.quoted()
        return self.post(
            "private",
            "agent",
            "task",
            "progress",
            q.cap,
            q.id,
            json_body=report.to_wire(),
            timeout=timeout,
        )

    def post_task_result(self, report: Any, timeout: int = 60) -> requests.Response:
        q = report.task_id.quoted()
        return self.post(
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
        """Upload one output file to a task's bucket, retrying transient failures.

        This is the tail end of a finished job — the model already ran, so a
        blip on the wire here throws away real work and (worse) turns a
        completed task into a failure. Connection errors, timeouts and 5xx are
        therefore retried; a 4xx is the server refusing the file (bucket gone,
        too large) and fails immediately.

        A retry after a connection error can leave an orphan copy of the file in
        the bucket if the server had in fact committed it. That is harmless —
        only the returned ``file_uid`` is ever referenced, and the bucket is
        reaped with the task.
        """
        url = self._url("private", "agent", "bucket", bucket_uid, "upload")
        last_error: Exception | None = None
        for attempt in range(1, _UPLOAD_ATTEMPTS + 1):
            try:
                resp = requests.post(
                    url,
                    headers=self._headers,
                    files={"file": (filename, content, content_type)},
                    timeout=timeout,
                )
            except requests.RequestException as exc:
                last_error = exc
            else:
                if resp.ok:
                    data = resp.json()
                    return str(data["file_uid"])
                body = resp.text[:500].strip()
                error = requests.HTTPError(
                    f"Bucket upload failed (HTTP {resp.status_code}) bucket={bucket_uid} "
                    f"file={filename} size={len(content)}: {body}",
                    response=resp,
                )
                if resp.status_code < 500:
                    raise error
                last_error = error

            if attempt < _UPLOAD_ATTEMPTS:
                logger.warning(
                    "Bucket upload attempt %d/%d for %s failed (%s); retrying",
                    attempt, _UPLOAD_ATTEMPTS, filename, last_error,
                )
                time.sleep(_UPLOAD_RETRY_BACKOFF_SECS * attempt)

        assert last_error is not None
        raise last_error

    def update_agent_info(
        self,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str | None = None,
        app_version: str = "2.0.0",
    ) -> None:
        from offloadmq_agent.systeminfo import (
            collect_system_info,
            effective_display_name,
        )

        sysinfo = collect_system_info()
        body: dict[str, Any] = {
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "systemInfo": sysinfo,
            "appVersion": app_version,
            "displayName": effective_display_name(display_name, sysinfo),
        }
        resp = self.post(
            "private", "agent", "info", "update", json_body=body, timeout=30
        )
        resp.raise_for_status()


def task_to_legacy_wire(task: Task) -> dict[str, Any]:
    """Build legacy handle_task dict from v2 Task."""
    if task.server_task:
        return {
            "id": task.server_task.get("id", {"id": task.id, "cap": task.capability}),
            "data": task.server_task.get("data", {"payload": task.payload}),
        }
    return {
        "id": {"id": task.id, "cap": task.capability},
        "data": {"payload": task.payload, "capability": task.capability},
    }
