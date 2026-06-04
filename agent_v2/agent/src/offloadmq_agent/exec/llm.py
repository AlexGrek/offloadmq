"""llm.* executor — calls Ollama for local inference."""
from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path
from typing import Any

import aiohttp

from offloadmq_agent.context import ExecContext
from offloadmq_agent.data.task_inputs import stage_task_inputs
from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_agent.ollama import get_ollama_base_url

# Image extensions Ollama vision models accept via the per-message ``images`` field.
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif"}


def _collect_image_attachments(data_path: Path) -> list[str]:
    """Base64-encode every image file in ``data_path`` for Ollama's ``images`` field."""
    attachments: list[str] = []
    if not data_path.exists():
        return attachments
    for f in sorted(data_path.iterdir()):
        if f.is_file() and f.suffix.lower() in _IMAGE_EXTENSIONS:
            attachments.append(base64.b64encode(f.read_bytes()).decode("ascii"))
    return attachments


def _convert_openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten OpenAI-style multimodal ``content`` parts into Ollama's shape.

    A message whose ``content`` is a list of ``{type: text|image_url}`` parts is
    rewritten to a plain-text ``content`` plus an ``images`` list of base64 data.
    Plain-string messages pass through untouched.
    """
    converted: list[dict[str, Any]] = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            converted.append(msg)
            continue
        text_parts: list[str] = []
        images: list[str] = []
        for part in content:
            if part.get("type") == "text":
                text_parts.append(part.get("text", ""))
            elif part.get("type") == "image_url":
                url = part.get("image_url", {}).get("url", "")
                images.append(url.split(",", 1)[-1] if url.startswith("data:") else url)
        new_msg = {**msg, "content": "\n".join(text_parts)}
        if images:
            new_msg["images"] = images
        converted.append(new_msg)
    return converted


def _attach_images(messages: list[dict[str, Any]], images: list[str]) -> list[dict[str, Any]]:
    """Append ``images`` to the last user message (or create one if absent)."""
    if not images:
        return messages
    for msg in reversed(messages):
        if msg.get("role") == "user":
            msg["images"] = list(msg.get("images", [])) + images
            return messages
    messages.append({"role": "user", "content": "", "images": images})
    return messages


_STREAM_FLUSH_INTERVAL = 2.0  # seconds between progress log flushes, matching v1 behaviour


async def _stream_with_cancel(
    resp: aiohttp.ClientResponse,
    collected: list[str],
    ctx: ExecContext,
) -> bool:
    """Stream Ollama tokens, forwarding buffered text as progress logs every 2 s.

    Returns True if the cancel event fired before streaming completed,
    False on normal completion.  Mirrors the v1 ``execute_llm_query`` streaming
    path so callers (OAI chat, etc.) receive incremental text via task progress.
    """
    pending: list[str] = []
    last_flush: float = time.monotonic()

    async def _flush(force: bool = False) -> None:
        nonlocal last_flush
        now = time.monotonic()
        if pending and (force or now - last_flush >= _STREAM_FLUSH_INTERVAL):
            text = "".join(pending)
            pending.clear()
            last_flush = now
            await ctx.progress("running", text)

    async def _read() -> None:
        async for line in resp.content:
            chunk = line.strip()
            if not chunk:
                continue
            try:
                data: dict[str, Any] = json.loads(chunk)
                token: str = (
                    data.get("message", {}).get("content", "")
                    or data.get("response", "")
                )
                if token:
                    collected.append(token)
                    pending.append(token)
                    await _flush()
            except json.JSONDecodeError:
                pass
        # Flush any remaining buffered tokens when the stream ends normally.
        await _flush(force=True)

    async def _watch_cancel() -> None:
        while not ctx.cancel_event.is_set():
            await asyncio.sleep(0.1)

    read_task = asyncio.create_task(_read())
    watch_task = asyncio.create_task(_watch_cancel())

    try:
        done, _ = await asyncio.wait(
            {read_task, watch_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for t in (read_task, watch_task):
            if not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass

    if read_task in done:
        exc = read_task.exception()
        if exc is not None:
            raise exc
        return False

    # watch_task fired first → cancel event was set while still streaming.
    # Flush whatever we buffered so the partial text reaches the caller.
    if pending:
        await ctx.progress("running", "".join(pending))
    return True


@register("llm")
async def execute_llm(task: Task, ctx: ExecContext) -> TaskResult:
    # Strip extended capability attributes (e.g. "llm.qwen2.5vl:7b[vision]").
    model = task.capability.removeprefix("llm.").split("[", 1)[0]
    prompt: str = task.payload.get("prompt", "")
    messages: list[dict[str, Any]] = task.payload.get("messages", [])

    if not prompt and not messages:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error="Payload missing 'prompt' or 'messages'",
        )

    if not messages:
        messages = [{"role": "user", "content": prompt}]

    # Normalize OpenAI multimodal parts, then attach any images staged from the
    # task's input buckets (vision requests upload the image to a file_bucket).
    messages = _convert_openai_messages(messages)
    try:
        data_path = (
            await asyncio.to_thread(stage_task_inputs, task, ctx.agent_transport)
            if ctx.agent_transport is not None
            else None
        )
    except Exception as exc:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error=f"Failed to stage input files: {exc}",
        )
    image_attachments = _collect_image_attachments(data_path) if data_path else []
    if image_attachments:
        messages = _attach_images(messages, image_attachments)

    await ctx.progress(
        "generating", f"model={model}", messages=len(messages), images=len(image_attachments)
    )

    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    collected: list[str] = []

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{get_ollama_base_url()}/api/chat",
                json=body,
                timeout=aiohttp.ClientTimeout(total=600),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.FAILED,
                        error=f"Ollama error {resp.status}: {error_text}",
                    )
                if ctx.cancelled:
                    await ctx.warn("cancelled before streaming started")
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.CANCELLED,
                        error="Cancelled by user",
                    )
                was_cancelled = await _stream_with_cancel(resp, collected, ctx)
    except Exception as exc:
        return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=str(exc))

    if was_cancelled:
        await ctx.warn("cancelled — stopping generation")
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.CANCELLED,
            error="Cancelled by user",
            output={"partial": "".join(collected)},
        )

    full_text = "".join(collected)
    await ctx.progress("done", f"tokens≈{len(collected)}", tokens=len(collected))
    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={
            "model": model,
            "message": {"role": "assistant", "content": full_text},
            "done": True,
        },
    )
