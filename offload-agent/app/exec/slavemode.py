"""Executors for slavemode.* capabilities.

These capabilities let the server instruct the agent to perform control operations
on itself — capability rescans, config reloads, etc.

Security: a slavemode capability only executes if it is explicitly listed in the
``slavemode-allowed-caps`` config key (a JSON array of strings).  If the key is
absent or empty, all slavemode tasks are rejected.

Slavemode caps are not part of the regular ``capabilities`` config list. They are
advertised to the server only when allow-listed here; registration merges regular
selected caps with these allow-listed slavemode caps.

Example config:
    "slavemode-allowed-caps": ["slavemode.force-rescan", "slavemode.special-caps-ctrl"]
"""

import logging
from pathlib import Path
from typing import Any, List

from ..config import load_config
from ..custom_caps import delete_custom_cap, discover_custom_caps, save_custom_cap_yaml
from ..httphelpers import HttpClient
from ..models import TaskId
from .helpers import make_failure_report, make_success_report, report_result

logger = logging.getLogger("agent")

CONFIG_KEY = "slavemode-allowed-caps"

# All slavemode capabilities implemented in this module.
ALL_SLAVEMODE_CAPS = [
    "slavemode.force-rescan",
    "slavemode.special-caps-ctrl",
]

SLAVEMODE_PREFIX = "slavemode."


def strip_slavemode_caps(caps: List[str]) -> List[str]:
    """Drop slavemode.* entries; they are not regular selectable capabilities."""
    return [c for c in caps if not c.startswith(SLAVEMODE_PREFIX)]


def slavemode_caps_for_registration(cfg: dict[str, Any]) -> List[str]:
    """Implemented slavemode caps that are allow-listed (what we advertise to the server)."""
    allowed: list[Any] = cfg.get(CONFIG_KEY) or []
    allowed_set = set(str(x) for x in allowed)
    return sorted(c for c in ALL_SLAVEMODE_CAPS if c in allowed_set)


def merge_registration_caps(regular_caps: List[str], cfg: dict[str, Any]) -> List[str]:
    """Regular (non-slavemode) caps plus allow-listed slavemode caps for register/update."""
    base = strip_slavemode_caps(regular_caps)
    return sorted(set(base) | set(slavemode_caps_for_registration(cfg)))


def _is_allowed(capability: str) -> bool:
    """Return True only if capability is in the slavemode allow-list."""
    cfg = load_config()
    allowed: list[Any] = cfg.get(CONFIG_KEY) or []
    return capability in allowed


def _force_rescan(http: HttpClient, task_id: TaskId, capability: str) -> bool:
    """Re-detect capabilities and push the updated list to the server."""
    from ..capabilities import rescan_and_push

    logger.info("[slavemode] force-rescan: starting capability detection")
    caps = rescan_and_push(http, lambda msg: logger.info(msg))
    logger.info(f"[slavemode] force-rescan: pushed {len(caps)} capabilities")
    report = make_success_report(task_id, capability, {"caps": caps, "count": len(caps)})
    return report_result(http, report)


def _special_caps_ctrl(http: HttpClient, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Get, set, or delete a special (custom) capability definition.

    Payload variants:
      { "get": true }               — list all custom caps
      { "set": { ...cap dict... } } — create or replace a custom cap YAML
      { "delete": "<cap-name>" }    — remove a custom cap by name
    """
    if "get" in payload:
        caps = [c.to_dict() for c in discover_custom_caps()]
        logger.info(f"[slavemode] special-caps-ctrl: listed {len(caps)} custom cap(s)")
        report = make_success_report(task_id, capability, {"caps": caps, "count": len(caps)})
        return report_result(http, report)

    if "set" in payload:
        cap_dict = payload["set"]
        if not isinstance(cap_dict, dict):
            msg = "'set' value must be a JSON object describing the custom cap"
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
        try:
            path = save_custom_cap_yaml(cap_dict)
        except (ValueError, Exception) as exc:
            msg = f"Failed to save custom cap: {exc}"
            logger.warning(f"[slavemode] special-caps-ctrl: {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
        logger.info(f"[slavemode] special-caps-ctrl: saved custom cap to {path}")
        from ..capabilities import rescan_and_push

        updated_caps = rescan_and_push(http, lambda msg: logger.info(msg))
        report = make_success_report(task_id, capability, {"saved": str(path), "caps": updated_caps})
        return report_result(http, report)

    if "delete" in payload:
        name = payload["delete"]
        if not isinstance(name, str) or not name:
            msg = "'delete' value must be a non-empty string (the custom cap name)"
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
        deleted = delete_custom_cap(name)
        if not deleted:
            msg = f"Custom cap '{name}' not found"
            logger.warning(f"[slavemode] special-caps-ctrl: {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
        logger.info(f"[slavemode] special-caps-ctrl: deleted custom cap '{name}'")
        from ..capabilities import rescan_and_push

        updated_caps = rescan_and_push(http, lambda msg: logger.info(msg))
        report = make_success_report(task_id, capability, {"deleted": name, "caps": updated_caps})
        return report_result(http, report)

    msg = "Payload must contain one of: 'get', 'set', 'delete'"
    report = make_failure_report(task_id, capability, msg)
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
        case "slavemode.special-caps-ctrl":
            return _special_caps_ctrl(http, task_id, capability, payload)
        case _:
            msg = f"Unknown slavemode capability: {capability}"
            logger.error(f"[slavemode] {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(http, report)
