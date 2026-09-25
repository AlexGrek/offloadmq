"""Self-update: version ordering, the binary swap, and the drain-then-restart cycle."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_core import auto_update, updater
from offloadmq_core.orchestrator import Orchestrator
from offloadmq_core.version import is_newer


def _orchestrator(tmp_path: Path) -> Orchestrator:
    return Orchestrator(settings_path=tmp_path / "settings.json")


# ----------------------------------------------------------------------
# Version ordering
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("candidate", "current", "expected"),
    [
        ("v0.3.261", "v0.3.260", True),
        ("v0.4.1", "v0.3.999", True),
        ("v0.3.260", "v0.3.260", False),
        ("v0.3.259", "v0.3.260", False),  # never downgrade
        ("v0.3.261", "0.0.0.dev0", False),  # dev builds are never replaced
        ("garbage", "v0.3.260", False),
        ("0.3.261", "v0.3.260", True),  # leading v is optional
    ],
)
def test_is_newer(candidate: str, current: str, expected: bool) -> None:
    assert is_newer(candidate, current) is expected


# ----------------------------------------------------------------------
# Drain
# ----------------------------------------------------------------------


def test_drain_requires_no_running_task(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    orch._store.create(Task(id="t-1", capability="debug.echo"))
    assert orch.try_begin_drain() is False
    orch._store.finish("t-1", TaskResult(task_id="t-1", status=TaskStatus.COMPLETED))
    assert orch.try_begin_drain() is True


def test_drain_requires_every_result_delivered(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    orch._pending_resolves["t-1"] = (
        "debug.echo",
        TaskResult(task_id="t-1", status=TaskStatus.COMPLETED),
    )
    assert orch.try_begin_drain() is False


def test_task_pushed_while_draining_is_left_for_the_server(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    assert orch.try_begin_drain()
    orch._dispatch(Task(id="t-9", capability="debug.echo"))
    # Not started, not in the store, so not in the heartbeat claim: the server
    # re-queues it instead of waiting on a restarting agent.
    assert orch.get_task("t-9") is None
    assert orch._active_claim() == []


# ----------------------------------------------------------------------
# Download, verify, swap, rollback
# ----------------------------------------------------------------------


@pytest.fixture
def fake_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = bindir / "omq"
    exe.write_text("#!/bin/sh\necho v0.3.260\n")
    exe.chmod(0o755)
    release = tmp_path / "release"
    release.write_text("#!/bin/sh\necho v0.3.300\n")

    monkeypatch.setattr(updater, "_current_exe", lambda: exe)
    monkeypatch.setattr(updater, "_os_arch", lambda: "linux-amd64")
    monkeypatch.setattr(updater, "_download_url", lambda _a, _v: release.as_uri())
    return {"exe": exe, "release": release}


def test_stage_and_install_keeps_previous(fake_install: dict[str, Path]) -> None:
    exe = fake_install["exe"]
    staged = updater.stage_update("v0.3.300", lambda _m: None)
    assert staged.path.parent == exe.parent  # same fs → atomic rename
    assert "v0.3.260" in exe.read_text()  # not swapped until install

    updater.install_staged(staged, lambda _m: None)
    assert "v0.3.300" in exe.read_text()
    assert "v0.3.260" in exe.with_name("omq.prev").read_text()
    assert not staged.path.exists()

    assert updater.rollback(lambda _m: None)["ok"]
    assert "v0.3.260" in exe.read_text()


def test_stage_rejects_binary_reporting_wrong_version(fake_install: dict[str, Path]) -> None:
    with pytest.raises(updater.UpdateError, match="expected v0.3.400"):
        updater.stage_update("v0.3.400", lambda _m: None)
    assert not any(p.name.endswith(".update") for p in fake_install["exe"].parent.iterdir())


def test_self_update_is_linux_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(updater.sys, "platform", "darwin")
    assert "Linux-only" in (updater.self_update_unsupported_reason("v0.3.260") or "")


# ----------------------------------------------------------------------
# Full cycle
# ----------------------------------------------------------------------


def test_cycle_drains_installs_then_restarts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orch = _orchestrator(tmp_path)
    events: list[str] = []
    staged = updater.StagedUpdate("v0.3.300", tmp_path / ".omq.update", tmp_path / "omq")

    def check(_current: str) -> dict[str, Any]:
        return {"latest": "v0.3.300", "has_update": True}

    monkeypatch.setattr(auto_update, "get_app_version", lambda: "v0.3.260")
    monkeypatch.setattr(updater, "check_for_update", check)
    monkeypatch.setattr(updater, "stage_update", lambda v, _log: staged)
    monkeypatch.setattr(updater, "install_staged", lambda s, _log: events.append("install"))
    monkeypatch.setattr(auto_update.time, "sleep", lambda _s: None)
    monkeypatch.setattr(orch, "stop", lambda: events.append("stop"))

    au = auto_update.AutoUpdater(orch, restart=lambda: events.append("restart"))
    au._cycle()

    assert events == ["install", "stop", "restart"]
    assert orch._draining


def test_cycle_noop_when_up_to_date(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    orch = _orchestrator(tmp_path)
    monkeypatch.setattr(
        updater, "check_for_update", lambda _c: {"latest": "v0.3.260", "has_update": False}
    )
    monkeypatch.setattr(
        updater, "stage_update", lambda *_a: pytest.fail("must not download")
    )
    au = auto_update.AutoUpdater(orch, restart=lambda: pytest.fail("must not restart"))
    au._cycle()
    assert au.snapshot()["phase"] == "idle"
    assert not orch._draining


# ----------------------------------------------------------------------
# slavemode.agent-update
# ----------------------------------------------------------------------


def test_agent_update_cap_hidden_where_self_update_cannot_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from offloadmq_agent import self_update
    from offloadmq_agent.slavemode_policy import slavemode_caps_for_registration

    cfg = {"slavemode_allowed_caps": ["slavemode.agent-update", "slavemode.force-rescan"]}
    monkeypatch.setattr(self_update, "_handler", None)
    assert slavemode_caps_for_registration(cfg) == ["slavemode.force-rescan"]
    monkeypatch.setattr(self_update, "_handler", lambda _check: {})
    assert "slavemode.agent-update" in slavemode_caps_for_registration(cfg)


def _supported_updater(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, latest: str
) -> tuple[auto_update.AutoUpdater, list[str]]:
    orch = _orchestrator(tmp_path)
    au = orch.auto_update
    woken: list[str] = []
    monkeypatch.setattr(au, "unsupported_reason", lambda: None)
    monkeypatch.setattr(au, "check_now", lambda: woken.append("wake") or True)
    monkeypatch.setattr(auto_update, "get_app_version", lambda: "v0.3.260")
    monkeypatch.setattr(
        updater,
        "check_for_update",
        lambda cur: {"latest": latest, "has_update": latest != cur},
    )
    return au, woken


def test_remote_request_starts_forced_cycle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    au, woken = _supported_updater(tmp_path, monkeypatch, "v0.3.300")
    out = au.handle_remote_request(check_only=False)
    assert out == {"current": "v0.3.260", "latest": "v0.3.300", "has_update": True, "updating": True}
    assert woken == ["wake"]


def test_remote_check_only_never_updates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    au, woken = _supported_updater(tmp_path, monkeypatch, "v0.3.300")
    out = au.handle_remote_request(check_only=True)
    assert out["updating"] is False and out["has_update"] is True
    assert woken == []


def test_remote_request_when_up_to_date(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    au, woken = _supported_updater(tmp_path, monkeypatch, "v0.3.260")
    assert au.handle_remote_request(check_only=False)["updating"] is False
    assert woken == []


def test_remote_request_refused_when_unsupported(tmp_path: Path) -> None:
    # Tests don't run frozen under systemd, so the real reason applies.
    au = _orchestrator(tmp_path).auto_update
    with pytest.raises(updater.UpdateError):
        au.handle_remote_request(check_only=True)
