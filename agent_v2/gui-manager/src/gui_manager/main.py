"""
GUI entry point — dual-mode launcher.

  omq-gui              → native OS window (pywebview) + embedded server
  omq-gui --server     → headless HTTP server only (open in any browser)
"""
from __future__ import annotations

import argparse
import socket
import threading
import time

import uvicorn

from ui_server.server import create_app


def _find_free_port(preferred: int) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def _start_server_thread(port: int) -> threading.Thread:
    app = create_app()

    def _run() -> None:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    t = threading.Thread(target=_run, daemon=True, name="ui-server")
    t.start()
    return t


def _wait_for_server(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"UI server did not start on port {port} within {timeout}s")


def _run_gui(port: int) -> None:
    import webview  # imported lazily — not available in server-only installs

    webview.create_window(
        title="OffloadMQ Agent",
        url=f"http://127.0.0.1:{port}",
        width=1100,
        height=720,
        resizable=True,
        min_size=(800, 500),
    )
    webview.start()


def main() -> None:
    parser = argparse.ArgumentParser(description="OffloadMQ Agent GUI")
    parser.add_argument(
        "--server",
        action="store_true",
        help="Run in headless server mode (no window)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8090,
        help="Port for the UI server (default: 8090)",
    )
    args = parser.parse_args()

    port = _find_free_port(args.port)

    if args.server:
        print(f"OffloadMQ Agent UI → http://127.0.0.1:{port}")
        # Blocking — keep the server alive.
        app = create_app()
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    else:
        _start_server_thread(port)
        _wait_for_server(port)
        _run_gui(port)


if __name__ == "__main__":
    main()
