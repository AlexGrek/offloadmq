"""imggen task executor — entry point for ComfyUI-backed image/video generation."""

from pathlib import Path
from typing import Any

import requests

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.reporting import TaskCancelled, make_failure_report, make_success_report, report_cancelled, report_progress, report_result
from .comfyui import queue_prompt, wait_for_completion
from .workflow import load_workflow_template, inject_params, build_injection_values
from .output import build_output


def execute_imggen_comfyui(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Execute an imggen task via ComfyUI.

    capability format: imggen.<workflow-name>  (base, no brackets)
    payload: see docs/comfy-api.md
    """
    try:
        if not output_bucket:
            raise ValueError(
                "imggen tasks require an 'output_bucket' field — "
                "create a bucket via the client storage API and pass its UID in the task"
            )

        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")

        task_type = payload.get("workflow")
        if not task_type:
            raise ValueError("Payload missing required 'workflow' field")

        workflow_name = capability.removeprefix("imggen.")
        if not workflow_name or workflow_name == capability:
            raise ValueError(f"Capability '{capability}' is not a valid imggen capability")

        graph, param_map = load_workflow_template(workflow_name, task_type)
        inject_values = build_injection_values(payload, task_type, data_path)
        graph = inject_params(graph, param_map, inject_values)

        prompt_id = queue_prompt(graph, transport, task_id)
        report_progress(transport, f"Queued as prompt_id={prompt_id}", "queued", task_id)

        history_entry = wait_for_completion(prompt_id, transport, task_id)
        report_progress(transport, "Generation complete — collecting output", "collecting", task_id)

        seed = inject_values.get("seed") or payload.get("seed")
        output = build_output(history_entry, task_type, prompt_id, seed, transport, output_bucket, task_id)
        report = make_success_report(task_id, capability, output)

    except TaskCancelled:
        report_cancelled(transport, task_id, capability, output={"cancelled": True})
        return True

    except requests.RequestException as e:
        resp = getattr(e, "response", None)
        response_body = resp.text.strip() if resp is not None else "no response"
        error_msg = str(e)
        log_line = f"HTTP error: {error_msg}"
        if response_body and response_body != "no response":
            log_line += f"\nServer response: {response_body}"
        report_progress(transport, log=log_line, stage="failed", task_id=task_id)
        extra = {
            "error": error_msg,
            "response_body": response_body,
        }
        report = make_failure_report(task_id, capability, error_msg, extra_output=extra)
    except Exception as e:
        error_msg = str(e)
        report_progress(transport, log=f"Task failed: {error_msg}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, error_msg)

    return report_result(transport, report)
