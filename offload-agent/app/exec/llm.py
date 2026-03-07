import logging
from ..models import *
from ..httphelpers import *
from .helpers import *

from pathlib import Path

logger = logging.getLogger("agent")


def execute_llm_query(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict, data: Path
) -> bool:
    """Send LLM request to local Ollama REST API (chat or generate style).

    This version supports both streaming and non-streaming responses.
    If 'stream' is True in the payload, it will buffer and print
    the response every 2 seconds before returning the full result.
    """
    try:
        model_name = capability.removeprefix("llm.")

        # Wrap string prompts in the correct chat API format
        if isinstance(payload, str):
            payload = {"messages": [{"role": "user", "content": payload}]}

        # Convert OpenAI-style messages to Ollama format (handles image_url content parts)
        converted_messages = []
        for msg in payload.get("messages", []):
            content = msg.get("content")
            if isinstance(content, list):
                text_parts = []
                images = []
                for part in content:
                    if part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                    elif part.get("type") == "image_url":
                        url = part.get("image_url", {}).get("url", "")
                        if url.startswith("data:"):
                            # Strip the data URI prefix, keep only base64 payload
                            b64 = url.split(",", 1)[-1]
                        else:
                            b64 = url
                        images.append(b64)
                new_msg = {**msg, "content": "\n".join(text_parts)}
                if images:
                    new_msg["images"] = images
                converted_messages.append(new_msg)
            else:
                converted_messages.append(msg)

        converted_payload = {**payload}
        if converted_messages:
            converted_payload["messages"] = converted_messages

        # Construct payload for Ollama chat/generate API
        api_payload = {**converted_payload, "model": model_name}

        logger.info(f"Sending to Ollama ({OLLAMA_API_URL}): {api_payload}")

        # Check if streaming is enabled
        is_streaming = api_payload.get("stream", False)

        if is_streaming:
            logger.info("Streaming enabled. Buffering and printing every 2 seconds...")
            full_response_text = ""
            buffer = ""
            last_print_time = time.time()
            final_data = {}
            tool_calls = None

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
                        msg = data.get("message", {})

                        # Accumulate text content
                        if "content" in msg:
                            content = msg["content"]
                            buffer += content
                            full_response_text += content

                        # Capture tool_calls if present
                        if "tool_calls" in msg:
                            tool_calls = msg["tool_calls"]

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
                final_msg: dict = {"role": "assistant", "content": full_response_text}
                if tool_calls:
                    final_msg["tool_calls"] = tool_calls
                final_response = {
                    "model": final_data.get("model"),
                    "created_at": final_data.get("created_at"),
                    "message": final_msg,
                    "done": True,
                    "done_reason": final_data.get("done_reason", "stop"),
                    "total_duration": final_data.get("total_duration"),
                }
            else:
                final_response = {}  # Stream ended unexpectedly

            logger.info(f"Final streamed response: {final_response}")
            report = make_success_report(task_id, capability, final_response)

        else:
            # Original non-streaming logic
            logger.info("Streaming is not enabled. Waiting for full response...")
            r = requests.post(OLLAMA_API_URL, json=api_payload, timeout=300)
            logger.info(f"Ollama response status: {r.status_code}")
            logger.info(f"Ollama response body: {r.text[:2000]}")
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
