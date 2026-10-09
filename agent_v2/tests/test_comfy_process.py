"""Agent-managed ComfyUI process: restart limiter, launch command, lifecycle.

The lifecycle tests spawn real (tiny) Python scripts standing in for ComfyUI's
main.py, so crash detection, the 5-in-20-min restart cap, tree kill and
pid-file adoption are exercised against actual processes.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from offloadmq_core import comfy_process
from offloadmq_core.comfy_process import (
    CRASH_LOOP,
    RUNNING,
    STOPPED,
    ComfyProcessManager,
    RestartLimiter,
    build_command,
    detect_desktop_install,
)
from offloadmq_core.settings import Settings


# ---------------------------------------------------------------------------
# RestartLimiter
# ---------------------------------------------------------------------------


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def test_limiter_allows_five_then_blocks() -> None:
    clock = FakeClock()
    lim = RestartLimiter(max_restarts=5, window_secs=1200, clock=clock)
    for _ in range(5):
        assert lim.try_acquire()
        clock.t += 60
    assert not lim.try_acquire()
    assert lim.recent() == 5


def test_limiter_window_slides() -> None:
    clock = FakeClock()
    lim = RestartLimiter(max_restarts=5, window_secs=1200, clock=clock)
    for _ in range(5):
        assert lim.try_acquire()
        clock.t += 100  # restarts at t=0,100,…,400 (relative)
    assert not lim.try_acquire()
    # First stamp ages out at +1200 — exactly one slot frees up.
    clock.t = 1000.0 + 1200.0
    assert lim.try_acquire()
    assert not lim.try_acquire()


def test_limiter_reset() -> None:
    lim = RestartLimiter(max_restarts=1, window_secs=1200, clock=FakeClock())
    assert lim.try_acquire()
    assert not lim.try_acquire()
    lim.reset()
    assert lim.try_acquire()


# ---------------------------------------------------------------------------
# Launch command
# ---------------------------------------------------------------------------


def test_command_derives_port_and_listen_from_url() -> None:
    s = Settings(
        comfyui_url="http://localhost:6966",
        comfyui_python="py",
        comfyui_main_py="main.py",
        comfyui_args=["--enable-manager"],
    )
    assert build_command(s) == [
        "py", "-s", "main.py", "--enable-manager", "--port", "6966", "--listen", "127.0.0.1",
    ]


def test_command_respects_explicit_port_and_listen() -> None:
    s = Settings(
        comfyui_url="http://127.0.0.1:6966",
        comfyui_python="py",
        comfyui_main_py="main.py",
        comfyui_args=["--port", "7000", "--listen"],
    )
    assert build_command(s)[3:] == ["--port", "7000", "--listen"]


# ---------------------------------------------------------------------------
# Comfy Desktop discovery
# ---------------------------------------------------------------------------


def test_detect_desktop_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data_dir = tmp_path / "Comfy Desktop"
    (data_dir / "instance-model-paths").mkdir(parents=True)
    (data_dir / "instance-model-paths" / "inst-1.yaml").write_text("x: 1")
    install = tmp_path / "install"
    (install / "ComfyUI").mkdir(parents=True)
    (install / "ComfyUI" / "main.py").write_text("")
    base = tmp_path / "base"
    py = base / "venv-python"
    py.parent.mkdir(parents=True)
    py.write_text("")
    (data_dir / "installations.json").write_text(json.dumps([
        {"id": "cloud", "sourceId": "cloud", "remoteUrl": "https://cloud.comfy.org/"},
        {
            "id": "inst-1",
            "name": "ComfyUI",
            "installPath": str(install),
            "adoptedBaseDir": str(base),
            "adoptedPythonPath": str(py),
            "launchArgs": "--port 6966 --enable-manager --listen",
            "inputDir": str(base / "input"),
            "outputDir": str(base / "output"),
            "lastLaunchedAt": 5,
        },
    ]))
    monkeypatch.setattr(comfy_process, "_desktop_data_dir", lambda: data_dir)

    found = detect_desktop_install()
    assert found is not None
    assert found["python"] == str(py)
    assert found["mainPy"] == str(install / "ComfyUI" / "main.py")
    assert found["url"] == "http://127.0.0.1:6966"
    args = found["args"]
    assert "--enable-manager" in args
    assert "--port" not in args and "--listen" not in args
    assert args[args.index("--base-directory") + 1] == str(base)
    assert args[args.index("--extra-model-paths-config") + 1] == str(
        data_dir / "instance-model-paths" / "inst-1.yaml"
    )


def test_detect_without_desktop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(comfy_process, "_desktop_data_dir", lambda: tmp_path / "missing")
    assert detect_desktop_install() is None


# ---------------------------------------------------------------------------
# Lifecycle against real processes
# ---------------------------------------------------------------------------


@pytest.fixture
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(comfy_process, "_WATCH_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(comfy_process, "_CRASH_RESTART_DELAY_SECS", 0.01)
    monkeypatch.setattr(comfy_process, "_STOP_TIMEOUT_SECS", 2.0)


class Harness:
    def __init__(
        self, tmp_path: Path, script: str, *, ready: bool, name: str = "a", **settings: Any
    ) -> None:
        # Each harness gets its own main.py (a second harness must not rewrite
        # the script a still-starting child is about to read); the state file
        # is shared so adoption can be tested.
        main = tmp_path / name / "main.py"
        main.parent.mkdir(exist_ok=True)
        main.write_text(script)
        self.settings = Settings(
            comfyui_url="http://127.0.0.1:1",  # never actually probed (patched)
            comfyui_python=sys.executable,
            comfyui_main_py=str(main),
            **settings,
        )
        self.errors: list[tuple[str, str]] = []
        self.changes = 0
        self.ready = ready
        self.mgr = ComfyProcessManager(
            get_settings=lambda: self.settings,
            log=lambda _m: None,
            report_error=lambda sev, text: self.errors.append((sev, text)),
            on_change=self._changed,
            state_path=tmp_path / "comfy-state.json",
        )

    def _changed(self) -> None:
        self.changes += 1


def _wait_for(pred: Any, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def _patch_probe(monkeypatch: pytest.MonkeyPatch, h: Harness) -> None:
    monkeypatch.setattr(comfy_process, "probe_ready", lambda *_a, **_k: h.ready)


def test_crash_restarts_capped_at_five(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None
) -> None:
    counter = tmp_path / "spawns.txt"
    script = (
        "import sys\n"
        f"open({str(counter)!r}, 'a').write('x')\n"
        "sys.exit(3)\n"
    )
    h = Harness(tmp_path, script, ready=False, comfyui_restart_on_crash=True)
    _patch_probe(monkeypatch, h)
    h.ready = False
    # start() refuses when *something* already answers; nothing does here.
    h.mgr.start()
    try:
        assert _wait_for(lambda: h.mgr.status()["state"] == CRASH_LOOP)
        # 1 manual start + 5 automatic restarts, then it gives up.
        assert counter.read_text() == "x" * 6
        st = h.mgr.status()
        assert st["restartsInWindow"] == 5
        assert st["lastExitCode"] == 3
        assert any(sev == "CRITICAL" for sev, _ in h.errors)
        # A manual start clears the lockout.
        h.settings = h.settings.model_copy(update={"comfyui_restart_on_crash": False})
        h.mgr.start()
        assert _wait_for(lambda: h.mgr.status()["state"] == "crashed")
        assert h.mgr.status()["restartsInWindow"] == 0
    finally:
        h.mgr.shutdown()


def test_no_restart_when_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None
) -> None:
    h = Harness(tmp_path, "import sys; sys.exit(1)\n", ready=False)
    _patch_probe(monkeypatch, h)
    h.mgr.start()
    try:
        assert _wait_for(lambda: h.mgr.status()["state"] == "crashed")
        time.sleep(0.3)
        assert h.mgr.status()["state"] == "crashed"
        assert not h.mgr.status()["managed"]
    finally:
        h.mgr.shutdown()


def test_start_ready_stop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None) -> None:
    h = Harness(
        tmp_path,
        "import time\nprint('Starting server', flush=True)\nwhile True: time.sleep(1)\n",
        ready=False,
    )
    _patch_probe(monkeypatch, h)
    h.mgr.start()
    try:
        assert h.mgr.status()["managed"]
        assert _wait_for(lambda: "Starting server" in h.mgr.status()["output"])
        # Port isn't "answering" until probe says so; then the watchdog flips it.
        h.ready = True
        assert _wait_for(lambda: h.mgr.status()["state"] == RUNNING)
        pid = h.mgr.status()["pid"]
        h.ready = False
        st = h.mgr.stop()
        assert st["state"] == STOPPED and not st["managed"]
        import psutil

        assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
        assert not (tmp_path / "comfy-state.json").exists()
    finally:
        h.mgr.shutdown()


def test_start_refuses_when_foreign_comfy_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None
) -> None:
    h = Harness(tmp_path, "pass\n", ready=True)
    _patch_probe(monkeypatch, h)
    with pytest.raises(ValueError, match="not started by this agent"):
        h.mgr.start()
    assert h.mgr.status()["state"] == "external"


def test_adopts_process_left_by_previous_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None
) -> None:
    first = Harness(tmp_path, "import time\nwhile True: time.sleep(1)\n", ready=False)
    _patch_probe(monkeypatch, first)
    first.mgr.start()
    pid = first.mgr.status()["pid"]
    # Simulate a hard exit: forget the process without killing it.
    first.mgr._shutdown.set()
    with first.mgr._lock:
        first.mgr._proc = None
        first.mgr._popen = None

    second = Harness(tmp_path, "unused\n", ready=True, name="b")
    _patch_probe(monkeypatch, second)
    try:
        second.mgr.autostart()  # launch_on_startup off → only adopts
        st = second.mgr.status()
        assert st["managed"] and st["adopted"] and st["pid"] == pid
        assert _wait_for(lambda: second.mgr.status()["state"] == RUNNING)
        second.mgr.stop()
        assert not second.mgr.status()["managed"]
    finally:
        second.mgr.shutdown()


def test_constructing_manager_does_not_adopt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fast: None
) -> None:
    """Short-lived `omq` subcommands build an Orchestrator — they must not adopt (or kill)."""
    first = Harness(tmp_path, "import time\nwhile True: time.sleep(1)\n", ready=False)
    _patch_probe(monkeypatch, first)
    first.mgr.start()
    try:
        bystander = Harness(tmp_path, "unused\n", ready=False, name="b")
        assert not bystander.mgr.status()["managed"]
        bystander.mgr.shutdown()
        assert first.mgr.status()["managed"]  # bystander's exit didn't kill it
    finally:
        first.mgr.shutdown()
