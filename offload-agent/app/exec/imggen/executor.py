"""imggen task executor — entry point for ComfyUI-backed image/video generation."""

from pathlib import Path
from typing import Any

import requests

from ...models import TaskId
from ...httphelpers import HttpClient
from ..helpers import TaskCancelled, make_failure_report, make_success_report, report_cancelled, report_progress, report_result
from .comfyui import queue_prompt, wait_for_completion
from .workflow import load_workflow_template, inject_params, build_injection_values
from .output import build_output


def execute_imggen_comfyui(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
) -> bool:
    """Execute an imggen task via ComfyUI.

    capability format: imggen.<workflow-name>  (base, no brackets)
    payload: see docs/imggen-api.md
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

        prompt_id = queue_prompt(graph)
        report_progress(http, f"Queued as prompt_id={prompt_id}", "queued", task_id)

        history_entry = wait_for_completion(prompt_id, http, task_id)
        report_progress(http, "Generation complete — collecting output", "collecting", task_id)

        seed = inject_values.get("seed") or payload.get("seed")
        output = build_output(history_entry, task_type, prompt_id, seed, http, output_bucket)
        report = make_success_report(task_id, capability, output)

    except TaskCancelled:
        report_cancelled(http, task_id, capability, output={"cancelled": True})
        return True

    except requests.RequestException as e:
        response_text = "No response from server"
        resp = getattr(e, "response", None)
        if resp and hasattr(resp, "text"):
            response_text = resp.text
        extra = {
            "error": f"ComfyUI API request failed: {e}",
            "response_text": response_text,
        }
        report = make_failure_report(task_id, capability, str(e), extra_output=extra)
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(http, report)
