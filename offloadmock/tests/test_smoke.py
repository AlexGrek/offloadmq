"""Smoke tests asserting the mock's schema fidelity and error envelope.

Run from the project root:  ``python -m pytest offloadmock/tests``
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from offloadmock.config import settings
from offloadmock.main import create_app

client = TestClient(create_app())

CLIENT_KEY = settings.client_api_keys[0]
AGENT_KEY = settings.agent_api_keys[0]
MGMT = settings.management_token


def _system_info() -> dict:
    return {
        "os": "linux",
        "client": "pytest",
        "runtime": "python",
        "cpuArch": "x86_64",
        "cpuModel": "Test CPU",
        "totalMemoryGb": 16,
    }


def _register_agent(caps: list[str]) -> tuple[str, str]:
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
    assert set(body) == {"agentId", "key", "message"}
    assert body["message"] == "Registered"
    return body["agentId"], body["key"]


def test_health_shape():
    body = client.get("/health").json()
    assert body["status"] == "healthy"
    assert "agents" in body and "timestamp" in body
    assert body["timestamp"].endswith("Z")  # chrono-style datetime


def test_register_and_auth_and_agent_shape():
    agent_id, key = _register_agent(["llm.qwen3:8b[vision]"])

    auth = client.post("/agent/auth", json={"agentId": agent_id, "key": key})
    assert auth.status_code == 200, auth.text
    tok = auth.json()
    assert set(tok) == {"token", "expiresIn"}

    # Agent JSON carries camelCase keys from models::Agent.
    agents = client.get("/management/agents/list", headers={"Authorization": f"Bearer {MGMT}"}).json()
    me = next(a for a in agents if a["uid"] == agent_id)
    for field in ("uidShort", "personalLoginToken", "registeredAt", "lastContact",
                  "lastCommMethod", "systemInfo", "appVersion", "displayName"):
        assert field in me, field
    assert me["lastCommMethod"] == "http"
    assert me["systemInfo"]["cpuArch"] == "x86_64"


def test_jwt_protected_ping():
    agent_id, key = _register_agent(["shell.bash"])
    tok = client.post("/agent/auth", json={"agentId": agent_id, "key": key}).json()["token"]
    ok = client.get("/private/agent/ping", headers={"Authorization": f"Bearer {tok}"})
    assert ok.status_code == 200 and ok.json() == {"status": "ok"}
    # No token -> authorization error envelope.
    bad = client.get("/private/agent/ping")
    assert bad.status_code == 403
    assert bad.json()["error"]["type"] == "authorization_error"


def test_capabilities_online_reflects_agents():
    _register_agent(["llm.mistral[7b;quantized]"])
    caps = client.post("/api/capabilities/online", json={"apiKey": CLIENT_KEY}).json()
    assert "llm.mistral" in caps  # brackets stripped
    ext = client.post("/api/capabilities/list/online_ext", json={"apiKey": CLIENT_KEY}).json()
    assert any(c.startswith("llm.mistral[") for c in ext)


def test_submit_non_urgent_queued_shape():
    resp = client.post(
        "/api/task/submit",
        json={"capability": "shell.bash", "payload": {"cmd": "echo hi"}, "apiKey": CLIENT_KEY},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "queued"
    assert body["capability"] == "shell.bash"
    assert set(body["id"]) == {"cap", "id"}


def test_poll_missing_task_is_404():
    resp = client.post(
        "/api/task/poll/shell.bash/01ABC", json={"apiKey": CLIENT_KEY}
    )
    assert resp.status_code == 404
    err = resp.json()["error"]
    assert err["type"] == "not_found"
    assert err["status"] == 404
    assert err["message"].startswith("Not found:")


def test_bad_client_key_rejected():
    resp = client.post("/api/capabilities/online", json={"apiKey": "nope"})
    assert resp.status_code == 403


def test_storage_bucket_roundtrip():
    headers = {"X-API-Key": CLIENT_KEY}
    created = client.post("/api/storage/bucket/create", headers=headers)
    assert created.status_code == 201, created.text
    uid = created.json()["bucket_uid"]

    up = client.post(
        f"/api/storage/bucket/{uid}/upload",
        headers=headers,
        files={"file": ("hello.txt", b"hello world", "text/plain")},
    )
    assert up.status_code == 201, up.text
    assert up.json()["size"] == 11
    assert up.json()["sha256"]

    stat = client.get(f"/api/storage/bucket/{uid}/stat", headers=headers).json()
    assert stat["file_count"] == 1
    assert stat["files"][0]["original_name"] == "hello.txt"

    limits = client.get("/api/storage/limits", headers=headers).json()
    assert limits["max_buckets_per_key"] == 256


def test_mgmt_requires_token():
    assert client.get("/management/agents/list").status_code == 403
    ok = client.get("/management/tasks/list", headers={"Authorization": f"Bearer {MGMT}"})
    assert ok.json() == {
        "urgent": {"assigned": [], "unassigned": []},
        "regular": {"assigned": [], "unassigned": []},
    }
