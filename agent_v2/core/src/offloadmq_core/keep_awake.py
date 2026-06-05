"""Prevent system sleep while the agent UI / GUI process is running.

Platform backends:
  - Windows: SetThreadExecutionState (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
  - macOS:   caffeinate -dims subprocess
  - Linux:   systemd-inhibit, else gdbus ScreenSaver.Inhibit, else xdg-screensaver reset loop
"""
from __future__ import annotations

import atexit
import logging
import re
import shutil
import subprocess
import sys
import threading
from typing import Callable

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_active = False
_method = ""
_handle: "_KeepAwakeHandle | None" = None


class _KeepAwakeHandle:
    def release(self) -> None:
        raise NotImplementedError


class _SubprocessHandle(_KeepAwakeHandle):
    def __init__(self, proc: subprocess.Popen[bytes]) -> None:
        self._proc = proc

    def release(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()


class _WindowsHandle(_KeepAwakeHandle):
    def release(self) -> None:
        import ctypes

        ES_CONTINUOUS = 0x80000000
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)  # type: ignore[attr-defined]


class _GdbusHandle(_KeepAwakeHandle):
    def __init__(self, cookie: int) -> None:
        self._cookie = cookie

    def release(self) -> None:
        subprocess.run(
            [
                "gdbus",
                "call",
                "--session",
                "--dest",
                "org.freedesktop.ScreenSaver",
                "--object-path",
                "/org/freedesktop/ScreenSaver",
                "--method",
                "org.freedesktop.ScreenSaver.UnInhibit",
                str(self._cookie),
            ],
            check=False,
            capture_output=True,
        )


class _XdgResetHandle(_KeepAwakeHandle):
    def __init__(self, stop: threading.Event, thread: threading.Thread) -> None:
        self._stop = stop
        self._thread = thread

    def release(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)


def available() -> bool:
    if sys.platform == "win32":
        return True
    if sys.platform == "darwin":
        return shutil.which("caffeinate") is not None
    if sys.platform.startswith("linux"):
        return (
            shutil.which("systemd-inhibit") is not None
            or shutil.which("gdbus") is not None
            or shutil.which("xdg-screensaver") is not None
        )
    return False


def active() -> bool:
    with _lock:
        return _active


def method() -> str:
    with _lock:
        return _method


def _acquire_windows() -> _KeepAwakeHandle:
    import ctypes

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    ES_DISPLAY_REQUIRED = 0x00000002
    ctypes.windll.kernel32.SetThreadExecutionState(  # type: ignore[attr-defined]
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
    )
    return _WindowsHandle()


def _acquire_macos() -> _KeepAwakeHandle:
    proc = subprocess.Popen(
        ["caffeinate", "-dims"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return _SubprocessHandle(proc)


def _acquire_linux_systemd() -> _KeepAwakeHandle | None:
    if not shutil.which("systemd-inhibit"):
        return None
    proc = subprocess.Popen(
        [
            "systemd-inhibit",
            "--what=idle:sleep:handle-lid-switch:handle-power-key",
            "--who=OffloadMQ Agent",
            "--why=Agent GUI running",
            "--mode=block",
            "sleep",
            "infinity",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if proc.poll() is not None:
        return None
    return _SubprocessHandle(proc)


def _acquire_linux_gdbus() -> _KeepAwakeHandle | None:
    if not shutil.which("gdbus"):
        return None
    result = subprocess.run(
        [
            "gdbus",
            "call",
            "--session",
            "--dest",
            "org.freedesktop.ScreenSaver",
            "--object-path",
            "/org/freedesktop/ScreenSaver",
            "--method",
            "org.freedesktop.ScreenSaver.Inhibit",
            "OffloadMQ Agent",
            "Agent GUI running",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    match = re.search(r"\(uint32\s+(\d+)", result.stdout)
    if not match:
        return None
    return _GdbusHandle(int(match.group(1)))


def _acquire_linux_xdg() -> _KeepAwakeHandle | None:
    if not shutil.which("xdg-screensaver"):
        return None
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(30):
            subprocess.run(
                ["xdg-screensaver", "reset"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    thread = threading.Thread(target=_loop, name="omq-keep-awake", daemon=True)
    thread.start()
    return _XdgResetHandle(stop, thread)


def _acquire_linux() -> tuple[_KeepAwakeHandle, str]:
    for name, factory in (
        ("systemd-inhibit", _acquire_linux_systemd),
        ("gdbus-screensaver", _acquire_linux_gdbus),
        ("xdg-screensaver", _acquire_linux_xdg),
    ):
        handle = factory()
        if handle is not None:
            return handle, name
    raise RuntimeError("No Linux keep-awake backend available")


def _acquire() -> tuple[_KeepAwakeHandle, str]:
    if sys.platform == "win32":
        return _acquire_windows(), "windows-execution-state"
    if sys.platform == "darwin":
        return _acquire_macos(), "caffeinate"
    if sys.platform.startswith("linux"):
        return _acquire_linux()
    raise RuntimeError(f"Keep awake not supported on {sys.platform}")


def set_enabled(enabled: bool, log_fn: Callable[[str], None] | None = None) -> None:
    """Enable or disable sleep inhibition."""
    log = log_fn or logger.info
    global _active, _method, _handle

    with _lock:
        if enabled and _active:
            return
        if not enabled and not _active:
            return

        if _handle is not None:
            try:
                _handle.release()
            except Exception as exc:  # noqa: BLE001
                log(f"[keep-awake] release failed: {exc}")
            _handle = None
            _active = False
            _method = ""

        if not enabled:
            log("[keep-awake] disabled")
            return

        try:
            handle, method_name = _acquire()
        except Exception as exc:  # noqa: BLE001
            log(f"[keep-awake] failed to enable: {exc}")
            return

        _handle = handle
        _active = True
        _method = method_name
        log(f"[keep-awake] enabled via {method_name}")


def sync_from_settings(enabled: bool, log_fn: Callable[[str], None] | None = None) -> None:
    if enabled and not available():
        (log_fn or logger.info)(
            "[keep-awake] requested but no backend available on this platform"
        )
        return
    set_enabled(enabled, log_fn)


def shutdown() -> None:
    set_enabled(False)


atexit.register(shutdown)
