"""Client WebSocket endpoint `/api/task/watch` (mirror `src/api/client/watch.rs`).

Auth mirrors `deps.client_auth`'s header rules, applied by hand here since a
WebSocket upgrade carries no body for that dependency's JSON fallback to read
(the real server has the same restriction — see `docs/tasks-api.md`'s "Watch
Tasks" section).

OffloadMock has no task subsystem: `client.py`'s `poll_task_status` and
`cancel_task` always 404 by design. This endpoint keeps that honesty — every
tracked task is reported `missing` — while still speaking the exact
track/untrack/sync/ping/hello/ack/update wire protocol the real server does,
so a client written against the real server (e.g. OAI's `TaskWatch`) runs
unmodified against the mock.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import deps
from ..config import settings
from ..schemas import TaskId

router = APIRouter()

PROTOCOL_VERSION = 1
TICK_SECS = 1.0
FULL_SYNC_SECS = 30.0
MAX_TRACKED = 1000


def _send(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"))


async def _authenticate(websocket: WebSocket) -> tuple[bool, bool]:
    """Returns `(ok, skip_owner)`. Mirrors `deps.client_auth` minus the
    JSON-body fallback branch."""
    mgmt = websocket.headers.get("x-mgmt-api-key")
    if mgmt is not None:
        return (mgmt == settings.management_token, True)
    api_key = websocket.headers.get("x-api-key")
    if api_key is not None:
        return (deps.store.is_key_real_not_revoked(api_key), False)
    return (False, False)


@router.websocket("/task/watch")
async def task_watch(websocket: WebSocket) -> None:
    ok, skip_owner = await _authenticate(websocket)
    if not ok:
        # Unaccepted + close() denies the handshake with a 403, matching the
        # real server's pre-upgrade middleware rejection.
        await websocket.close(code=1008)
        return

    await websocket.accept()
    await websocket.send_text(
        _send(
            {
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "tickMs": int(TICK_SECS * 1000),
                "fullSyncSecs": int(FULL_SYNC_SECS),
                "maxTracked": MAX_TRACKED,
            }
        )
    )

    tracked: dict[str, TaskId] = {}  # key: "cap|id"
    already_missing: set[str] = set()
    dirty = False
    seq = 0

    def _key(t: TaskId) -> str:
        return f"{t.cap}|{t.id}"

    async def ticker() -> None:
        nonlocal dirty, seq
        try:
            while True:
                await asyncio.sleep(TICK_SECS)
                if not tracked:
                    continue
                force_full = dirty
                dirty = False
                entries = []
                for key, task_id in tracked.items():
                    if force_full or key not in already_missing:
                        entries.append({"id": task_id.model_dump(by_alias=True), "missing": True})
                        already_missing.add(key)
                if not entries:
                    continue
                seq += 1
                await websocket.send_text(
                    _send({"type": "update", "seq": seq, "full": force_full, "tasks": entries})
                )
        except (WebSocketDisconnect, RuntimeError):
            pass

    tick_task = asyncio.create_task(ticker())
    try:
        while True:
            text = await websocket.receive_text()
            try:
                frame = json.loads(text)
            except json.JSONDecodeError as e:
                await websocket.send_text(
                    _send({"type": "error", "reqId": None, "message": f"invalid frame: {e}", "code": "bad_request"})
                )
                continue

            ftype = frame.get("type")
            if ftype == "ping":
                await websocket.send_text(_send({"type": "pong"}))
                continue

            req_id = frame.get("reqId")
            if ftype == "sync":
                dirty = True
                await websocket.send_text(_send({"type": "ack", "reqId": req_id, "tracked": len(tracked)}))
                continue
            if ftype == "track":
                for raw in frame.get("tasks", []):
                    task_id = TaskId(**raw)
                    key = _key(task_id)
                    if key not in tracked:
                        if len(tracked) >= MAX_TRACKED:
                            await websocket.send_text(
                                _send(
                                    {
                                        "type": "error",
                                        "reqId": req_id,
                                        "message": f"tracked-set limit of {MAX_TRACKED} reached",
                                        "code": "limit_exceeded",
                                    }
                                )
                            )
                            break
                        tracked[key] = task_id
                else:
                    dirty = True
                    await websocket.send_text(_send({"type": "ack", "reqId": req_id, "tracked": len(tracked)}))
                continue
            if ftype == "untrack":
                for raw in frame.get("tasks", []):
                    task_id = TaskId(**raw)
                    key = _key(task_id)
                    tracked.pop(key, None)
                    already_missing.discard(key)
                dirty = True
                await websocket.send_text(_send({"type": "ack", "reqId": req_id, "tracked": len(tracked)}))
                continue

            await websocket.send_text(
                _send({"type": "error", "reqId": req_id, "message": f"unknown frame type: {ftype}", "code": "bad_request"})
            )
    except WebSocketDisconnect:
        pass
    finally:
        tick_task.cancel()
