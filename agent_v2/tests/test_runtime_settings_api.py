"""Runtime opt-in must survive the UI API and preserve per-model approvals."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from offloadmq_core.orchestrator import Orchestrator
from ui_server.routes.core import build_router


def client_for(orch: Orchestrator) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(orch), prefix="/api")
    return TestClient(app)


def test_ui_runtime_opt_in_requires_separate_model_approval(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    orch = Orchestrator(settings_path=path)
    detected = ["debug.echo", "llm-runtime.qwen3:8b", "llm-runtime.gemma3:12b"]
    with client_for(orch) as client:
        initial = client.get("/api/settings").json()
        assert initial["llm_runtime_enabled"] is False
        assert initial["llm_runtime_cache_limit"] == 8

        enabled = client.post("/api/settings", json={"llm_runtime_enabled": True})
        assert enabled.status_code == 200
        assert enabled.json()["llm_runtime_enabled"] is True
        assert enabled.json()["sensitive_allowed_caps"] == []
        assert not any(c.startswith("llm-runtime.") for c in orch._registration_caps(orch.get_settings(), detected))

        approved = client.post("/api/capabilities/policy", json={
            "regular_disabled": [],
            "sensitive_allowed": ["llm-runtime.qwen3:8b"],
            "slavemode_allowed": [],
        })
        assert approved.status_code == 200
        caps = orch._registration_caps(orch.get_settings(), detected)
        assert "llm-runtime.qwen3:8b" in caps
        assert "llm-runtime.gemma3:12b" not in caps

        resized = client.post("/api/settings", json={"llm_runtime_cache_limit": 3})
        assert resized.status_code == 200
        assert resized.json()["llm_runtime_enabled"] is True
        assert resized.json()["sensitive_allowed_caps"] == ["llm-runtime.qwen3:8b"]
        assert json.loads(path.read_text())["llm_runtime_cache_limit"] == 3

        disabled = client.post("/api/settings", json={"llm_runtime_enabled": False})
        assert disabled.status_code == 200
        assert disabled.json()["sensitive_allowed_caps"] == ["llm-runtime.qwen3:8b"]
        assert not any(c.startswith("llm-runtime.") for c in orch._registration_caps(orch.get_settings(), detected))
        reloaded = Orchestrator(settings_path=path).get_settings()
        assert reloaded.llm_runtime_enabled is False
        assert reloaded.llm_runtime_cache_limit == 3
        assert reloaded.sensitive_allowed_caps == ["llm-runtime.qwen3:8b"]


def test_ui_runtime_toggle_updates_online_registration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    orch = Orchestrator(settings_path=tmp_path / "settings.json")
    pushes: list[bool] = []
    orch._online = True
    monkeypatch.setattr(orch, "push_capabilities_to_server", lambda: pushes.append(orch.get_settings().llm_runtime_enabled))
    with client_for(orch) as client:
        assert client.post("/api/settings", json={"llm_runtime_enabled": True}).status_code == 200
        assert client.post("/api/settings", json={"llm_runtime_enabled": False}).status_code == 200
    assert pushes == [True, False]


@pytest.mark.parametrize("value", [0, -1, 1.5, "invalid"])
def test_ui_rejects_invalid_cache_limit(tmp_path: Path, value: object) -> None:
    orch = Orchestrator(settings_path=tmp_path / "settings.json")
    with client_for(orch) as client:
        response = client.post("/api/settings", json={"llm_runtime_cache_limit": value})
        assert response.status_code == 422
        assert orch.get_settings().llm_runtime_cache_limit == 8
        assert orch.get_settings().llm_runtime_enabled is False
