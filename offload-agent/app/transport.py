from __future__ import annotations

import base64
import json
import logging
import threading
import uuid
from typing import Any, Protocol, runtime_checkable
from urllib.parse import quote, urlparse

import requests

from .httphelpers import HttpClient
from .models import TaskId, TaskProgressReport, TaskResultReport
from .url_utils import qpart

logger = logging.getLogger("agent")


# ---------------------------------------------------------------------------
# Response abstraction — lets WS transport return response-like objects
# that are compatible with existing error-handling code.
# ---------------------------------------------------------------------------

@runtime_checkable
class ResponseLike(Protocol):
    """Minimal response surface used by callers of AgentTransport."""

    @property
    def status_code(self) -> int: ...

    @property
    def content(self) -> bytes: ...

    def json(self) -> Any: ...

    def raise_for_status(self) -> None: ...


class WsResponse:
    """Wraps a WS JSON response envelope to satisfy ``ResponseLike``."""

    def __init__(self, envelope: dict[str, Any]) -> None:
        self._envelope = envelope
        resp_status = envelope.get("status", 200)
        self._status_code: int = int(resp_status) if resp_status is not None else 200
        self._data: Any = envelope.get("data")
        # Build content bytes from data
        if self._data is not None:
            self._content = json.dumps(self._data).encode("utf-8")
        else:
            self._content = b""

    @property
    def status_code(self) -> int:
        return self._status_code

    @property
    def content(self) -> bytes:
        return self._content

    def json(self) -> Any:
        return self._data

    def raise_for_status(self) -> None:
        if self._status_code >= 400:
            # Build a synthetic requests.Response so that isinstance checks
            # against requests.HTTPError work in existing error-handling code.
            fake = requests.Response()
            fake.status_code = self._status_code
            fake._content = self._content
            error_msg = ""
            if isinstance(self._data, dict):
                err = self._data.get("error") or self._data
                if isinstance(err, dict):
                    error_msg = err.get("message", str(err))
                else:
                    error_msg = str(err)
            raise requests.HTTPError(
                f"WS {self._status_code}: {error_msg}",
                response=fake,
            )


# ---------------------------------------------------------------------------
# Transport protocol
# ---------------------------------------------------------------------------

class AgentTransport(Protocol):
    """Task-plane transport abstraction for polling and reporting."""

    def get(self, *segments: str, timeout: int = 60) -> ResponseLike:
        ...

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> ResponseLike:
        ...

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        ...

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        ...

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> ResponseLike:
        ...

    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> ResponseLike:
        ...

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        """Upload a file to an output bucket. Returns the file_uid assigned by the server."""
        ...


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# WebSocket transport
# ---------------------------------------------------------------------------

