import base64
import json
import logging
import requests
import time
from typing import Any
from ..models import *
from ..httphelpers import *
from ..data.text_extract import extract_texts_from_directory
from .helpers import *

from pathlib import Path

logger = logging.getLogger("agent")

# Image extensions that Ollama vision models accept directly via the `images` field.
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif"}


def _collect_image_attachments(data_path: Path) -> list[str]:
    """Scan the data directory for image files and return base64-encoded strings
    suitable for the Ollama ``images`` field."""
    attachments: list[str] = []
    if not data_path.exists():
        return attachments

    for f in sorted(data_path.iterdir()):
        if f.is_file() and f.suffix.lower() in _IMAGE_EXTENSIONS:
            raw = f.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
            logger.info(f"Attaching image {f.name} ({len(raw)} bytes)")
            attachments.append(b64)

    return attachments


def execute_llm_query(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path
) -> bool:
    """Send LLM request to local Ollama REST API (chat or generate style).

    This version supports both streaming and non-streaming responses.
    If 'stream' is True in the payload, it will buffer and print
    the response every 2 seconds before returning the full result.
    """
    try:
        model_name = capability.removeprefix("llm.").split("[")[0]

        # Wrap string prompts in the correct chat API format
        if isinstance(payload, str):
            payload = {"messages": [{"role": "user", "content": payload}]}

        # Convert generate-style payload (prompt/system) to chat messages
        if "messages" not in payload and ("prompt" in payload or "system" in payload):
            msgs: list[dict[str, Any]] = []
            if payload.get("system"):
                msgs.append({"role": "system", "content": payload["system"]})
            if payload.get("prompt"):
                msgs.append({"role": "user", "content": payload["prompt"]})
            payload = {k: v for k, v in payload.items() if k not in ("prompt", "system")}
            payload["messages"] = msgs

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

        # Attach downloaded files from the task data directory
        # 1) Text-extractable files (PDF, txt, etc.) → inject into prompt
        extracted_texts = extract_texts_from_directory(data)
        if extracted_texts:
            text_block = "\n\n".join(
                f"--- File: {name} ---\n{text}" for name, text in extracted_texts
            )
            msgs = converted_payload.get("messages", [])
            for msg in reversed(msgs):
                if msg.get("role") == "user":
                    msg["content"] = msg.get("content", "") + "\n\n" + text_block
                    break
            else:
                msgs.append({"role": "user", "content": text_block})
            converted_payload["messages"] = msgs

        # 2) Image files → base64 into Ollama images field
        image_attachments = _collect_image_attachments(data)
        if image_attachments:
            msgs = converted_payload.get("messages", [])
            for msg in reversed(msgs):
                if msg.get("role") == "user":
                    existing = msg.get("images", [])
                    msg["images"] = existing + image_attachments
                    break
            else:
                msgs.append({"role": "user", "content": "", "images": image_attachments})
            converted_payload["messages"] = msgs

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
            final_data: dict[str, Any] = {}
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
                        json_response: dict[str, Any] = json.loads(line)
                        msg = json_response.get("message", {})

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
                        if json_response.get("done"):
                            final_data = json_response
                            if buffer:
                                report_progress(
                                    http, log=buffer, stage="running", task_id=task_id
                                )

                    except json.JSONDecodeError:
                        # Skip malformed lines, sometimes headers are sent
                        continue

            # Construct the final response to match the non-streaming format
            if final_data:
                final_msg: dict[str, Any] = {"role": "assistant", "content": full_response_text}
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
        response_text = "No response from server"
        resp = getattr(e, "response", None)
        if resp and hasattr(resp, "text"):
            response_text = resp.text
        extra = {
            "error": f"Ollama API request failed: {e}",
            "response_text": response_text,
        }
        report = make_failure_report(
            task_id, capability, str(extra), extra_output=extra
        )
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(http, report)
