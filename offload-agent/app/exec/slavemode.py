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
from ..models import TaskId
from ..transport import AgentTransport
from ..onnx_models import ONNX_MODEL_REGISTRY, delete_model as onnx_delete, list_models as onnx_list, prepare_model as onnx_prepare
from .helpers import make_failure_report, make_success_report, report_result

logger = logging.getLogger("agent")

CONFIG_KEY = "slavemode-allowed-caps"

# All slavemode capabilities implemented in this module.
ALL_SLAVEMODE_CAPS = [
    "slavemode.force-rescan",
    "slavemode.ollama-delete",
    "slavemode.ollama-list",
    "slavemode.ollama-pull",
    "slavemode.onnx-models-delete",
    "slavemode.onnx-models-list",
    "slavemode.onnx-models-prepare",
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


def _force_rescan(transport: AgentTransport, task_id: TaskId, capability: str) -> bool:
    """Re-detect capabilities and push the updated list to the server."""
    from ..capabilities import rescan_and_push

    logger.info("[slavemode] force-rescan: starting capability detection")
    caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    logger.info(f"[slavemode] force-rescan: pushed {len(caps)} capabilities")
    report = make_success_report(task_id, capability, {"caps": caps, "count": len(caps)})
    return report_result(transport, report)


def _special_caps_ctrl(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
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
        return report_result(transport, report)

    if "set" in payload:
        cap_dict = payload["set"]
        if not isinstance(cap_dict, dict):
            msg = "'set' value must be a JSON object describing the custom cap"
            report = make_failure_report(task_id, capability, msg)
            return report_result(transport, report)
        try:
            path = save_custom_cap_yaml(cap_dict)
        except (ValueError, Exception) as exc:
            msg = f"Failed to save custom cap: {exc}"
            logger.warning(f"[slavemode] special-caps-ctrl: {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(transport, report)
        logger.info(f"[slavemode] special-caps-ctrl: saved custom cap to {path}")
        from ..capabilities import rescan_and_push

        updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
        report = make_success_report(task_id, capability, {"saved": str(path), "caps": updated_caps})
        return report_result(transport, report)

    if "delete" in payload:
        name = payload["delete"]
        if not isinstance(name, str) or not name:
            msg = "'delete' value must be a non-empty string (the custom cap name)"
            report = make_failure_report(task_id, capability, msg)
            return report_result(transport, report)
        deleted = delete_custom_cap(name)
        if not deleted:
            msg = f"Custom cap '{name}' not found"
            logger.warning(f"[slavemode] special-caps-ctrl: {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(transport, report)
        logger.info(f"[slavemode] special-caps-ctrl: deleted custom cap '{name}'")
        from ..capabilities import rescan_and_push

        updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
        report = make_success_report(task_id, capability, {"deleted": name, "caps": updated_caps})
        return report_result(transport, report)

    msg = "Payload must contain one of: 'get', 'set', 'delete'"
    report = make_failure_report(task_id, capability, msg)
    return report_result(transport, report)


def _ollama_list(transport: AgentTransport, task_id: TaskId, capability: str) -> bool:
    """List installed Ollama models and return their metadata."""
    from ..ollama import list_ollama_models_raw

    logger.info("[slavemode] ollama-list: fetching model list")
    try:
        models = list_ollama_models_raw()
    except RuntimeError as e:
        report = make_failure_report(task_id, capability, str(e))
        return report_result(transport, report)

    logger.info(f"[slavemode] ollama-list: {len(models)} model(s)")
    report = make_success_report(task_id, capability, {"models": models, "count": len(models)})
    return report_result(transport, report)


def _ollama_delete(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Delete an installed Ollama model.

    Payload: { "model": "<name>" }
    """
    from ..ollama import delete_ollama_model

    name = payload.get("model", "")
    if not isinstance(name, str) or not name.strip():
        msg = "'model' field must be a non-empty string"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    name = name.strip()
    logger.info(f"[slavemode] ollama-delete: deleting '{name}'")
    try:
        delete_ollama_model(name)
    except RuntimeError as e:
        report = make_failure_report(task_id, capability, str(e))
        return report_result(transport, report)

    logger.info(f"[slavemode] ollama-delete: deleted '{name}'")
    report = make_success_report(task_id, capability, {"deleted": name})
    return report_result(transport, report)


def _ollama_pull(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Pull an Ollama model with streaming progress updates.

    Payload: { "model": "<name>" }
    """
    from ..ollama import pull_ollama_model
    from .helpers import TaskCancelled, report_cancelled, report_progress, report_starting

    name = payload.get("model", "")
    if not isinstance(name, str) or not name.strip():
        msg = "'model' field must be a non-empty string"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    name = name.strip()
    logger.info(f"[slavemode] ollama-pull: pulling '{name}'")
    report_starting(transport, task_id)

    def on_progress(status: str) -> None:
        logger.info(f"[slavemode] ollama-pull {name}: {status}")
        report_progress(transport, log=f"{status}\n", stage=None, task_id=task_id)

    try:
        pull_ollama_model(name, on_progress)
    except TaskCancelled:
        report_cancelled(transport, task_id, capability)
        return True
    except RuntimeError as e:
        report = make_failure_report(task_id, capability, str(e))
        return report_result(transport, report)

    logger.info(f"[slavemode] ollama-pull: completed '{name}'")
    report = make_success_report(task_id, capability, {"pulled": name}, duration_sec=60.0)
    return report_result(transport, report)


def _onnx_models_list(transport: AgentTransport, task_id: TaskId, capability: str) -> bool:
    """List all known ONNX models and their download status."""
    logger.info("[slavemode] onnx-models-list: fetching model list")
    models = onnx_list()
    logger.info(f"[slavemode] onnx-models-list: {len(models)} model(s)")
    report = make_success_report(task_id, capability, {"models": models, "count": len(models)})
    return report_result(transport, report)


def _onnx_models_delete(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Delete a downloaded ONNX model.

    Payload: { "model": "<name>" }
    """
    name = payload.get("model", "")
    if not isinstance(name, str) or not name.strip():
        msg = "'model' field must be a non-empty string"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    name = name.strip()
    if name not in ONNX_MODEL_REGISTRY:
        known = ", ".join(ONNX_MODEL_REGISTRY)
        msg = f"Unknown ONNX model '{name}'. Known models: {known}"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    logger.info(f"[slavemode] onnx-models-delete: deleting '{name}'")
    deleted = onnx_delete(name)
    if not deleted:
        msg = f"ONNX model '{name}' is not installed"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    logger.info(f"[slavemode] onnx-models-delete: deleted '{name}'")
    from ..capabilities import rescan_and_push
    updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    report = make_success_report(task_id, capability, {"deleted": name, "caps": updated_caps})
    return report_result(transport, report)


def _onnx_models_prepare(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Download an ONNX model with streaming progress updates.

    Payload: { "model": "<name>" }
    """
    from .helpers import TaskCancelled, report_cancelled, report_progress, report_starting

    name = payload.get("model", "")
    if not isinstance(name, str) or not name.strip():
        msg = "'model' field must be a non-empty string"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    name = name.strip()
    logger.info(f"[slavemode] onnx-models-prepare: preparing '{name}'")
    report_starting(transport, task_id)

    def on_progress(status: str) -> None:
        logger.info(f"[slavemode] onnx-models-prepare {name}: {status}")
        report_progress(transport, log=f"{status}\n", stage=None, task_id=task_id)

    try:
        path = onnx_prepare(name, on_progress)
    except TaskCancelled:
        report_cancelled(transport, task_id, capability)
        return True
    except RuntimeError as e:
        report = make_failure_report(task_id, capability, str(e))
        return report_result(transport, report)

    logger.info(f"[slavemode] onnx-models-prepare: completed '{name}' at {path}")

    from ..capabilities import rescan_and_push
    updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    report = make_success_report(task_id, capability, {"prepared": name, "path": str(path), "caps": updated_caps})
    return report_result(transport, report)


def execute_slavemode(
    transport: AgentTransport,
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
        return report_result(transport, report)

    match capability:
        case "slavemode.force-rescan":
            return _force_rescan(transport, task_id, capability)
        case "slavemode.special-caps-ctrl":
            return _special_caps_ctrl(transport, task_id, capability, payload)
        case "slavemode.ollama-list":
            return _ollama_list(transport, task_id, capability)
        case "slavemode.ollama-delete":
            return _ollama_delete(transport, task_id, capability, payload)
        case "slavemode.ollama-pull":
            return _ollama_pull(transport, task_id, capability, payload)
        case "slavemode.onnx-models-list":
            return _onnx_models_list(transport, task_id, capability)
        case "slavemode.onnx-models-delete":
            return _onnx_models_delete(transport, task_id, capability, payload)
        case "slavemode.onnx-models-prepare":
            return _onnx_models_prepare(transport, task_id, capability, payload)
        case _:
            msg = f"Unknown slavemode capability: {capability}"
            logger.error(f"[slavemode] {msg}")
            report = make_failure_report(task_id, capability, msg)
            return report_result(transport, report)
