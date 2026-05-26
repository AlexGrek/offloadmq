"""Tests for the ``/testing/*`` surface and the resulting task lifecycle.

The mock has no executor, so each test plays both sides: it injects a task via
``/testing/*`` and then drives it through poll → take → progress → resolve with
a freshly-registered agent, asserting the state visible to ``/management/*``
and ``/testing/*`` at each step.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from offloadmock.config import settings
from offloadmock.main import create_app

# A fresh app per test would also work; one client keeps things lean and the
# /testing/tasks/reset endpoint clears the queue between tests.
client = TestClient(create_app())

CLIENT_KEY = settings.client_api_keys[0]
AGENT_KEY = settings.agent_api_keys[0]
MGMT = settings.management_token

MGMT_HEADERS = {"Authorization": f"Bearer {MGMT}"}


def _system_info() -> dict:
    return {
        "os": "linux",
        "client": "pytest",
        "runtime": "python",
        "cpuArch": "x86_64",
        "totalMemoryGb": 8,
    }


def _register(caps: list[str]) -> tuple[str, str]:
    resp = client.post(
        "/agent/register",
        json={
            "capabilities": caps,
            "tier": 1,
            "capacity": 2,
            "systemInfo": _system_info(),
            "apiKey": AGENT_KEY,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return body["agentId"], body["key"]


def _auth(agent_id: str, key: str) -> dict:
    body = client.post("/agent/auth", json={"agentId": agent_id, "key": key}).json()
    return {"Authorization": f"Bearer {body['token']}"}


def _reset() -> None:
    client.post("/testing/tasks/reset", headers=MGMT_HEADERS)
    client.post("/management/agents/reset", headers=MGMT_HEADERS)


def test_generate_for_capability_requires_mgmt_token():
    assert client.post(
        "/testing/tasks/generate_for_capability",
        json={"capability": "debug.echo"},
    ).status_code == 403


def test_generate_then_full_lifecycle_for_debug():
    _reset()
    agent_id, key = _register(["debug.echo"])
    headers = _auth(agent_id, key)

    gen = client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={"capability": "debug.echo", "count": 3},
    )
    assert gen.status_code == 200, gen.text
    body = gen.json()
    assert body["count"] == 3
    assert body["hasOnlineAgent"] is True
    assert all(t["capability"] == "debug.echo" for t in body["tasks"])

    polled = []
    for _ in range(3):
        resp = client.get("/private/agent/task/poll", headers=headers)
        assert resp.status_code == 200
        task = resp.json()
        assert task is not None, "poll returned null too early"
        assert task["id"]["cap"] == "debug.echo"
        assert task["data"]["capability"] == "debug.echo"
        assert "payload" in task["data"]
        polled.append(task)

        cap = task["id"]["cap"]
        tid = task["id"]["id"]
        took = client.post(f"/private/agent/take/{cap}/{tid}", headers=headers)
        assert took.status_code == 200
        assigned = took.json()
        assert assigned["agentId"] == agent_id
        assert assigned["status"] == "assigned"

        prog = client.post(
            f"/private/agent/task/progress/{cap}/{tid}",
            headers=headers,
            json={
                "id": {"cap": cap, "id": tid},
                "stage": "running",
                "logUpdate": "echo started\n",
                "status": "running",
            },
        )
        assert prog.status_code == 200
        assert prog.json() == {"message": "task update confirmed"}

        resolve = client.post(
            f"/private/agent/task/resolve/{cap}/{tid}",
            headers=headers,
            json={
                "id": {"cap": cap, "id": tid},
                "capability": cap,
                "status": {"success": 0.05},
                "output": {"echo": task["data"]["payload"]},
            },
        )
        assert resolve.status_code == 200
        assert resolve.json() == {"message": "task report confirmed"}

    # Queue is drained — poll returns null again.
    empty = client.get("/private/agent/task/poll", headers=headers).json()
    assert empty is None

    # Inspection sees all three resolved with their output.
    listed = client.get("/testing/tasks/list", headers=MGMT_HEADERS).json()
    assert listed["count"] == 3
    statuses = [t["status"] for t in listed["tasks"]]
    assert statuses == ["completed"] * 3
    assert all("echo" in t["result"] for t in listed["tasks"])


def test_generated_payload_is_realistic_per_capability():
    _reset()
    cases = {
        "shell.bash": "command",
        "llm.qwen3:8b": "prompt",
        "imggen.sdxl": "prompt",
        "tts.kokoro": "text",
    }
    for cap, required_key in cases.items():
        gen = client.post(
            "/testing/tasks/generate_for_capability",
            headers=MGMT_HEADERS,
            json={"capability": cap, "count": 1},
        )
        assert gen.status_code == 200, gen.text
        payload = gen.json()["tasks"][0]["payload"]
        assert required_key in payload, (cap, payload)


def test_override_payload_is_used_verbatim():
    _reset()
    gen = client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={
            "capability": "shell.bash",
            "count": 1,
            "payload": {"command": "exit 0", "marker": "explicit"},
        },
    )
    assert gen.json()["tasks"][0]["payload"] == {"command": "exit 0", "marker": "explicit"}


def test_urgent_routes_to_poll_urgent_only():
    _reset()
    agent_id, key = _register(["debug.echo"])
    headers = _auth(agent_id, key)

    client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={"capability": "debug.echo", "count": 1, "urgent": True},
    )

    # poll_urgent finds it.
    resp = client.get("/private/agent/task/poll_urgent", headers=headers).json()
    assert resp is not None
    assert resp["id"]["cap"] == "debug.echo"


def test_targeted_task_only_for_designated_agent():
    _reset()
    a1, k1 = _register(["debug.echo"])
    a2, k2 = _register(["debug.echo"])
    h1 = _auth(a1, k1)
    h2 = _auth(a2, k2)

    client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={"capability": "debug.echo", "count": 1, "targetAgentId": a1},
    )

    # The non-designated agent must not see it.
    assert client.get("/private/agent/task/poll", headers=h2).json() is None
    # The designated agent does.
    task = client.get("/private/agent/task/poll", headers=h1).json()
    assert task is not None
    assert task["id"]["cap"] == "debug.echo"


def test_issue_slavemode_command_accepts_bare_and_qualified():
    _reset()
    agent_id, _ = _register(["slavemode.force-rescan"])

    bare = client.post(
        "/testing/tasks/issue_slavemode_command",
        headers=MGMT_HEADERS,
        json={"command": "force-rescan", "targetAgentId": agent_id},
    )
    assert bare.status_code == 200, bare.text
    assert bare.json()["capability"] == "slavemode.force-rescan"
    assert bare.json()["task"]["payload"] == {}

    full = client.post(
        "/testing/tasks/issue_slavemode_command",
        headers=MGMT_HEADERS,
        json={
            "command": "slavemode.ollama-pull",
            "payload": {"model": "phi3"},
        },
    )
    assert full.status_code == 200
    assert full.json()["task"]["payload"] == {"model": "phi3"}


def test_issue_slavemode_rejects_non_slavemode_command():
    bad = client.post(
        "/testing/tasks/issue_slavemode_command",
        headers=MGMT_HEADERS,
        json={"command": "debug.echo"},
    )
    # ``debug.echo`` does not become a slavemode cap after normalization, so it
    # is rejected as bad input.
    assert bad.status_code == 400


def test_issue_slavemode_unknown_target_agent_404s():
    bad = client.post(
        "/testing/tasks/issue_slavemode_command",
        headers=MGMT_HEADERS,
        json={"command": "force-rescan", "targetAgentId": "nope"},
    )
    assert bad.status_code == 404


def test_management_tasks_list_reflects_injected_tasks():
    _reset()
    client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={"capability": "debug.echo", "count": 2},
    )
    body = client.get("/management/tasks/list", headers=MGMT_HEADERS).json()
    assert len(body["regular"]["unassigned"]) == 2
    assert body["urgent"] == {"assigned": [], "unassigned": []}


def test_management_cancel_marks_cancel_requested_then_canceled():
    _reset()
    agent_id, key = _register(["debug.echo"])
    headers = _auth(agent_id, key)

    gen = client.post(
        "/testing/tasks/generate_for_capability",
        headers=MGMT_HEADERS,
        json={"capability": "debug.echo", "count": 1},
    )
    tid = gen.json()["tasks"][0]["id"]
    cap, ident = tid["cap"], tid["id"]

    # Agent takes it, then management requests cancel.
    client.post(f"/private/agent/take/{cap}/{ident}", headers=headers)
    cancelled = client.post(
        f"/management/tasks/cancel/{cap}/{ident}", headers=MGMT_HEADERS
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelRequested"

    # Agent resolves (as failure, e.g. "cancelled") → terminal Canceled.
    resolve = client.post(
        f"/private/agent/task/resolve/{cap}/{ident}",
        headers=headers,
        json={
            "id": {"cap": cap, "id": ident},
            "capability": cap,
            "status": {"failure": ["cancelled by user", 0.01]},
            "output": None,
        },
    )
    assert resolve.status_code == 200

    inspect = client.get(
        f"/testing/tasks/{cap}/{ident}", headers=MGMT_HEADERS
    ).json()
    assert inspect["status"] == "canceled"


def test_templates_endpoint_lists_known_caps_and_slavemode():
    body = client.get("/testing/templates", headers=MGMT_HEADERS).json()
    assert "debug.echo" in body["capabilities"]
    assert "slavemode.force-rescan" in body["slavemodeCommands"]
