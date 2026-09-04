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

# How long to wait for the server's ack of a `resolve_task` frame. A resolve is
# the only send whose loss the agent cannot shrug off — the server keeps the
# task (and the agent's capacity slot) occupied until it lands — so it is sent
# as a request/response pair and retried until acknowledged. Generous: the
# server does DB writes and bucket cleanup before replying.
_RESOLVE_ACK_TIMEOUT_SECS = 60.0


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
        # req_id -> waiter, for sends that need the server's ack (see _ws_send).
        self._acks: dict[str, asyncio.Future[dict[str, Any]]] = {}

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._jwt_token}"}

    async def _session(self) -> aiohttp.ClientSession:
        if self._client_session is None or self._client_session.closed:
            # No total timeout: the session also carries the long-lived WebSocket.
            self._client_session = aiohttp.ClientSession()
        return self._client_session

    async def close(self) -> None:
        self.fail_pending_acks("connection closed")
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

    async def _ws_send(
        self,
        action: str,
        params: dict[str, Any],
        *,
        ack_timeout: float | None = None,
    ) -> dict[str, Any] | None:
        """Send one WS request frame.

        Fire-and-forget by default. With ``ack_timeout`` the call instead waits
        for the server's `response`/`error` envelope for this ``req_id`` (routed
        back by :meth:`handle_ack` from the receive loop) and raises if the ack
        never arrives — the caller then knows the frame was lost rather than
        assuming a queued send means the server acted on it.

        Errors carry the server's HTTP-ish status, so callers can tell "the
        server rejected this" (status set — do not retry, it was processed) from
        "this never got there" (``status == 0`` — safe to retry).
        """
        ws = self._ws
        if ws is None or ws.closed:
            raise OffloadMQError("websocket not connected", status=0)
        req_id = uuid.uuid4().hex
        frame = {"req_id": req_id, "action": action, "params": params}
        fut: asyncio.Future[dict[str, Any]] | None = None
        if ack_timeout is not None:
            fut = asyncio.get_running_loop().create_future()
            self._acks[req_id] = fut
        try:
            async with self._ws_lock:
                await ws.send_json(frame)
            if fut is None:
                return None
            return await asyncio.wait_for(fut, ack_timeout)
        except asyncio.TimeoutError as exc:
            raise OffloadMQError(
                f"no server ack for '{action}' within {ack_timeout:.0f}s",
                status=0,
            ) from exc
        finally:
            self._acks.pop(req_id, None)

    def handle_ack(self, msg: dict[str, Any]) -> bool:
        """Route a `response`/`error` frame to whoever is waiting on its req_id.

        Called by the receive loop for every ack frame. Returns True if the
        frame was consumed by a waiter, so the caller can keep its own handling
        (logging server errors) for unsolicited ones.
        """
        req_id = msg.get("req_id")
        if not isinstance(req_id, str):
            return False
        fut = self._acks.pop(req_id, None)
        if fut is None or fut.done():
            return False
        if msg.get("type") == "error":
            err = msg.get("error") or {}
            message = err.get("message") if isinstance(err, dict) else None
            status = msg.get("status")
            fut.set_exception(
                OffloadMQError(
                    str(message or err or "server error"),
                    # Any status at all means the server *processed* the frame.
                    status=int(status) if isinstance(status, int) else 500,
                )
            )
        else:
            fut.set_result(msg)
        return True

    def fail_pending_acks(self, reason: str) -> None:
        """Wake every ack waiter with a transport error (status 0 → retryable).

        Without this a resolve waiting on a socket that just died would hang
        until its timeout, delaying the retry that frees the agent's slot.
        """
        pending, self._acks = self._acks, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(OffloadMQError(reason, status=0))

    async def send_heartbeat(
        self, active: list[dict[str, str]] | None = None
    ) -> None:
        """Send a liveness heartbeat to the server over the WebSocket.

        Mirrors the server→agent heartbeat frames in the other direction: it
        bumps the agent's ``last_contact`` server-side so the agent stays counted
        as online even when idle *or* busy running a job. Fire-and-forget — the
        server replies with a normal ``response`` ack that the receive loop drops.

        ``active`` is the agent's claim: every task it is really working on (or
        still owes a resolve for), as ``{"cap": ..., "id": ...}``. The server
        reclaims anything it still counts against this agent that the claim
        omits, which is what stops a lost resolve from pinning the agent at
        capacity forever. Omitting the argument sends no claim at all and leaves
        the server's view untouched.
        """
        params: dict[str, Any] = {}
        if active is not None:
            params["active"] = active
        await self._ws_send("heartbeat", params)

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
        """Report a task's final result, waiting for the server to acknowledge it.

        Raises :class:`OffloadMQError` with ``status == 0`` if the ack never
        arrived (socket died, server silent) — the result is still unreported
        and the caller must retry it.
        """
        from offloadmq_agent.result_convert import task_result_to_wire

        payload = task_result_to_wire(result.task_id, capability, result)
        await self._ws_send(
            "resolve_task", payload, ack_timeout=_RESOLVE_ACK_TIMEOUT_SECS
        )

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
