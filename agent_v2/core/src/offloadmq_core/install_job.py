"""One background install/repair/uninstall at a time, with a log tail for the GUI.

Shared by every on-demand runtime the agent manages (SHARP, background-removal
models, …): the orchestrator owns one job per feature, the GUI polls
:meth:`InstallJob.snapshot` through ``GET /<feature>/status``.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

LogFn = Callable[[str], None]


class InstallJob:
    def __init__(self, label: str, error: type[Exception] = RuntimeError) -> None:
        self._label = label
        self._error = error
        self._lock = threading.Lock()
        self._log: deque[str] = deque(maxlen=500)
        self._state: dict[str, Any] = {"state": "idle", "action": None, "error": None,
                                       "started_at": None, "finished_at": None}
        self._cancel = threading.Event()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {**self._state, "log": list(self._log)}

    def running(self) -> bool:
        with self._lock:
            return self._state["state"] == "running"

    def cancel(self) -> None:
        self._cancel.set()

    def start(self, action: str, fn: Callable[[LogFn, Callable[[], bool]], Any],
              on_done: Callable[[bool], None] | None = None) -> dict[str, Any]:
        with self._lock:
            if self._state["state"] == "running":
                raise self._error(f"a {self._label} {self._state['action']} is already running")
            self._log.clear()
            self._cancel.clear()
            self._state = {"state": "running", "action": action, "error": None,
                           "started_at": time.time(), "finished_at": None}

        def log(line: str) -> None:
            with self._lock:
                self._log.append(line)

        def run() -> None:
            ok = False
            try:
                fn(log, self._cancel.is_set)
                ok = True
            except Exception as exc:  # noqa: BLE001 — surfaced in the GUI
                log(f"ERROR: {exc}")
                with self._lock:
                    self._state["error"] = str(exc)
            with self._lock:
                self._state["state"] = "succeeded" if ok else "failed"
                self._state["finished_at"] = time.time()
            if on_done is not None:
                on_done(ok)

        slug = self._label.lower().replace(" ", "-")
        threading.Thread(target=run, name=f"omq-{slug}-{action}", daemon=True).start()
        return self.snapshot()
