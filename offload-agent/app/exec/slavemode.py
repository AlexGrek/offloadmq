"""Executors for slavemode.* capabilities.

These capabilities let the server instruct the agent to perform control operations
on itself — capability rescans, config reloads, etc.

Security: a slavemode capability only executes if it is explicitly listed in the
``slavemode-allowed-caps`` config key (a JSON array of strings).  If the key is
absent or empty, all slavemode tasks are rejected.

Example config:
    "slavemode-allowed-caps": ["slavemode.force-rescan"]
"""

import logging
from pathlib import Path
from typing import Any

from ..capabilities import rescan_and_push
from ..config import load_config
from ..httphelpers import HttpClient
from ..models import TaskId
from .helpers import make_failure_report, make_success_report, report_result

logger = logging.getLogger("agent")

CONFIG_KEY = "slavemode-allowed-caps"

# All slavemode capabilities implemented in this module.
ALL_SLAVEMODE_CAPS = [
    "slavemode.force-rescan",
]


def _is_allowed(capability: str) -> bool:
    """Return True only if capability is in the slavemode allow-list."""
    cfg = load_config()
    allowed: list[Any] = cfg.get(CONFIG_KEY) or []
    return capability in allowed


def _force_rescan(http: HttpClient, task_id: TaskId, capability: str) -> bool:
    """Re-detect capabilities and push the updated list to the server."""
    logger.info("[slavemode] force-rescan: starting capability detection")
    caps = rescan_and_push(http, lambda msg: logger.info(msg))
    logger.info(f"[slavemode] force-rescan: pushed {len(caps)} capabilities")
    report = make_success_report(task_id, capability, {"caps": caps, "count": len(caps)})
    return report_result(http, report)


def execute_slavemode(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
) -> bool:
    if not _is_allowed(capability):
        msg = (
            f"Slavemode capability '{capability}' is not enabled. "
            f"Add it to '{CONFIG_KEY}' in the agent config to allow it."
        )
        logger.warning(f"[slavemode] {msg}")
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    match capability:
        case "slavemode.force-rescan":
            return _force_rescan(http, task_id, capability)
        case _:
            msg = f"Unknown slavemode capability: {capability}"
            logger.error(f"[slavemode] {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
