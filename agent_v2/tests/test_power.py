"""Pause on battery: power-source parsing and the orchestrator's pause gate."""
from __future__ import annotations

import threading
from pathlib import Path

import pytest

from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_core import power
from offloadmq_core.orchestrator import Orchestrator

BATTERY = (
    "Now drawing from 'Battery Power'\n"
    " -InternalBattery-0 (id=23461987)\t97%; discharging; 10:16 remaining present: true\n"
)
AC = (
    "Now drawing from 'AC Power'\n"
    " -InternalBattery-0 (id=23461987)\t100%; charged; 0:00 remaining present: true\n"
)
DESKTOP = "Now drawing from 'AC Power'\n"
UPS = "Now drawing from 'UPS Power'\n"


@pytest.mark.parametrize(
    ("output", "expected"),
    [(BATTERY, True), (AC, False), (DESKTOP, False), (UPS, False), ("", None), ("garbage", None)],
)
def test_parse_pmset(output: str, expected: bool | None) -> None:
    assert power.parse_pmset(output) is expected


def test_on_battery_is_unknown_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(power.sys, "platform", "linux")
    assert power.available() is False
    assert power.on_battery() is None


def _orchestrator(tmp_path: Path, *, pause_on_battery: bool) -> Orchestrator:
    orch = Orchestrator(settings_path=tmp_path / "settings.json")
    orch.update_settings(pause_on_battery=pause_on_battery)
    return orch


def test_battery_pauses_only_when_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []

    def fake_on_battery() -> bool:
        calls.append(1)
        return True

    monkeypatch.setattr(power, "on_battery", fake_on_battery)

    orch = _orchestrator(tmp_path, pause_on_battery=False)
    orch._check_power()
    assert orch._power_paused is False
    assert calls == [], "power source must not be probed while the setting is off"

    orch.update_settings(pause_on_battery=True)
    orch._check_power()
    assert orch._power_paused is True

    monkeypatch.setattr(power, "on_battery", lambda: False)
    orch._check_power()
    assert orch._power_paused is False


def test_unknown_power_source_never_pauses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(power, "on_battery", lambda: None)
    orch = _orchestrator(tmp_path, pause_on_battery=True)
    orch._check_power()
    assert orch._power_paused is False


def test_unsupported_platform_keeps_feature_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(power.sys, "platform", "linux")
    # Saved as on (e.g. via the raw config editor) on a platform without support.
    orch = _orchestrator(tmp_path, pause_on_battery=True)

    with pytest.raises(ValueError):
        orch.set_pause_on_battery(True)
    orch.set_pause_on_battery(False)

    orch.update_settings(pause_on_battery=True)
    status = orch.get_startup_status()
    assert status["battery_pause_available"] is False
    assert status["pause_on_battery"] is False

    orch._check_power()
    assert orch._power_paused is False


def test_paused_agent_refuses_pushed_tasks(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path, pause_on_battery=True)
    orch._power_paused = True
    orch._dispatch(Task(id="t-1", capability="debug.echo"))
    assert orch._store.get("t-1") is None
    assert orch._store.active_count() == 0


def test_disconnect_waits_for_running_task_and_its_result(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path, pause_on_battery=True)
    cycled: list[int] = []
    orch._cycle_session = lambda: cycled.append(1)  # type: ignore[method-assign]
    orch._online = True
    orch._power_paused = True

    task = Task(id="t-1", capability="debug.echo")
    orch._store.create(task)
    orch._disconnect_if_idle_for_pause()
    assert cycled == [], "a running task must be allowed to finish"

    # Finished, but the server has not acknowledged the result yet.
    result = TaskResult(task_id="t-1", status=TaskStatus.COMPLETED, output={})
    orch._pending_resolves["t-1"] = ("debug.echo", result)
    orch._store.finish("t-1", result)
    orch._disconnect_if_idle_for_pause()
    assert cycled == [], "an undelivered result must be handed over first"

    orch._pending_resolves.clear()
    orch._disconnect_if_idle_for_pause()
    assert cycled == [1]


def test_supervisor_holds_until_resumed(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path, pause_on_battery=True)
    orch._power_paused = True

    def resume() -> None:
        with orch._lock:
            orch._power_paused = False

    threading.Timer(0.2, resume).start()
    assert orch._wait_while_power_paused() is False
    assert orch._power_paused is False


def test_supervisor_hold_ends_on_stop(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path, pause_on_battery=True)
    orch._power_paused = True
    threading.Timer(0.2, orch._stop.set).start()
    assert orch._wait_while_power_paused() is True
