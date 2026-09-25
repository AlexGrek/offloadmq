"""offloadmq_agent — async toolkit of OffloadMQ processing classes.

This library is intentionally orchestration-free: it provides the HTTP client,
the executor registry, capability detection, and the data models. The polling
loop, settings, task store and parallel execution live in `offloadmq_core`.
"""
from offloadmq_agent.tls import ensure_ca_bundle

# Must run before anything imports aiohttp: aiohttp.connector builds its default
# verified SSL context at import time, so a later SSL_CERT_FILE is never seen.
ensure_ca_bundle()

import offloadmq_agent.exec  # noqa: E402,F401  — registers built-in executors
from offloadmq_agent.client import OffloadMQClient, OffloadMQError  # noqa: E402
from offloadmq_agent.context import ExecContext, TaskCancelled  # noqa: E402
from offloadmq_agent.executor import Executor, find, register, registered_prefixes  # noqa: E402
from offloadmq_agent.models import (  # noqa: E402
    AgentAuth,
    AgentRegistration,
    LogEntry,
    LogLevel,
    Task,
    TaskResult,
    TaskStatus,
)

__all__ = [
    "OffloadMQClient",
    "OffloadMQError",
    "ExecContext",
    "TaskCancelled",
    "Executor",
    "find",
    "register",
    "registered_prefixes",
    "AgentAuth",
    "AgentRegistration",
    "LogEntry",
    "LogLevel",
    "Task",
    "TaskResult",
    "TaskStatus",
]
