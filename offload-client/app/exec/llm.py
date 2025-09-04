from ..models import *
from ..httphelpers import *
from .helpers import *


def execute_llm_query(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict
) -> bool:
    """Send LLM request to local Ollama REST API (chat or generate style).

    This version supports both streaming and non-streaming responses.
    If 'stream' is True in the payload, it will buffer and print
    the response every 2 seconds before returning the full result.
    """
    try:
        model_name = capability.split("::")[-1]

        # Wrap string prompts in the correct chat API format
        if isinstance(payload, str):
            payload = {"messages": [{"role": "user", "content": payload}]}

        # Construct payload for Ollama chat/generate API
        api_payload = {**payload, "model": model_name}

        # Check if streaming is enabled
        is_streaming = api_payload.get("stream", False)

        if is_streaming:
            print("Streaming enabled. Buffering and printing every 2 seconds...")
            full_response_text = ""
            buffer = ""
            last_print_time = time.time()
            final_data = {}

            # Make the request with streaming enabled
            r = requests.post(
                OLLAMA_API_URL, json=api_payload, stream=True, timeout=300
            )
            r.raise_for_status()

            # Process the streamed response line by line
            for line in r.iter_lines(decode_unicode=True):
                if line.strip():
                    try:
                        data = json.loads(line)
                        # Accumulate content in the buffer
                        if "content" in data.get("message", {}):
                            content = data["message"]["content"]
                            buffer += content
                            full_response_text += content

                        # Print buffered content every 2 seconds
                        current_time = time.time()
                        if current_time - last_print_time >= 2:
                            report_progress(
                                http, log=buffer, stage="running", task_id=task_id
                            )
                            buffer = ""
                            last_print_time = current_time

                        # Capture the final 'done' response for metadata
                        if data.get("done"):
                            final_data = data
                            if buffer:
                                report_progress(
                                    http, log=buffer, stage="running", task_id=task_id
                                )

                    except json.JSONDecodeError:
                        # Skip malformed lines, sometimes headers are sent
                        continue

            # Construct the final response to match the non-streaming format
            if final_data:
                final_response = {
                    "model": final_data.get("model"),
                    "created_at": final_data.get("created_at"),
                    "message": {"role": "assistant", "content": full_response_text},
                    "done": True,
                    "total_duration": final_data.get("total_duration"),
                }
            else:
                final_response = (
                    {}
                )  # Or handle as an error if the stream ended unexpectedly

            report = make_success_report(task_id, capability, final_response)

        else:
            # Original non-streaming logic
            print("Streaming is not enabled. Waiting for full response...")
            r = requests.post(OLLAMA_API_URL, json=api_payload, timeout=300)
            r.raise_for_status()
            report = make_success_report(task_id, capability, r.json())

    except requests.RequestException as e:
        extra = {
            "error": f"Ollama API request failed: {e}",
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
