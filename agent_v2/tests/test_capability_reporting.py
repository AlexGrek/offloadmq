"""Every GUI change that can alter the advertised capabilities is reported to the server."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from offloadmq_core import comfy_service, custom_caps_service
from offloadmq_core.orchestrator import Orchestrator
from ui_server.routes.comfy import build_router as comfy_router
from ui_server.routes.core import build_router as core_router
from ui_server.routes.custom_caps import build_router as custom_router


def _client(orch: Orchestrator) -> TestClient:
    app = FastAPI()
    for build in (core_router, custom_router, comfy_router):
        app.include_router(build(orch), prefix="/api")
    return TestClient(app)


def _wait(predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


@pytest.fixture
def orch(tmp_path: Path) -> Orchestrator:
    o = Orchestrator(settings_path=tmp_path / "settings.json")
    o._online = True
    return o


def test_refresh_requested_mid_scan_is_not_dropped(orch: Orchestrator, monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()
    runs: list[int] = []

    def slow_rescan(*, restart_if_changed: bool = False) -> dict[str, Any]:
        runs.append(len(runs))
        if len(runs) == 1:
            release.wait(5)
        return {}

    monkeypatch.setattr(orch, "rescan", slow_rescan)
    orch.request_capability_refresh()
    _wait(lambda: len(runs) == 1)
    # Three changes land while the first scan is still running…
    for _ in range(3):
        orch.request_capability_refresh()
    release.set()
    # …and are served by exactly one more pass that starts after them.
    _wait(lambda: not orch._refresh_running)
    assert len(runs) == 2


def test_refresh_waits_for_a_running_periodic_rescan(orch: Orchestrator, monkeypatch: pytest.MonkeyPatch) -> None:
    runs: list[float] = []
    monkeypatch.setattr(orch, "rescan", lambda **_: runs.append(time.monotonic()) or {})
    with orch._rescan_guard:  # a periodic rescan is in flight
        orch.request_capability_refresh()
        time.sleep(0.2)
        assert runs == []  # not skipped, waiting
        held_until = time.monotonic()
    _wait(lambda: len(runs) == 1)
    assert runs[0] >= held_until


@pytest.fixture
def refreshes(orch: Orchestrator, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(orch, "request_capability_refresh", lambda: calls.append("refresh"))
    monkeypatch.setattr(orch, "push_capabilities_to_server", lambda: calls.append("push"))
    return calls


def test_custom_cap_routes_report(orch: Orchestrator, refreshes: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(custom_caps_service, "save_custom_cap", lambda name, text: None)
    monkeypatch.setattr(custom_caps_service, "delete_custom_cap", lambda name: None)
    with _client(orch) as client:
        assert client.post("/api/custom/save", json={"name": "x", "yaml": "a: 1"}).status_code == 200
        assert client.post("/api/custom/delete", json={"name": "x"}).status_code == 200
        assert client.post("/api/custom/upload", files={"file": ("y.yaml", b"a: 1")}).status_code == 200
    assert refreshes == ["refresh"] * 3


def test_comfy_workflow_changes_report(orch: Orchestrator, refreshes: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    for fn in ("add_workflow", "delete_workflow", "rename_workflow", "duplicate_workflow", "save_param_map"):
        monkeypatch.setattr(comfy_service, fn, lambda *a, **k: None)
    monkeypatch.setattr(comfy_service, "import_workflow", lambda *a, **k: {"ok": True})
    monkeypatch.setattr(comfy_service, "autodetect_param_map", lambda *a, **k: ({}, []))
    orch.add_comfy_workflow("w", "txt2img", "", "{}")
    orch.delete_comfy_workflow("w")
    orch.rename_comfy_workflow("w", "", "v", "")
    orch.duplicate_comfy_workflow("w", "", "v", "")
    orch.save_comfy_param_map("w", "txt2img", "", {})
    orch.import_comfy_workflow({})
    orch.autodetect_comfy_param_map("w", "txt2img", "")
    assert refreshes == ["refresh"] * 7


def test_detection_settings_rescan_and_policy_pushes(orch: Orchestrator, refreshes: list[str]) -> None:
    with _client(orch) as client:
        # Changes what detection finds → fresh scan (which pushes), not a stale push.
        assert client.post("/api/settings", json={"ollama_base_url": "http://10.0.0.2:11434"}).status_code == 200
        # Opt-in policy only filters the last scan → immediate push.
        assert client.post("/api/capabilities/policy", json={
            "regular_disabled": [], "sensitive_allowed": ["shell.zsh"], "slavemode_allowed": [],
        }).status_code == 200
        assert client.post("/api/settings", json={"display_name": "mac"}).status_code == 200
        # No change → nothing to report.
        assert client.post("/api/settings", json={"display_name": "mac"}).status_code == 200
    assert refreshes == ["refresh", "push", "push"]
