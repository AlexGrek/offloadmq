"""offloadmq_core — orchestration layer for the OffloadMQ agent.

Public surface: the Orchestrator (driven by both CLI and GUI entry points),
settings management, the in-memory task store, and the web-UI launcher.
"""
from offloadmq_agent.tls import ensure_ca_bundle

# Before anything opens a TLS connection (aiohttp WS, urllib updater).
ensure_ca_bundle()

from offloadmq_core import keep_awake  # noqa: E402
from offloadmq_core.orchestrator import Orchestrator  # noqa: E402
from offloadmq_core.settings import (  # noqa: E402
    SETTINGS_FILE,
    Settings,
    load_settings,
    save_settings,
)
from offloadmq_core.task_store import TaskRecord, TaskStore  # noqa: E402
from offloadmq_core.webui import run_blocking, run_in_thread  # noqa: E402

__all__ = [
    "keep_awake",
    "Orchestrator",
    "Settings",
    "SETTINGS_FILE",
    "load_settings",
    "save_settings",
    "TaskRecord",
    "TaskStore",
    "run_blocking",
    "run_in_thread",
]
