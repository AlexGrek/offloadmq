"""Agent WebSocket endpoint `/private/agent/ws` (mirror the WS half of
`src/api/agent/mod.rs`).

Auth via the ``token`` query param. Implements the request/response envelope,
the welcome + heartbeat frames, and action dispatch. With no task subsystem,
poll actions return ``null`` and task mutations return not-found errors.
"""

from __future__ import annotations

import asyncio
import json
import random

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import deps
from ..errors import AppError
from ..schemas import CommunicationMethod, TaskId
from ..utils import iso_z, now_utc

router = APIRouter()

# Server→agent heartbeat cadence — a fresh random delay in [min, max] seconds is
# rolled before every beat, mirroring the real server (env AGENT_WS_HEARTBEAT_*).
_HEARTBEAT_MIN_SECS = 60.0
_HEARTBEAT_MAX_SECS = 90.0


def _ws_ok(req_id: str, status: int, data) -> str:
    return json.dumps(
        {"req_id": req_id, "type": "response", "status": status, "data": data},
        separators=(",", ":"),
    )


def _ws_err(req_id: str, err: AppError) -> str:
    return json.dumps(
        {
            "req_id": req_id,
            "type": "error",
            "status": err.status,
            "error": {"type": err.error_type, "message": err.message},
        },
        separators=(",", ":"),
    )


async def _dispatch(action: str, params: dict, agent) -> tuple[int, object]:
    if action in ("heartbeat", "ping"):
        # Agent→server liveness beat — bump last_contact and ack.
        deps.store.touch_agent(agent, CommunicationMethod.WEBSOCKET)
        return 200, {"status": "ok"}
    if action in ("poll_task", "poll_task_urgent"):
        deps.store.touch_agent(agent, CommunicationMethod.WEBSOCKET)
        return 200, None
    if action == "take_task":
        cap = params.get("cap")
        tid = params.get("id")
        if cap is None or tid is None:
            raise AppError.bad_request("missing params.cap/id")
        raise AppError.not_found(str(TaskId(cap=cap, id=tid)))
    if action == "resolve_task":
        raise AppError.not_found(str(TaskId(cap=params.get("id", {}).get("cap", ""),
                                            id=params.get("id", {}).get("id", ""))))
    if action == "update_progress":
        raise AppError.not_found(str(TaskId(cap=params.get("id", {}).get("cap", ""),
                                            id=params.get("id", {}).get("id", ""))))
    raise AppError.bad_request(f"unknown action: {action}")


@router.websocket("/private/agent/ws")
async def websocket_handler(ws: WebSocket) -> None:
    token = ws.query_params.get("token")
    if not token:
        await ws.close(code=1008)
        return
    try:
        claims = deps.auth.decode_token(token)
    except AppError:
        await ws.close(code=1008)
        return
    agent = deps.store.get_agent(claims.get("sub", ""))
    if agent is None:
        await ws.close(code=1008)
        return

    await ws.accept()
    deps.store.touch_agent(agent, CommunicationMethod.WEBSOCKET)

    await ws.send_text(
        json.dumps(
            {
                "type": "connected",
                "agent_id": agent.uid_short,
                "message": "WebSocket connection established",
            },
            separators=(",", ":"),
        )
    )

    async def heartbeat() -> None:
        counter = 0
        try:
            while True:
                await asyncio.sleep(random.uniform(_HEARTBEAT_MIN_SECS, _HEARTBEAT_MAX_SECS))
                counter += 1
                await ws.send_text(
                    json.dumps(
                        {"type": "heartbeat", "counter": counter, "timestamp": iso_z(now_utc())},
                        separators=(",", ":"),
                    )
                )
        except (WebSocketDisconnect, RuntimeError):
            pass

    hb = asyncio.create_task(heartbeat())
    try:
        while True:
            text = await ws.receive_text()
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            req_id = parsed.get("req_id", "") or ""
            action = parsed.get("action", "") or ""
            params = parsed.get("params", {}) or {}
            if not action:
                continue
            try:
                status, data = await _dispatch(action, params, agent)
                await ws.send_text(_ws_ok(req_id, status, data))
            except AppError as e:
                await ws.send_text(_ws_err(req_id, e))
    except WebSocketDisconnect:
        pass
    finally:
        hb.cancel()
