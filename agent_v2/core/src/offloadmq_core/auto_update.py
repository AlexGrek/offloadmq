"""Unattended self-update for Linux agents running under systemd.

Cycle (every ``auto_update_interval_hours``, with jitter so a fleet started
together doesn't hit the release server in lockstep):

1. Ask dl.alexgr.space for the latest release; stop unless it is newer.
2. Download it next to the running binary and smoke-test ``--version``.
3. Wait for an idle moment, then *drain*: atomically (under the orchestrator
   lock) confirm no task is running and no result is undelivered, and stop
   accepting new pushes. A task pushed after that is left untouched — it
   stays ``Assigned`` server-side and the server re-queues it once our next
   heartbeat claim no longer lists it.
4. Swap the binary in, stop the orchestrator and exit with
   :data:`EXIT_CODE_RESTART`; systemd (``Restart=on-failure``) starts the new
   version.

Only enabled when the process can actually be restarted by a supervisor —
``INVOCATION_ID`` is set by systemd for every unit it runs. A terminal
``omq serve`` never updates itself underneath the user.
"""
from __future__ import annotations

import os
import random
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

from offloadmq_core import updater
from offloadmq_core.version import get_app_version

if TYPE_CHECKING:
    from offloadmq_core.orchestrator import Orchestrator

#: Exit status telling systemd "restart me" (EX_TEMPFAIL). The generated unit
#: lists it in RestartForceExitStatus/SuccessExitStatus; older units restart on
#: it anyway via Restart=on-failure.
EXIT_CODE_RESTART = 75

_FIRST_CHECK_DELAY = (60.0, 600.0)  # seconds after start
_JITTER = 0.1  # ± fraction of the interval
_IDLE_POLL_SECS = 5.0


def _default_restart() -> None:
    os._exit(EXIT_CODE_RESTART)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def supervisor_unsupported_reason() -> str | None:
    if not os.environ.get("INVOCATION_ID"):
        return "Not running under systemd — install the systemd service to enable auto-update"
    return None


class AutoUpdater:
    def __init__(
        self,
        orch: Orchestrator,
        *,
        restart: Callable[[], None] = _default_restart,
    ) -> None:
        self._orch = orch
        self._restart = restart
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._force = False
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "phase": "idle",
            "last_check": None,
            "latest": None,
            "error": None,
        }

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def unsupported_reason(self) -> str | None:
        return (
            updater.self_update_unsupported_reason(get_app_version())
            or supervisor_unsupported_reason()
        )

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        reason = self.unsupported_reason()
        if reason:
            self._set(phase="unsupported", error=None)
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._main, name="omq-auto-update", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def check_now(self) -> bool:
        """Run a cycle immediately (even if auto-update is disabled). False if unsupported."""
        if self._thread is None or not self._thread.is_alive():
            return False
        self._force = True
        self._wake.set()
        return True

    def handle_remote_request(self, check_only: bool) -> dict[str, Any]:
        """Serve ``slavemode.agent-update``: report versions, or start a forced cycle.

        Returns immediately — the cycle's drain waits for the requesting task
        itself to be resolved before restarting.
        """
        reason = self.unsupported_reason()
        if reason:
            raise updater.UpdateError(reason)
        current = get_app_version()
        with self._lock:
            phase = self._state["phase"]
        if phase not in ("idle", "unsupported"):
            return {"updating": True, "current": current,
                    "latest": self._state.get("latest"), "phase": phase}

        info = updater.check_for_update(current)
        self._set(last_check=_now(), latest=info.get("latest"))
        if "error" in info:
            raise updater.UpdateError(info["error"])
        out = {"current": current, "latest": info["latest"], "has_update": info["has_update"]}
        if check_only or not info["has_update"]:
            return {**out, "updating": False}
        if not self.check_now():
            raise updater.UpdateError("Auto-updater is not running (agent stopped?)")
        self._log(f"[update] server requested update to {info['latest']}")
        return {**out, "updating": True}

    def snapshot(self) -> dict[str, Any]:
        settings = self._orch.get_settings()
        with self._lock:
            state = dict(self._state)
        state.update(
            current=get_app_version(),
            enabled=settings.auto_update_enabled,
            interval_hours=settings.auto_update_interval_hours,
            unsupported_reason=self.unsupported_reason(),
        )
        return state

    # ------------------------------------------------------------------
    # Loop
    # ------------------------------------------------------------------

    def _set(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def _log(self, msg: str) -> None:
        self._orch._log(msg)

    def _sleep(self, seconds: float) -> bool:
        """Sleep until timeout or wake. Returns True if we should exit."""
        self._wake.wait(seconds)
        self._wake.clear()
        return self._stop.is_set()

    def _main(self) -> None:
        if self._sleep(random.uniform(*_FIRST_CHECK_DELAY)):
            return
        while not self._stop.is_set():
            force, self._force = self._force, False
            if force or self._orch.get_settings().auto_update_enabled:
                try:
                    self._cycle()
                except Exception as exc:  # noqa: BLE001
                    self._set(phase="idle", error=str(exc))
                    self._orch._record_error("ERROR", f"[update] auto-update failed: {exc}")
            hours = self._orch.get_settings().auto_update_interval_hours
            interval = hours * 3600.0 * random.uniform(1 - _JITTER, 1 + _JITTER)
            if self._sleep(interval):
                return

    def _cycle(self) -> None:
        current = get_app_version()
        self._set(phase="checking", error=None)
        info = updater.check_for_update(current)
        self._set(last_check=_now(), latest=info.get("latest"))
        if "error" in info:
            raise updater.UpdateError(info["error"])
        if not info["has_update"]:
            self._set(phase="idle")
            return

        version = str(info["latest"])
        self._log(f"[update] {version} available (running {current})")
        self._set(phase="downloading")
        staged = updater.stage_update(version, self._log)

        self._set(phase="waiting-for-idle")
        self._log(f"[update] {version} staged — waiting for running tasks to finish")
        if not self._drain():
            self._orch.end_drain()
            staged.path.unlink(missing_ok=True)
            self._set(phase="idle")
            return

        self._set(phase="restarting")
        try:
            updater.install_staged(staged, self._log)
        except Exception:
            self._orch.end_drain()
            staged.path.unlink(missing_ok=True)
            raise
        # INFO in the error pool so the operator sees the restart server-side.
        self._orch._record_error("INFO", f"[update] restarting {current} → {version}")
        self._orch.stop()
        time.sleep(1.0)  # let the WS close frame and log lines go out
        self._restart()

    def _drain(self) -> bool:
        """Block until the orchestrator is idle and draining. False if stopped meanwhile."""
        while not self._orch.try_begin_drain():
            if self._sleep(_IDLE_POLL_SECS):
                return False
        return not self._stop.is_set()
