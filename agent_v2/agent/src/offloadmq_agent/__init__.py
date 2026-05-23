"""offloadmq_agent — async toolkit of OffloadMQ processing classes.

This library is intentionally orchestration-free: it provides the HTTP client,
the executor registry, capability detection, and the data models. The polling
loop, settings, task store and parallel execution live in `offloadmq_core`.
"""
import offloadmq_agent.exec  # noqa: F401  — registers built-in executors
from offloadmq_agent.client import OffloadMQClient, OffloadMQError
from offloadmq_agent.context import ExecContext, TaskCancelled
from offloadmq_agent.executor import Executor, find, register, registered_prefixes
from offloadmq_agent.models import (
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
