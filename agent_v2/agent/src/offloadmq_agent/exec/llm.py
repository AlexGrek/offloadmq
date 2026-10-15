"""llm.* executor — calls Ollama for local inference."""
from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass, field
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

# Ollama /api/chat request fields taken from the task payload as-is. The
# server's OpenRouter-compatible API (/api/v1) translates OpenAI parameters
# into exactly these (sampling → options, response_format → format, ...).
_FORWARDED_KEYS = ("options", "format", "tools", "think", "keep_alive")

# Final-chunk fields copied into the task output (usage + stop reason).
_DONE_KEYS = ("done_reason", "prompt_eval_count", "eval_count", "total_duration")


@dataclass
class _StreamExtras:
    """Everything in the Ollama stream besides the answer text."""

    thinking: list[str] = field(default_factory=list)
    tool_calls: list[Any] = field(default_factory=list)
    done: dict[str, Any] = field(default_factory=dict)


async def _stream_with_cancel(
    resp: aiohttp.ClientResponse,
    collected: list[str],
    ctx: ExecContext,
    extras: _StreamExtras | None = None,
) -> bool:
    """Stream Ollama tokens, forwarding buffered text as progress logs every 2 s.

    Returns True if the cancel event fired before streaming completed,
    False on normal completion.  Mirrors the v1 ``execute_llm_query`` streaming
    path so callers (OAI chat, etc.) receive incremental text via task progress.
    Only answer text goes to the progress log; reasoning (``thinking``), tool
    calls and the final chunk's usage fields are collected into ``extras``.
    """
    if extras is None:
        extras = _StreamExtras()
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
            except json.JSONDecodeError:
                continue
            if data.get("error"):
                raise RuntimeError(f"Ollama error: {data['error']}")
            message: dict[str, Any] = data.get("message") or {}
            token: str = message.get("content", "") or data.get("response", "")
            if token:
                collected.append(token)
                pending.append(token)
                await _flush()
            if message.get("thinking"):
                extras.thinking.append(message["thinking"])
            if message.get("tool_calls"):
                extras.tool_calls.extend(message["tool_calls"])
            if data.get("done"):
                extras.done = {k: data[k] for k in _DONE_KEYS if k in data}
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

    # Local diagnostic only (mirrors v1's logger.info before streaming): not
    # forwarded to the task's server-side progress, so the streamed logs carry
    # only the LLM response text — never a "model=" line.
    await ctx.info(
        "generating", model=model, messages=len(messages), images=len(image_attachments)
    )

    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    for key in _FORWARDED_KEYS:
        if key in task.payload:
            body[key] = task.payload[key]
    collected: list[str] = []
    extras = _StreamExtras()

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
                # Flip the server-side status to `running` the moment Ollama
                # starts responding, instead of waiting for the first buffered
                # token flush (up to 2 s of generation away, and much longer
                # when the model still has to load). Empty message → no log
                # update, so the streamed reply text stays clean.
                await ctx.progress("running", "")
                was_cancelled = await _stream_with_cancel(resp, collected, ctx, extras)
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
    # Local diagnostic only — like v1, the stream itself is the server-side
    # progress, so the final result (resolve) is the only thing that follows it.
    await ctx.info("done", tokens=len(collected))
    reply: dict[str, Any] = {"role": "assistant", "content": full_text}
    if extras.thinking:
        reply["thinking"] = "".join(extras.thinking)
    if extras.tool_calls:
        reply["tool_calls"] = extras.tool_calls
    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={"model": model, "message": reply, "done": True, **extras.done},
    )
