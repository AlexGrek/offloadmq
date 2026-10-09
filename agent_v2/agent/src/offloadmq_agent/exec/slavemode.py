"""Executors for slavemode.* capabilities.

These capabilities let the server instruct the agent to perform control operations
on itself — capability rescans, config reloads, etc.

Security: a slavemode capability only executes if it is explicitly listed in the
``slavemode_allowed_caps`` config key (a JSON array of strings).  If the key is
absent or empty, all slavemode tasks are rejected.

Slavemode caps are not part of the regular ``capabilities`` config list. They are
advertised to the server only when allow-listed here; registration merges regular
selected caps with these allow-listed slavemode caps.

Example config:
    "slavemode_allowed_caps": ["slavemode.force-rescan", "slavemode.special-caps-ctrl"]
"""

import logging
from pathlib import Path
from typing import Any

from offloadmq_agent.settings_util import load_agent_settings as load_config
from offloadmq_agent.slavemode_policy import CONFIG_KEY, is_cap_allowed
from offloadmq_agent.custom_caps import delete_custom_cap, discover_custom_caps, save_custom_cap_yaml
from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.onnx_models import ONNX_MODEL_REGISTRY, delete_model as onnx_delete, list_models as onnx_list, prepare_model as onnx_prepare
from offloadmq_agent.exec.reporting import make_failure_report, make_success_report, report_result

logger = logging.getLogger("agent")


def _is_allowed(capability: str) -> bool:
    """Return True only if capability is in the slavemode allow-list.

    Reads the same key, via the same helper, that registration uses to decide
    what to advertise — so a cap can never be advertised yet refused here.
    """
    return is_cap_allowed(load_config(), capability)


def _force_rescan(transport: AgentTransport, task_id: TaskId, capability: str) -> bool:
    """Re-detect capabilities and push the updated list to the server."""
    from offloadmq_agent.rescan import rescan_and_push

    logger.info("[slavemode] force-rescan: starting capability detection")
    caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    logger.info(f"[slavemode] force-rescan: pushed {len(caps)} capabilities")
    report = make_success_report(task_id, capability, {"caps": caps, "count": len(caps)})
    return report_result(transport, report)


