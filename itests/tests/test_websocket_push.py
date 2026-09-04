"""Integration tests for the WebSocket *push* protocol.

These exercise the server's push-based task distribution (the agent no longer
polls): the server selects a connected agent, atomically assigns a task, and
pushes the ``AssignedTask`` over the WebSocket. The tests act as a minimal WS
agent — register over HTTP, open the socket, and receive/resolve pushed tasks —
so they need only a running server (no real offload-agent).

Each test uses a unique capability so tasks never bleed across tests, and the
client API key is a wildcard (``*``) so arbitrary capabilities are accepted.

Covered behaviors:
- non-urgent task is pushed and resolves to ``completed``
- urgent ``submit_blocking`` is pushed and unblocks the client on resolve
- cancellation is pushed to the assigned agent as ``{"type": "cancel"}``
- capacity gate: with ``capacity=1`` only one task is pushed until it resolves
- disconnect re-queues an *un-started* task to another agent
- heartbeat claim: a task the agent stops claiming is reclaimed (failed if it had
  started, re-queued if not) and the freed slot is dispatched to immediately
"""
import json
import threading
import time
import uuid

import requests
import websocket

SERVER_URL = "http://localhost:3069"
WS_BASE = "ws://localhost:3069/private/agent/ws"
AGENT_API_KEY = "ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"
CLIENT_API_KEY = "client_secret_key_123"

# Mirrors AGENT_CLAIM_GRACE_SECS in itests/Makefile (the server default is 120).
# A task must be untouched for this long before a heartbeat claim can reclaim it.
CLAIM_GRACE_SECS = 3


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def unique_cap() -> str:
    """A fresh capability per test, for isolation."""
    return f"debug.push.{uuid.uuid4().hex[:10]}"


def register_and_auth(capabilities: list[str], *, capacity: int = 1, tier: int = 5):
    """Register an agent and return (agent_id, jwt_token)."""
    reg = requests.post(
        f"{SERVER_URL}/agent/register",
        json={
            "apiKey": AGENT_API_KEY,
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "systemInfo": {
                "os": "linux",
                "client": "pytest-ws-push",
                "runtime": "python3",
                "cpuArch": "x86_64",
                "totalMemoryGb": 8,
            },
            "appVersion": "itest",
        },
        timeout=30,
    )
    reg.raise_for_status()
    reg_data = reg.json()
    auth = requests.post(
        f"{SERVER_URL}/agent/auth",
        json={"agentId": reg_data["agentId"], "key": reg_data["key"]},
        timeout=30,
    )
    auth.raise_for_status()
    return reg_data["agentId"], auth.json()["token"]


def connect_ws(jwt_token: str, timeout: float = 10.0) -> websocket.WebSocket:
    return websocket.create_connection(f"{WS_BASE}?token={jwt_token}", timeout=timeout)


def recv_type(ws: websocket.WebSocket, wanted: str, timeout: float = 10.0):
    """Return the first frame whose ``type`` == wanted within ``timeout``, else None.

    Skips unrelated server frames (``connected``, ``heartbeat``, RPC acks).
    """
    deadline = time.time() + timeout
    ws.settimeout(1.0)
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("type") == wanted:
            return msg
    return None


def collect_pushes(ws: websocket.WebSocket, window: float = 1.5) -> list[dict]:
    """Collect all ``task`` push ids seen within ``window`` seconds."""
    pushes: list[dict] = []
    deadline = time.time() + window
    ws.settimeout(0.5)
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        except Exception:
            break
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("type") == "task":
            pushes.append(msg["task"]["id"])
    return pushes


