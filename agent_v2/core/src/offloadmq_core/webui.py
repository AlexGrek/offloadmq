"""Launch the FastAPI UI server bound to an Orchestrator.

Core owns the web UI lifecycle: it builds the app from `ui_server`, injects the
orchestrator, and runs uvicorn either blocking (server mode) or on a daemon
thread (GUI mode).
"""
from __future__ import annotations

import threading

import uvicorn
from ui_server.server import create_app

from offloadmq_core.orchestrator import Orchestrator


def build_server(orchestrator: Orchestrator, host: str, port: int) -> uvicorn.Server:
    app = create_app(orchestrator)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    return uvicorn.Server(config)


def run_blocking(orchestrator: Orchestrator, host: str = "127.0.0.1", port: int = 8090) -> None:
    """Run the UI server in the foreground (server / headless-with-UI mode)."""
    build_server(orchestrator, host, port).run()


def run_in_thread(
    orchestrator: Orchestrator, host: str = "127.0.0.1", port: int = 8090
) -> threading.Thread:
    """Run the UI server on a daemon thread (GUI mode) and return the thread."""
    server = build_server(orchestrator, host, port)
    thread = threading.Thread(target=server.run, name="omq-ui-server", daemon=True)
    thread.start()
    return thread
