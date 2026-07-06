"""Async client for the OffloadMQ agent API.

Registration, login, capability/info updates and runtime-log submission stay over
HTTP. The task lifecycle — receiving work, progress, and resolution — runs over a
single persistent **WebSocket** (`/private/agent/ws`): the server *pushes* tasks
instead of the agent polling. HTTP polling has been removed.
"""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aiohttp

from offloadmq_agent.models import (
    AgentAuth,
    AgentRegistration,
    TaskResult,
)

# Zombie-session guard. The server heartbeats every 60–90s and also acks the
# agent's own heartbeats, so on a healthy socket a frame arrives well within this
# window. If nothing arrives for the whole window the peer has gone silent (the
# server forgot us / half-open TCP), so we tear the socket down and let the
# supervisor reconnect instead of waiting forever on a dead connection. Sized to
# tolerate one fully missed 60–90s heartbeat window plus margin.
_WS_RECV_TIMEOUT_SECS = 180.0


class OffloadMQError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class OffloadMQClient:
    """Thin async wrapper around the OffloadMQ agent HTTP API."""

    def __init__(self, server: str, jwt_token: str, timeout: int = 30) -> None:
        self._server = server.rstrip("/")
        self._jwt_token = jwt_token
        self._timeout = aiohttp.ClientTimeout(total=timeout)
        self._client_session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        # Serializes concurrent WS sends (progress/resolve are scheduled from
        # worker threads onto the loop and could otherwise interleave frames).
        self._ws_lock = asyncio.Lock()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._jwt_token}"}

    async def _session(self) -> aiohttp.ClientSession:
        if self._client_session is None or self._client_session.closed:
            # No total timeout: the session also carries the long-lived WebSocket.
            self._client_session = aiohttp.ClientSession()
        return self._client_session

    async def close(self) -> None:
        if self._ws is not None and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._ws = None
        if self._client_session is not None and not self._client_session.closed:
            await self._client_session.close()
        self._client_session = None

    @staticmethod
    async def register(
        server: str,
        api_key: str,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str = "",
        system_info: dict[str, Any] | None = None,
        app_version: str = "2.0.0",
    ) -> AgentRegistration:
        url = f"{server.rstrip('/')}/agent/register"
        payload: dict[str, Any] = {
            "apiKey": api_key,
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "appVersion": app_version,
        }
        from offloadmq_agent.systeminfo import (
            collect_system_info,
            effective_display_name,
        )

        sysinfo = system_info if system_info is not None else collect_system_info()
        payload["systemInfo"] = sysinfo
        payload["displayName"] = effective_display_name(display_name, sysinfo)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(
                        f"Registration failed ({resp.status}): {text}",
                        status=resp.status,
                        body=text,
                    )
                data: dict[str, Any] = await resp.json()
                return AgentRegistration(agent_id=data["agentId"], key=data["key"])

    @staticmethod
    async def authenticate(server: str, agent_id: str, key: str) -> AgentAuth:
        url = f"{server.rstrip('/')}/agent/auth"
        payload = {"agentId": agent_id, "key": key}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(
                        f"Auth failed ({resp.status}): {text}",
                        status=resp.status,
                        body=text,
                    )
                data: dict[str, Any] = await resp.json()
                return AgentAuth(token=data["token"], expires_in=data["expiresIn"])

    # ------------------------------------------------------------------
    # WebSocket — primary task channel (server pushes tasks, agent reports)
    # ------------------------------------------------------------------

    async def open_ws(self) -> None:
        """Open the persistent agent WebSocket. Auth is via the `token` query
        param at upgrade time (same JWT as the HTTP `Authorization` header)."""
        session = await self._session()
        url = f"{self._server}/private/agent/ws"
        # heartbeat=None: the server already sends its own heartbeat frames; we
        # don't want aiohttp injecting client pings on top.
        self._ws = await session.ws_connect(
            url, params={"token": self._jwt_token}, heartbeat=None
        )

    async def ws_messages(self) -> AsyncIterator[dict[str, Any]]:
        """Yield decoded JSON text frames from the server until the socket closes.

        Server frames carry a `type`: `connected`, `heartbeat`, `task` (a pushed
        `AssignedTask`), `cancel`, plus `response`/`error` acks for the agent's
        own RPC sends.

        Each receive is bounded by ``_WS_RECV_TIMEOUT_SECS``. If the server goes
        silent for the whole window — no heartbeat, no ack, nothing — the socket
        is presumed dead (server forgot us / half-open TCP) and we raise so the
        supervisor tears it down and reconnects rather than sitting in a zombie
        session that *thinks* it is connected.
        """
        ws = self._ws
        if ws is None:
            raise OffloadMQError("websocket not connected")
        while True:
            try:
                msg = await ws.receive(timeout=_WS_RECV_TIMEOUT_SECS)
            except asyncio.TimeoutError as exc:
                raise OffloadMQError(
                    f"websocket idle for {_WS_RECV_TIMEOUT_SECS:.0f}s — "
                    "server silent, reconnecting"
                ) from exc
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = msg.json()
                except Exception:  # noqa: BLE001
                    continue
                if isinstance(data, dict):
                    yield data
            elif msg.type in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSING,
                aiohttp.WSMsgType.CLOSED,
            ):
                break
            elif msg.type == aiohttp.WSMsgType.ERROR:
                raise OffloadMQError(f"websocket error: {ws.exception()!r}")

    async def _ws_send(self, action: str, params: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            raise OffloadMQError("websocket not connected", status=0)
        frame = {"req_id": uuid.uuid4().hex, "action": action, "params": params}
        async with self._ws_lock:
            await ws.send_json(frame)

    async def send_heartbeat(self) -> None:
        """Send a liveness heartbeat to the server over the WebSocket.

        Mirrors the server→agent heartbeat frames in the other direction: it
        bumps the agent's ``last_contact`` server-side so the agent stays counted
        as online even when idle *or* busy running a job. Fire-and-forget — the
        server replies with a normal ``response`` ack that the receive loop drops.
        """
        await self._ws_send("heartbeat", {})

    async def report_progress(
        self,
        capability: str,
        task_id: str,
        stage: str,
        log: str,
    ) -> None:
        from offloadmq_agent.wire import (
            TaskId,
            TaskProgressReport,
            progress_wire_status,
        )

        report = TaskProgressReport(
            id=TaskId(id=task_id, cap=capability),
            stage=stage or None,
            log_update=log or None,
            status=progress_wire_status(stage or None, bool(log)),
        )
        await self._ws_send("update_progress", report.to_wire())

    async def update_agent_info(
        self,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str = "",
        system_info: dict[str, Any] | None = None,
        app_version: str = "2.0.0",
    ) -> None:
        url = f"{self._server}/private/agent/info/update"
        body: dict[str, Any] = {
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "appVersion": app_version,
        }
        from offloadmq_agent.systeminfo import (
            collect_system_info,
            effective_display_name,
        )

        sysinfo = system_info if system_info is not None else collect_system_info()
        body["systemInfo"] = sysinfo
        # Always send resolved name: the server overwrites display_name on every update.
        body["displayName"] = effective_display_name(display_name, sysinfo)
        session = await self._session()
        async with session.post(
            url, json=body, headers=self._headers(), timeout=self._timeout
        ) as resp:
            if resp.status not in (200, 204):
                text = await resp.text()
                raise OffloadMQError(
                    f"Update info failed ({resp.status}): {text}",
                    status=resp.status,
                    body=text,
                )

    async def resolve(self, capability: str, result: TaskResult) -> None:
        from offloadmq_agent.result_convert import task_result_to_wire

        payload = task_result_to_wire(result.task_id, capability, result)
        await self._ws_send("resolve_task", payload)

    def update_token(self, jwt_token: str) -> None:
        self._jwt_token = jwt_token

    async def submit_log(
        self,
        severity: str,
        text: str,
        *,
        agent_id: str | None = None,
        agent_name: str | None = None,
        machine_fingerprint: str | None = None,
    ) -> None:
        """POST a single runtime log to the server.

        Severity must be one of CRITICAL, ERROR, INFO. The server stamps the
        timestamp and record id; missing identity fields fall back to the
        authenticated agent record server-side.
        """
        url = f"{self._server}/private/agent/logs"
        body: dict[str, Any] = {"severity": severity, "text": text}
        if agent_id:
            body["agentId"] = agent_id
        if agent_name:
            body["agentName"] = agent_name
        if machine_fingerprint:
            body["machineFingerprint"] = machine_fingerprint
        session = await self._session()
        async with session.post(
            url, json=body, headers=self._headers(), timeout=self._timeout
        ) as resp:
            if resp.status not in (200, 201, 204):
                text_body = await resp.text()
                raise OffloadMQError(
                    f"Submit log failed ({resp.status}): {text_body}",
                    status=resp.status,
                    body=text_body,
                )
