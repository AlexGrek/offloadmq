"""OpenRouter-compatible surface (`/api/v1`): auth, model resolution, envelope.

Run from the project root:  ``python -m pytest offloadmock/tests``
"""

from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient

from offloadmock.config import settings
from offloadmock.main import create_app

client = TestClient(create_app())

BEARER = {"Authorization": f"Bearer {settings.client_api_keys[0]}"}


def _register_llm_agent(model: str, attrs: str = "") -> None:
    resp = client.post(
        "/agent/register",
        json={
            "capabilities": [f"llm.{model}{attrs}"],
            "tier": 1,
            "capacity": 1,
            "systemInfo": {"os": "linux", "client": "pytest", "runtime": "python",
                           "cpuArch": "x86_64", "totalMemoryGb": 16},
            "apiKey": settings.agent_api_keys[0],
        },
    )
    assert resp.status_code == 200, resp.text


def test_missing_and_bad_key_are_401_in_openrouter_envelope():
    r = client.get("/api/v1/models")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == 401
    r = client.get("/api/v1/key", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_models_lists_online_llm_capabilities():
    model = f"mock-{uuid.uuid4().hex[:8]}"
    _register_llm_agent(model, "[vision;tools]")
    data = client.get("/api/v1/models", headers=BEARER).json()["data"]
    entry = next(m for m in data if m["id"] == model)
    assert entry["architecture"]["input_modalities"] == ["text", "image"]
    assert "tools" in entry["supported_parameters"]


def test_chat_completion_resolves_prefixed_model():
    model = f"mock-{uuid.uuid4().hex[:8]}"
    _register_llm_agent(model)
    r = client.post("/api/v1/chat/completions", headers=BEARER, json={
        "model": f"offloadmq/{model}", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["model"] == f"offloadmq/{model}"


def test_chat_completion_stream_ends_with_done():
    model = f"mock-{uuid.uuid4().hex[:8]}"
    _register_llm_agent(model)
    r = client.post("/api/v1/chat/completions", headers=BEARER, json={
        "model": model, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
    lines = [ln[len("data: "):] for ln in r.text.splitlines() if ln.startswith("data: ")]
    assert lines[-1] == "[DONE]"
    assert "usage" in json.loads(lines[-2])


def test_offline_model_is_404():
    r = client.post("/api/v1/chat/completions", headers=BEARER, json={
        "model": "not-online", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 404
    assert "No endpoints found" in r.json()["error"]["message"]