def submit_task(capability: str, *, urgent: bool = False, payload: dict | None = None):
    resp = requests.post(
        f"{SERVER_URL}/api/task/submit",
        json={
            "apiKey": CLIENT_API_KEY,
            "capability": capability,
            "urgent": urgent,
            "payload": payload or {},
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def client_poll(task_id: dict) -> dict:
    resp = requests.post(
        f"{SERVER_URL}/api/task/poll/{task_id['cap']}/{task_id['id']}",
        json={"apiKey": CLIENT_API_KEY},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def client_cancel(task_id: dict) -> requests.Response:
    return requests.post(
        f"{SERVER_URL}/api/task/cancel/{task_id['cap']}/{task_id['id']}",
        json={"apiKey": CLIENT_API_KEY},
        timeout=10,
    )


def ws_progress(ws: websocket.WebSocket, task_id: dict, *, stage: str = "running") -> None:
    ws.send(json.dumps({
        "req_id": uuid.uuid4().hex,
        "action": "update_progress",
        "params": {"id": task_id, "stage": stage, "status": "running"},
    }))


def ws_request(ws: websocket.WebSocket, action: str, params: dict, timeout: float = 10.0):
    """Send an RPC frame and wait for the ack for *this* req_id.

    Returns ``(ack, pushes)``: any ``task`` frames that arrived while waiting are
    handed back rather than dropped — the server pushes freed-up work from
    inside the very call being acked, so those frames arrive first.
    """
    req_id = uuid.uuid4().hex
    ws.send(json.dumps({"req_id": req_id, "action": action, "params": params}))
    pushes: list[dict] = []
    deadline = time.time() + timeout
    ws.settimeout(1.0)
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("type") == "task":
            pushes.append(msg["task"]["id"])
        elif msg.get("req_id") == req_id and msg.get("type") in ("response", "error"):
            return msg, pushes
    raise AssertionError(f"no ack for {action} within {timeout}s")


def ws_resolve(
    ws: websocket.WebSocket, task_id: dict, capability: str, *,
    success: bool = True, output: dict | None = None,
) -> None:
    status = {"success": 0.1} if success else {"failure": ["error", 0.1]}
    ws.send(json.dumps({
        "req_id": uuid.uuid4().hex,
        "action": "resolve_task",
        "params": {
            "id": task_id,
            "capability": capability,
            "status": status,
            "output": output or {},
        },
    }))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_nonurgent_task_is_pushed_and_resolves():
    cap = unique_cap()
    _, token = register_and_auth([cap])
    ws = connect_ws(token)
    try:
        sub = submit_task(cap, payload={"hello": "push"})
        tid = sub["id"]

        push = recv_type(ws, "task", timeout=10)
        assert push is not None, "server should push the queued task over the WS"
        assert push["task"]["id"]["id"] == tid["id"]
        assert push["task"]["status"] == "assigned"

        ws_resolve(ws, tid, cap, output={"ok": True})
        time.sleep(0.3)
        assert client_poll(tid)["status"] == "completed"
    finally:
        ws.close()


def test_urgent_blocking_is_pushed_and_unblocks_client():
    cap = unique_cap()
    _, token = register_and_auth([cap])
    ws = connect_ws(token)
    box: dict = {}

    def submit_blocking():
        r = requests.post(
            f"{SERVER_URL}/api/task/submit_blocking",
            json={"apiKey": CLIENT_API_KEY, "capability": cap,
                  "urgent": True, "payload": {"x": 1}},
            timeout=30,
        )
        box["resp"] = r.json()

    try:
        t = threading.Thread(target=submit_blocking, daemon=True)
        t.start()

        push = recv_type(ws, "task", timeout=10)
        assert push is not None, "urgent task should be pushed to the connected agent"
        tid = push["task"]["id"]

        ws_resolve(ws, tid, cap, output={"done": True})
        t.join(timeout=10)
        assert "resp" in box, "submit_blocking should have returned after resolve"
        assert box["resp"]["status"] == "completed"
    finally:
        ws.close()


def test_cancel_is_pushed_to_assigned_agent():
    cap = unique_cap()
    _, token = register_and_auth([cap])
    ws = connect_ws(token)
    try:
        tid = submit_task(cap)["id"]
        push = recv_type(ws, "task", timeout=10)
        assert push is not None and push["task"]["id"]["id"] == tid["id"]

        # Mark it running so a disconnect/cancel won't re-queue it as un-started.
        ws_progress(ws, tid)
        time.sleep(0.2)

        assert client_cancel(tid).status_code == 200

        cancel_push = recv_type(ws, "cancel", timeout=5)
        assert cancel_push is not None, "cancel should be pushed to the assigned agent"
        assert cancel_push["taskId"]["id"] == tid["id"]

        # Acknowledge so the task terminalizes (Canceled) instead of lingering.
        ws_resolve(ws, tid, cap, success=False)
    finally:
        ws.close()


def test_capacity_gate_pushes_one_until_resolved():
    cap = unique_cap()
    _, token = register_and_auth([cap], capacity=1)
    ws = connect_ws(token)
    try:
        submit_task(cap, payload={"n": 1})
        time.sleep(0.2)
        submit_task(cap, payload={"n": 2})

        first = collect_pushes(ws, window=1.5)
        assert len(first) == 1, f"capacity=1 should push exactly one task, got {len(first)}"

        # Freeing the slot should release the second task.
        ws_resolve(ws, first[0], cap)
        second = collect_pushes(ws, window=2.5)
        assert len(second) == 1, f"second task should be pushed after resolve, got {len(second)}"
        ws_resolve(ws, second[0], cap)
    finally:
        ws.close()


def test_disconnect_requeues_unstarted_task():
    cap = unique_cap()
    _, token1 = register_and_auth([cap], capacity=1)
    ws1 = connect_ws(token1)
    try:
        tid = submit_task(cap)["id"]
        first = collect_pushes(ws1, window=1.5)
        assert any(p["id"] == tid["id"] for p in first), "task should be pushed to first agent"
    finally:
        # Drop the socket WITHOUT starting the task → server re-queues it.
        ws1.close()

    time.sleep(0.7)

    _, token2 = register_and_auth([cap], capacity=1)
    ws2 = connect_ws(token2)
    try:
        repush = collect_pushes(ws2, window=3.0)
        assert any(p["id"] == tid["id"] for p in repush), \
            "un-started task should be re-pushed to another agent after disconnect"
        ws_resolve(ws2, tid, cap)
    finally:
        ws2.close()


def test_claimed_task_is_never_reclaimed():
    """An honest heartbeat must never cost the agent the task it is running."""
    cap = unique_cap()
    _, token = register_and_auth([cap], capacity=1)
    ws = connect_ws(token)
    try:
        tid = submit_task(cap)["id"]
        assert recv_type(ws, "task", timeout=10) is not None
        ws_progress(ws, tid)
        time.sleep(0.3)

        # Well past the grace window, but still claimed on every beat.
        time.sleep(CLAIM_GRACE_SECS + 1)
        ack, _ = ws_request(ws, "heartbeat", {"active": [tid]})
        assert ack["data"]["reclaimed"] == 0
        assert client_poll(tid)["status"] == "running"

        # A beat with no claim at all (legacy agents) leaves the task alone too.
        ack, _ = ws_request(ws, "heartbeat", {})
        assert ack["data"]["reclaimed"] == 0
        assert client_poll(tid)["status"] == "running"

        ws_resolve(ws, tid, cap)
        time.sleep(0.3)
        assert client_poll(tid)["status"] == "completed"
    finally:
        ws.close()


def test_forgotten_task_is_reclaimed_and_frees_the_slot():
    """A lost resolve must not pin the agent at capacity forever.

    The agent starts a task and then stops reporting it — what a socket dying
    mid-upload looks like from the server: the work is over, but the result
    never arrived. The first heartbeat that omits the task is the agent saying
    "I am not running that", so the server fails it, frees the slot and hands
    over the work queued behind it.
    """
    cap = unique_cap()
    _, token = register_and_auth([cap], capacity=1)
    ws = connect_ws(token)
    try:
        first = submit_task(cap)["id"]
        second = submit_task(cap)["id"]

        push = recv_type(ws, "task", timeout=10)
        assert push is not None and push["task"]["id"]["id"] == first["id"]
        ws_progress(ws, first)
        time.sleep(0.3)
        # Nothing else moves while the server believes the agent is busy.
        assert collect_pushes(ws, window=1.0) == []
        assert client_poll(first)["status"] == "running"

        time.sleep(CLAIM_GRACE_SECS + 1)
        ack, pushes = ws_request(ws, "heartbeat", {"active": []})
        assert ack["data"]["reclaimed"] == 1

        first_status = client_poll(first)
        assert first_status["status"] == "failed"
        assert "no longer reports it" in (first_status.get("log") or "")

        pushes += collect_pushes(ws, window=2.0)
        assert [p["id"] for p in pushes] == [second["id"]], \
            "the freed slot should immediately receive the queued task"
    finally:
        ws.close()


def test_forgotten_unstarted_task_goes_back_to_the_queue():
    """Reclaiming work the agent never began must not throw it away."""
    cap = unique_cap()
    _, token = register_and_auth([cap], capacity=1)
    ws = connect_ws(token)
    try:
        tid = submit_task(cap)["id"]
        push = recv_type(ws, "task", timeout=10)
        assert push is not None

        # No progress was ever sent, so the task is still `assigned`.
        time.sleep(CLAIM_GRACE_SECS + 1)
        ack, pushes = ws_request(ws, "heartbeat", {"active": []})
        assert ack["data"]["reclaimed"] == 1

        pushes += collect_pushes(ws, window=2.0)
        assert [p["id"] for p in pushes] == [tid["id"]], "task was not re-dispatched"
        assert client_poll(tid)["status"] != "failed"
    finally:
        ws.close()
