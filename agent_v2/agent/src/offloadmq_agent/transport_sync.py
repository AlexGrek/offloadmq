"""Synchronous HTTP transport for legacy executor integration."""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import requests

from offloadmq_agent.models import Task


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

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        resp = self.get("private", "agent", "task", "poll", timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        return dict(data) if data is not None else {}

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        resp = self.post(
            "private",
            "agent",
            "take",
            quote(raw_cap, safe=""),
            quote(raw_id, safe=""),
            json_body={},
            timeout=timeout,
        )
        resp.raise_for_status()
        return dict(resp.json())

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
        url = self._url("private", "agent", "bucket", bucket_uid, "upload")
        resp = requests.post(
            url,
            headers=self._headers,
            files={"file": (filename, content, content_type)},
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        return str(data["file_uid"])

    def update_agent_info(
        self,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str | None = None,
        app_version: str = "2.0.0",
    ) -> None:
        from offloadmq_agent.systeminfo import collect_system_info

        sysinfo = collect_system_info()
        body: dict[str, Any] = {
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "systemInfo": sysinfo,
            "appVersion": app_version,
        }
        if display_name:
            body["displayName"] = display_name[:50]
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
