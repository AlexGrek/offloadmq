from ..models import *
from ..httphelpers import *
from .helpers import *

def execute_llm_query(http: HttpClient, task_id: TaskId, capability: str, payload: dict) -> bool:
    """Send LLM request to local Ollama REST API (chat or generate style).

    Preserves the original logic/intent but fixes a bug where the constructed payload
    was not sent. We forward the user's payload directly if it already matches Ollama,
    otherwise we wrap it with model/prompt.
    """
    try:
        model_name = capability.split("::")[-1]
        # Prefer 'prompt'; fall back to the payload itself if it's a string
        prompt = None
        if isinstance(payload, dict):
            prompt = payload.get("prompt") or payload.get("query")
        elif isinstance(payload, str):
            prompt = payload
            payload = {"prompt": prompt}

        if not prompt:
            report = make_failure_report(task_id, capability, "No 'prompt' or 'query' provided in LLM payload.")
            return report_result(http, report)

        # Construct payload for Ollama chat/generate API. Keep it simple and compatible.
        api_payload = {"model": model_name, "prompt": prompt, "stream": False}
        # If caller already provided additional ollama params, merge conservatively
        if isinstance(payload, dict):
            for k in ("options", "images", "context", "system"):
                if k in payload:
                    api_payload[k] = payload[k]

        r = requests.post(OLLAMA_API_URL, json=api_payload, timeout=300)
        r.raise_for_status()
        report = make_success_report(task_id, capability, r.json())
    except requests.RequestException as e:
        extra = {"error": f"Ollama API request failed: {e}", "response_text": (getattr(e, 'response', None).text if getattr(e, 'response', None) else "No response from server")}
        report = make_failure_report(task_id, capability, str(extra), extra_output=extra)
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(http, report)

