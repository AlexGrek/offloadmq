import base64
from ..models import *
from ..httphelpers import *
from .helpers import *
from pathlib import Path

KOKORO_API_URL = "http://192.168.0.191:4069/api/v1/audio/speech"  # adjust if needed
KOKORO_API_KEY = "your-api-key-hehehe"  # set if you use KW_SECRET_API_KEY

def execute_kokoro_tts(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict, data: Path
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
                "model": "model_q8f16",
                "voice": "af_heart",
                "input": payload
            }
        # Make request
        headers = {}
        if KOKORO_API_KEY:
            headers["Authorization"] = f"Bearer {KOKORO_API_KEY}"

        r = requests.post(KOKORO_API_URL, json=payload, headers=headers, timeout=3000)
        r.raise_for_status()

        # Kokoro returns audio in binary; here we keep it raw
        report = make_success_report(task_id, capability, {
            "content_type": r.headers.get("Content-Type"),
            "audio_data_base64": base64.b64encode(r.content).decode("utf-8")
        })
    except requests.RequestException as e:
        extra = {
            "error": f"Kokoro API request failed: {e}",
            "response_text": (
                getattr(e, "response", None).text
                if getattr(e, "response", None)
                else "No response from server"
            ),
        }
        report = make_failure_report(
            task_id, capability, str(extra), extra_output=extra
        )
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(http, report)
