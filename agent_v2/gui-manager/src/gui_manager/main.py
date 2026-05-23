"""
GUI entry point — cross-platform desktop app.

  omq-gui              → native OS window (pywebview) + embedded UI server + agent
  omq-gui --server     → headless server only (open the URL in any browser)

Both modes share the same core Orchestrator and the same FastAPI UI server.
"""
from __future__ import annotations

import argparse
import socket
import time

from offloadmq_core import Orchestrator, run_blocking, run_in_thread


def _find_free_port(preferred: int) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return int(s.getsockname()[1])


def _wait_for_server(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"UI server did not start on port {port} within {timeout}s")


def _maybe_autostart(orch: Orchestrator) -> None:
    if orch.get_settings().autostart:
        try:
            orch.start()
        except RuntimeError:
            pass  # not configured yet — user can start from the UI


def _run_window(port: int) -> None:
    import webview  # lazy — only needed in GUI mode

    webview.create_window(
        title="OffloadMQ Agent",
        url=f"http://127.0.0.1:{port}",
        width=1100,
        height=760,
        resizable=True,
        min_size=(820, 560),
    )
    webview.start()


def main() -> None:
    parser = argparse.ArgumentParser(description="OffloadMQ Agent (GUI)")
    parser.add_argument(
        "--server", action="store_true", help="Headless server mode (no window)"
    )
    parser.add_argument("--port", type=int, default=8090, help="UI server port")
    args = parser.parse_args()

    orch = Orchestrator()
    port = _find_free_port(args.port)
    _maybe_autostart(orch)

    if args.server:
        print(f"OffloadMQ Agent UI → http://127.0.0.1:{port}")
        try:
            run_blocking(orch, host="127.0.0.1", port=port)
        finally:
            orch.stop()
        return

    run_in_thread(orch, host="127.0.0.1", port=port)
    _wait_for_server(port)
    try:
        _run_window(port)
    finally:
        orch.stop()


if __name__ == "__main__":
    main()