def build_ws_url(server_url: str, jwt_token: str) -> str:
    """Convert HTTP server URL to WebSocket URL with token query param."""
    parsed = urlparse(server_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{ws_scheme}://{parsed.netloc}/private/agent/ws?token={jwt_token}"


class WebSocketAgentTransport:
    """WebSocket transport implementation for agent task operations.

    Uses synchronous ``websocket.WebSocket`` (from ``websocket-client``) to
    match the agent's synchronous main loop.  All requests are serialized
    via ``_lock`` so the single WS connection is never interleaved.
    """

    def __init__(self, server_url: str, jwt_token: str) -> None:
        import websocket as ws_lib
        self._ws_lib = ws_lib
        self._server_url = server_url
        self._jwt_token = jwt_token
        self._ws: ws_lib.WebSocket | None = None
        self._lock = threading.Lock()
        self._connect()

    # ── connection management ────────────────────────────────────

    def _connect(self) -> None:
        url = build_ws_url(self._server_url, self._jwt_token)
        logger.info("WS connecting to %s", url.split("?")[0])
        ws = self._ws_lib.WebSocket()
        ws.connect(url, timeout=30)  # type: ignore[no-untyped-call]
        # Read welcome message
        raw = ws.recv()
        if raw:
            welcome = json.loads(raw)
            logger.info(
                "WS connected: %s", welcome.get("message", "")
            )
        self._ws = ws

    def _ensure_connected(self) -> None:
        """Reconnect if the socket is closed."""
        if self._ws is None or not self._ws.connected:
            logger.info("WS reconnecting...")
            self._connect()

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    # ── low-level request/response ───────────────────────────────

    def _send_request(
        self, action: str, params: dict[str, Any], timeout: int = 60
    ) -> dict[str, Any]:
        """Send a request envelope and wait for the matching response."""
        req_id = str(uuid.uuid4())
        msg = json.dumps({"req_id": req_id, "action": action, "params": params})

        with self._lock:
            self._ensure_connected()
            assert self._ws is not None
            self._ws.settimeout(timeout)
            try:
                self._ws.send(msg)
            except self._ws_lib.WebSocketConnectionClosedException:
                # One reconnect attempt
                self._connect()
                assert self._ws is not None
                self._ws.settimeout(timeout)
                self._ws.send(msg)

            # Read until we get the matching response
            while True:
                try:
                    raw = self._ws.recv()
                except self._ws_lib.WebSocketConnectionClosedException:
                    raise requests.ConnectionError("WebSocket connection closed")
                except self._ws_lib.WebSocketTimeoutException:
                    raise requests.Timeout(
                        f"WS request {action} timed out after {timeout}s"
                    )
                if not raw:
                    raise requests.ConnectionError("WebSocket received empty frame")
                resp: dict[str, Any] = json.loads(raw)
                # Skip heartbeats and other server-initiated messages
                if resp.get("type") in ("heartbeat", "connected"):
                    continue
                if resp.get("req_id") == req_id:
                    return resp

    def _send_request_with_binary(
        self, action: str, params: dict[str, Any], data: bytes, timeout: int = 60
    ) -> dict[str, Any]:
        """Send a text request frame followed by a binary frame."""
        req_id = str(uuid.uuid4())
        msg = json.dumps({"req_id": req_id, "action": action, "params": params})

        with self._lock:
            self._ensure_connected()
            assert self._ws is not None
            self._ws.settimeout(timeout)
            try:
                self._ws.send(msg)
                self._ws.send_binary(data)
            except self._ws_lib.WebSocketConnectionClosedException:
                self._connect()
                assert self._ws is not None
                self._ws.settimeout(timeout)
                self._ws.send(msg)
                self._ws.send_binary(data)

            while True:
                try:
                    raw = self._ws.recv()
                except self._ws_lib.WebSocketConnectionClosedException:
                    raise requests.ConnectionError("WebSocket connection closed")
                except self._ws_lib.WebSocketTimeoutException:
                    raise requests.Timeout(
                        f"WS request {action} timed out after {timeout}s"
                    )
                if not raw:
                    raise requests.ConnectionError("WebSocket received empty frame")
                resp: dict[str, Any] = json.loads(raw)
                if resp.get("type") in ("heartbeat", "connected"):
                    continue
                if resp.get("req_id") == req_id:
                    return resp

    # ── AgentTransport implementation ────────────────────────────

    def get(self, *segments: str, timeout: int = 60) -> WsResponse:
        resp = self._send_request("get", {"path": list(segments)}, timeout=timeout)
        wr = WsResponse(resp)
        # Decode base64 file content if present
        data = resp.get("data")
        if isinstance(data, dict) and data.get("encoding") == "base64":
            raw_bytes = base64.b64decode(data["content"])
            wr._content = raw_bytes
        return wr

    def post(
        self, *segments: str, json_body: dict[str, Any], timeout: int = 60
    ) -> WsResponse:
        resp = self._send_request(
            "post", {"path": list(segments), "body": json_body}, timeout=timeout
        )
        return WsResponse(resp)

    def poll_task(self, timeout: int = 60) -> dict[str, Any]:
        resp = self._send_request("poll_task", {}, timeout=timeout)
        ws_resp = WsResponse(resp)
        ws_resp.raise_for_status()
        data = resp.get("data")
        if data is None:
            return {}
        return dict(data) if isinstance(data, dict) else {}

    def take_task(self, raw_id: str, raw_cap: str, timeout: int = 60) -> dict[str, Any]:
        resp = self._send_request(
            "take_task", {"id": raw_id, "cap": raw_cap}, timeout=timeout
        )
        ws_resp = WsResponse(resp)
        ws_resp.raise_for_status()
        return dict(resp.get("data") or {})

    def post_task_progress(
        self, task_id: TaskId, report: TaskProgressReport, timeout: int = 10
    ) -> WsResponse:
        resp = self._send_request(
            "update_progress", report.to_wire(), timeout=timeout
        )
        return WsResponse(resp)

    def post_task_result(
        self, report: TaskResultReport, timeout: int = 60
    ) -> WsResponse:
        resp = self._send_request(
            "resolve_task", report.to_wire(), timeout=timeout
        )
        return WsResponse(resp)

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        params = {
            "bucket_uid": bucket_uid,
            "filename": filename,
            "content_type": content_type,
            "size": len(content),
        }
        resp = self._send_request_with_binary(
            "upload_file", params, content, timeout=timeout
        )
        ws_resp = WsResponse(resp)
        ws_resp.raise_for_status()
        data = resp.get("data")
        if isinstance(data, dict):
            return str(data["file_uid"])
        raise ValueError(f"Unexpected upload response: {resp}")
