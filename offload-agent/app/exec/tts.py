import base64
import requests
from typing import Any
from ..models import *
from ..transport import AgentTransport
from .helpers import *
from pathlib import Path

KOKORO_API_URL = "https://localhost:8443/v1/audio/speech"  # adjust if needed
KOKORO_API_KEY = "your-api-key-hehehe"  # set if you use KW_SECRET_API_KEY

def execute_kokoro_tts(
    transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path
) -> bool:
    """Send TTS request to Kokoro-Web API (OpenAI-compatible).

    Expected payload: {
        "model": "model_q8f16",
        "voice": "af_heart",
        "input": "Hello world"
    }
    """
    try:
        if isinstance(payload, str):
            # default voice/model if payload is just text
            payload = {
                "model": "kokoro",
                "voice": "af_heart",
                "input": payload
            }
        elif isinstance(payload, dict):
            # Normalize legacy model names to Kokoro-FastAPI's OpenAI-compatible IDs
            valid_models = {"kokoro", "tts-1", "tts-1-hd"}
            if payload.get("model") not in valid_models:
                payload = {**payload, "model": "kokoro"}
            payload.setdefault("voice", "af_heart")

        # Check for cancellation before starting the (potentially slow) HTTP call.
        # TaskCancelled is raised here if the client already cancelled the task.
        report_progress(transport, log=None, stage="running", task_id=task_id)

        # Make request
        headers = {}
        if KOKORO_API_KEY:
            headers["Authorization"] = f"Bearer {KOKORO_API_KEY}"

        r = requests.post(KOKORO_API_URL, json=payload, headers=headers, timeout=3000, verify=False)
        r.raise_for_status()

        # Kokoro returns audio in binary; here we keep it raw
        report = make_success_report(task_id, capability, {
            "content_type": r.headers.get("Content-Type"),
            "audio_data_base64": base64.b64encode(r.content).decode("utf-8")
        })
    except TaskCancelled:
        report_cancelled(transport, task_id, capability)
        return True
    except requests.RequestException as e:
        response_text = "No response from server"
        resp = getattr(e, "response", None)
        if resp and hasattr(resp, "text"):
            response_text = resp.text
        extra = {
            "error": f"Kokoro API request failed: {e}",
            "response_text": response_text,
        }
        report = make_failure_report(
            task_id, capability, str(extra), extra_output=extra
        )
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(transport, report)