def _agent_update(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Check for / start a self-update of the agent binary.

    Payload variants:
      {}                 — install the latest release if newer, then restart
      { "check": true }  — only report current/latest versions

    The update itself runs on the auto-updater thread *after* this task is
    resolved: it waits for the agent to be idle (this task included), swaps the
    binary and exits so systemd restarts it. The result therefore only says
    whether an update was started; watch the agent's appVersion to see it land.
    """
    from offloadmq_agent.self_update import request_update

    check_only = bool(payload.get("check"))
    try:
        out = request_update(check_only=check_only)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        logger.warning(f"[slavemode] agent-update: {msg}")
        return report_result(transport, make_failure_report(task_id, capability, msg))
    logger.info(f"[slavemode] agent-update: {out}")
    return report_result(transport, make_success_report(task_id, capability, out))


def _comfy_ctrl(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    job_timeout: int,
) -> bool:
    """Start, stop, restart, or query the agent-managed local ComfyUI server.

    Payload: { "action": "start" | "stop" | "restart" | "status" }

    start/restart wait (bounded by the task timeout, at most 5 min) until
    ComfyUI answers, so a completed result means it is ready for imggen tasks.
    The wait sends progress every ~15 s: an urgent task whose ``last_update``
    goes stale past its TTL (60 s by default) is expired server-side, and
    ComfyUI with a pile of custom nodes can take longer than that to boot.
    The orchestrator rescans after every slavemode task, which advertises or
    withdraws the ComfyUI-backed capabilities.
    """
    import time

    from offloadmq_agent.comfy_control import ACTIONS, request as comfy_request
    from offloadmq_agent.exec.reporting import report_progress, report_starting

    action = payload.get("action", "")
    if action not in ACTIONS:
        msg = f"'action' must be one of: {', '.join(ACTIONS)}"
        return report_result(transport, make_failure_report(task_id, capability, msg))

    logger.info(f"[slavemode] comfy-ctrl: {action}")
    try:
        status = comfy_request(action)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        logger.warning(f"[slavemode] comfy-ctrl {action}: {msg}")
        return report_result(transport, make_failure_report(task_id, capability, msg))

    if action in ("start", "restart"):
        wait_secs = max(10, min(job_timeout - 15, 300))
        report_starting(transport, task_id)
        report_progress(
            transport,
            log=f"ComfyUI {action}ed (pid {status.get('pid')}); waiting up to {wait_secs}s for it to answer\n",
            stage="starting",
            task_id=task_id,
        )
        started = time.monotonic()
        last_report = started
        crashed_polls = 0
        while status.get("state") != "running":
            if time.monotonic() - started > wait_secs:
                break
            # "crashed" is transient when restart-on-crash is on (it respawns
            # ~5 s later); only give up once it has stuck for a few polls.
            crashed_polls = crashed_polls + 1 if status.get("state") == "crashed" else 0
            if status.get("state") in ("stopped", "crash-loop") or crashed_polls >= 4:
                break
            time.sleep(3)
            status = comfy_request("status")
            if time.monotonic() - last_report >= 15:
                last_report = time.monotonic()
                tail = (status.get("output") or [""])[-1]
                report_progress(
                    transport,
                    log=f"[{time.monotonic() - started:.0f}s] {status.get('state')}: {tail}\n",
                    stage="starting",
                    task_id=task_id,
                )

    # The output tail is for the local UI; send only the last few lines.
    status = {**status, "output": list(status.get("output") or [])[-20:]}
    if action in ("start", "restart") and status.get("state") != "running":
        msg = (
            f"ComfyUI did not become ready (state: {status.get('state')}). "
            f"{status.get('lastError') or ''}".strip()
        )
        return report_result(transport, make_failure_report(task_id, capability, msg))
    return report_result(transport, make_success_report(task_id, capability, status))


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
        from offloadmq_agent.rescan import rescan_and_push

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
        from offloadmq_agent.rescan import rescan_and_push

        updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
        report = make_success_report(task_id, capability, {"deleted": name, "caps": updated_caps})
        return report_result(transport, report)

    msg = "Payload must contain one of: 'get', 'set', 'delete'"
    report = make_failure_report(task_id, capability, msg)
    return report_result(transport, report)


def _comfy_export(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Export ComfyUI workflows (graphs + configured node mappings) as portable bundles.

    Payload variants:
      {}                               — export every installed workflow
      { "workflow": "[ns.]<name>" }    — export one, e.g. "my-sdxl", "img-utils.depth"
    """
    from offloadmq_agent.comfy_workflows import export_all_workflows, export_workflow, parse_workflow_ref

    ref = payload.get("workflow")
    skipped: list[str] = []
    try:
        if ref is None:
            bundles, skipped = export_all_workflows()
        elif isinstance(ref, str) and ref.strip():
            name, namespace = parse_workflow_ref(ref)
            bundles = [export_workflow(name, namespace)]
        else:
            raise ValueError("'workflow' must be a non-empty string like 'my-sdxl' or 'img-utils.depth'")
    except (ValueError, OSError) as exc:  # FileNotFoundError is an OSError
        msg = f"Failed to export workflow(s): {exc}"
        logger.warning(f"[slavemode] comfy-export: {msg}")
        return report_result(transport, make_failure_report(task_id, capability, msg))

    logger.info(f"[slavemode] comfy-export: exported {len(bundles)} workflow(s), skipped {len(skipped)}")
    output: dict[str, Any] = {"bundles": bundles, "count": len(bundles)}
    if skipped:
        output["skipped"] = skipped
    report = make_success_report(task_id, capability, output)
    return report_result(transport, report)


def _comfy_import(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Install workflow bundles produced by ``slavemode.comfy-export``.

    Payload:
      { "bundles": [ {...}, ... ] }  or  { "bundle": {...} }
      "overwrite": bool              — replace task types that already exist (default false)
      "name": str, "namespace": str  — rename / re-namespace; single-bundle imports only

    Each bundle is fully validated before any of its files are written; a bad bundle does not
    stop the others, but any failure makes the task fail (the message lists what failed and
    what was imported).
    """
    from offloadmq_agent.comfy_workflows import import_workflow

    bundles = payload.get("bundles")
    if bundles is None and "bundle" in payload:
        bundles = [payload["bundle"]]
    if not isinstance(bundles, list) or not bundles:
        msg = "Payload must contain 'bundles' (non-empty list) or 'bundle' (object)"
        return report_result(transport, make_failure_report(task_id, capability, msg))
    name = payload.get("name") or ""
    namespace = payload.get("namespace")
    if not isinstance(name, str) or not (namespace is None or isinstance(namespace, str)):
        msg = "'name' and 'namespace' must be strings"
        return report_result(transport, make_failure_report(task_id, capability, msg))
    if (name or namespace is not None) and len(bundles) != 1:
        msg = "'name' / 'namespace' overrides apply to a single bundle only"
        return report_result(transport, make_failure_report(task_id, capability, msg))
    overwrite = bool(payload.get("overwrite"))

    imported: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, bundle in enumerate(bundles):
        label = (
            f"{bundle.get('namespace') or 'imggen'}.{bundle.get('name')}"
            if isinstance(bundle, dict)
            else f"bundle #{i + 1}"
        )
        try:
            imported.append(import_workflow(bundle, name, namespace, overwrite))
        except (ValueError, OSError) as exc:  # FileExistsError is an OSError
            errors.append(f"{label}: {exc}")
    for res in imported:
        logger.info(f"[slavemode] comfy-import: imported {res['namespace'] or 'imggen'}.{res['name']}")
    for err in errors:
        logger.warning(f"[slavemode] comfy-import: {err}")

    from offloadmq_agent.rescan import rescan_and_push

    updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg)) if imported else []
    if errors:
        done = ", ".join(f"{r['namespace'] or 'imggen'}.{r['name']}" for r in imported) or "none"
        msg = f"{len(errors)} of {len(bundles)} bundle(s) failed ({'; '.join(errors)}). Imported: {done}"
        return report_result(transport, make_failure_report(task_id, capability, msg))
    report = make_success_report(task_id, capability, {"imported": imported, "caps": updated_caps})
    return report_result(transport, report)


def _ollama_list(transport: AgentTransport, task_id: TaskId, capability: str) -> bool:
    """List installed Ollama models and return their metadata."""
    from offloadmq_agent.ollama import list_ollama_models_raw

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
    from offloadmq_agent.ollama import delete_ollama_model

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
    from offloadmq_agent.ollama import pull_ollama_model
    from offloadmq_agent.exec.reporting import TaskCancelled, report_cancelled, report_progress, report_starting

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
    from offloadmq_agent.rescan import rescan_and_push
    updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    report = make_success_report(task_id, capability, {"deleted": name, "caps": updated_caps})
    return report_result(transport, report)


def _onnx_models_prepare(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any]) -> bool:
    """Download an ONNX model with streaming progress updates.

    Payload: { "model": "<name>" }
    """
    from offloadmq_agent.exec.reporting import TaskCancelled, report_cancelled, report_progress, report_starting

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

    from offloadmq_agent.rescan import rescan_and_push
    updated_caps = rescan_and_push(transport, lambda msg: logger.info(msg))
    report = make_success_report(task_id, capability, {"prepared": name, "path": str(path), "caps": updated_caps})
    return report_result(transport, report)


def execute_slavemode(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
    job_timeout: int = 600,
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
        case "slavemode.agent-update":
            return _agent_update(transport, task_id, capability, payload)
        case "slavemode.comfy-ctrl":
            return _comfy_ctrl(transport, task_id, capability, payload, job_timeout)
        case "slavemode.comfy-export":
            return _comfy_export(transport, task_id, capability, payload)
        case "slavemode.comfy-import":
            return _comfy_import(transport, task_id, capability, payload)
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
