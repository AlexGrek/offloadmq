#!/usr/bin/env python3
"""
Batch image description via OffloadMQ vision LLM.

Each image is uploaded to a temporary storage bucket, submitted as a vision
task, polled until completion, and the description printed immediately.
All results are saved to a JSON file at the end.

If --model is omitted the script discovers all online vision-capable LLM
capabilities and automatically picks the largest one by parameter count.

Usage:
    python describe-images-batch.py \\
        --url http://localhost:3069 \\
        --api-key client_secret_key_123 \\
        image1.jpg image2.png dir/*.webp

    # Explicit model, custom prompt:
    python describe-images-batch.py \\
        --url http://localhost:3069 --api-key ... \\
        --model llava:13b \\
        --prompt "List every object visible in this image." \\
        --output results.json \\
        photos/*.jpg
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TERMINAL_STATUSES = {"completed", "failed", "canceled"}

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}


def expand_paths(paths: list[Path]) -> list[Path]:
    """Expand directories recursively into image files; pass through plain file paths."""
    result: list[Path] = []
    for p in paths:
        if p.is_dir():
            result.extend(sorted(f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS))
        else:
            result.append(p)
    return result


DEFAULT_PROMPT = "Describe this image in detail."
DEFAULT_SYSTEM_PROMPT = "You are a helpful visual analysis assistant. Describe images clearly and thoroughly."
DEFAULT_OUTPUT = "describe-result.json"
DEFAULT_POLL_INTERVAL = 2.0  # seconds

# ---------------------------------------------------------------------------
# Capability helpers  (ported from management-frontend/src/utils.js and ModelSelector.jsx)
# ---------------------------------------------------------------------------


def _strip_attrs(cap: str) -> str:
    idx = cap.find("[")
    return cap if idx == -1 else cap[:idx]


def _parse_attrs(cap: str) -> list[str]:
    start, end = cap.find("["), cap.rfind("]")
    if start == -1 or end <= start:
        return []
    return [a for a in cap[start + 1 : end].split(";") if a]


def _parse_model_size_b(cap: str) -> float | None:
    """Return model size in billions of parameters, or None if not detectable."""
    for attr in _parse_attrs(cap):
        m = re.match(r"^size:(\d+(?:\.\d+)?)\s*([gmk])?b?$", attr, re.I)
        if m:
            val, unit = float(m.group(1)), (m.group(2) or "g").lower()
            if unit == "g":
                return val
            if unit == "m":
                return val / 1000
            if unit == "k":
                return val / 1_000_000
        m = re.match(r"^(\d+(?:\.\d+)?)b$", attr, re.I)
        if m:
            return float(m.group(1))
    m = re.search(r"[:-](\d+(?:\.\d+)?)b(?:\b|$)", _strip_attrs(cap), re.I)
    return float(m.group(1)) if m else None


def fetch_vision_capabilities(base_url: str, api_key: str) -> list[str]:
    """Return all online llm.* capabilities that advertise the 'vision' attribute."""
    resp = requests.post(
        f"{base_url}/api/capabilities/list/online_ext",
        json={"apiKey": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    all_caps: list[str] = resp.json()
    return [
        c for c in all_caps
        if c.startswith("llm.") and "vision" in _parse_attrs(c)
    ]


def pick_largest_vision_cap(caps: list[str]) -> str:
    """Return the vision capability with the most parameters; ties broken by name."""
    return max(caps, key=lambda c: (_parse_model_size_b(c) or 0.0, _strip_attrs(c)))


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------


def create_bucket(base_url: str, api_key: str) -> str:
    resp = requests.post(
        f"{base_url}/api/storage/bucket/create",
        params={"rm_after_task": "true"},
        headers={"X-API-Key": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    return str(resp.json()["bucket_uid"])


def upload_file(base_url: str, api_key: str, bucket_uid: str, file_path: Path) -> None:
    with open(file_path, "rb") as fh:
        resp = requests.post(
            f"{base_url}/api/storage/bucket/{bucket_uid}/upload",
            headers={"X-API-Key": api_key},
            files={"file": (file_path.name, fh, "application/octet-stream")},
            timeout=120,
        )
    resp.raise_for_status()


def delete_bucket(base_url: str, api_key: str, bucket_uid: str) -> None:
    try:
        requests.delete(
            f"{base_url}/api/storage/bucket/{bucket_uid}",
            headers={"X-API-Key": api_key},
            timeout=30,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Task helpers
# ---------------------------------------------------------------------------


def submit_task(
    base_url: str,
    api_key: str,
    capability: str,
    bucket_uid: str,
    prompt: str,
    system_prompt: str,
    urgent: bool,
    timeout: float,
) -> dict[str, Any]:
    """
    Urgent mode: POST /api/task/submit_blocking — blocks until done, returns final task.
    Non-urgent:  POST /api/task/submit          — returns immediately with {id, status}.
    """
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    body: dict[str, Any] = {
        "apiKey": api_key,
        "capability": capability,
        "urgent": urgent,
        "restartable": not urgent,
        "fetchFiles": [],
        "file_bucket": [bucket_uid],
        "artifacts": [],
        "payload": {"stream": False, "messages": messages},
    }
    endpoint = "submit_blocking" if urgent else "submit"
    resp = requests.post(f"{base_url}/api/task/{endpoint}", json=body, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def cancel_task(base_url: str, api_key: str, cap: str, task_id: str) -> None:
    try:
        encoded_cap = quote(cap, safe=".:")
        requests.post(
            f"{base_url}/api/task/cancel/{encoded_cap}/{task_id}",
            json={"apiKey": api_key},
            timeout=10,
        )
    except Exception:
        pass


def poll_until_done(
    base_url: str,
    api_key: str,
    cap: str,
    task_id: str,
    poll_interval: float,
    timeout: float,
) -> dict[str, Any]:
    encoded_cap = quote(cap, safe=".:")
    url = f"{base_url}/api/task/poll/{encoded_cap}/{task_id}"
    deadline = time.monotonic() + timeout
    try:
        while True:
            resp = requests.post(url, json={"apiKey": api_key}, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if data.get("status", "") in TERMINAL_STATUSES:
                return data
            if time.monotonic() >= deadline:
                raise TimeoutError(f"task {cap}/{task_id} did not finish within {timeout:.0f}s")
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        print(f"\nCancelling task {task_id} ...", flush=True)
        cancel_task(base_url, api_key, cap, task_id)
        raise


# ---------------------------------------------------------------------------
# Result parsing
# ---------------------------------------------------------------------------


def extract_description(output: Any) -> tuple[bool, str]:
    """
    Return (ok, text) from the LLM output object.

    Handles both chat format (output.message.content) and
    generate format (output.response).
    """
    if not isinstance(output, dict):
        return False, f"unexpected output type: {type(output).__name__}"
    if "error" in output:
        return False, str(output["error"])
    if isinstance(output.get("message"), dict):
        content = output["message"].get("content", "")
        return bool(content), content or "(empty response)"
    if "response" in output:
        return True, str(output["response"])
    return True, json.dumps(output, indent=2)


# ---------------------------------------------------------------------------
# ETA tracking
# ---------------------------------------------------------------------------


def _fmt_duration(seconds: float) -> str:
    m, s = divmod(int(max(0.0, seconds)), 60)
    return f"{m}m {s:02d}s" if m else f"{s}s"


class Progress:
    """Tracks rolling-average ETA after each image."""

    def __init__(self, total: int, batch_start: float) -> None:
        self._total = total
        self._batch_start = batch_start
        self._done = 0

    def record(self) -> str:
        self._done += 1
        elapsed = time.monotonic() - self._batch_start
        remaining = self._total - self._done
        if remaining <= 0:
            return f"{self._done}/{self._total} done"
        avg = elapsed / self._done
        return (
            f"{self._done}/{self._total} done — "
            f"avg {_fmt_duration(avg)}/img — "
            f"~{_fmt_duration(avg * remaining)} remaining"
        )


# ---------------------------------------------------------------------------
# Per-image pipeline
# ---------------------------------------------------------------------------


def describe_image(
    base_url: str,
    api_key: str,
    capability: str,
    urgent: bool,
    timeout: float,
    file_path: Path,
    prompt: str,
    system_prompt: str,
    poll_interval: float,
    index: int,
    total: int,
) -> dict[str, Any]:
    tag = f"[{index}/{total}] {file_path.name}"

    print(f"{tag}: uploading ...", flush=True)
    bucket_uid = create_bucket(base_url, api_key)
    try:
        upload_file(base_url, api_key, bucket_uid, file_path)
    except Exception:
        delete_bucket(base_url, api_key, bucket_uid)
        raise

    print(f"{tag}: {'blocking submit ...' if urgent else 'submitted, waiting for result ...'}", flush=True)
    submit_resp = submit_task(base_url, api_key, capability, bucket_uid, prompt, system_prompt, urgent, timeout)
    cap: str = submit_resp["id"]["cap"]
    task_id: str = submit_resp["id"]["id"]

    # Urgent: submit_blocking already returned the finished task.
    # Non-urgent: poll until terminal state.
    final = submit_resp if urgent else poll_until_done(base_url, api_key, cap, task_id, poll_interval, timeout)
    status: str = final.get("status", "unknown")
    raw_output = final.get("output") or final.get("result")

    if status == "completed":
        ok, description = extract_description(raw_output)
        if ok:
            preview = description[:120].replace("\n", " ")
            print(f"{tag}: DONE  {preview!r}", flush=True)
        else:
            print(f"{tag}: FAILED  {description[:200]}", flush=True)
            status = "failed"
    elif status == "failed":
        err = (
            raw_output.get("error", str(raw_output))
            if isinstance(raw_output, dict)
            else str(raw_output)
        )
        description = err
        print(f"{tag}: FAILED  {err[:200]}", flush=True)
    else:
        description = f"unexpected terminal status: {status}"
        print(f"{tag}: {status.upper()}", flush=True)

    return {
        "file": str(file_path),
        "filename": file_path.name,
        "status": status,
        "task_id": task_id,
        "capability": cap,
        "description": description if status == "completed" else None,
        "error": description if status != "completed" else None,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Batch image description via OffloadMQ vision LLM.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--url",
        required=True,
        metavar="URL",
        help="OffloadMQ server base URL (e.g. http://localhost:3069)",
    )
    parser.add_argument(
        "--api-key",
        required=True,
        dest="api_key",
        metavar="KEY",
        help="Client API key",
    )
    parser.add_argument(
        "--model",
        default=None,
        metavar="MODEL",
        help=(
            "Vision model to use, e.g. 'llava:13b'. "
            "Omit to auto-select the largest online vision model."
        ),
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        metavar="TEXT",
        help=f"User prompt sent with each image (default: {DEFAULT_PROMPT!r})",
    )
    parser.add_argument(
        "--system-prompt",
        default=DEFAULT_SYSTEM_PROMPT,
        dest="system_prompt",
        metavar="TEXT",
        help="System prompt (pass empty string to omit)",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        metavar="FILE",
        help=f"Output JSON file path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=DEFAULT_POLL_INTERVAL,
        dest="poll_interval",
        metavar="SECS",
        help=f"Seconds between status polls (default: {DEFAULT_POLL_INTERVAL})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=600.0,
        metavar="SECS",
        help="Max seconds to wait per image (default: 600)",
    )
    parser.add_argument(
        "--urgent",
        action="store_true",
        default=False,
        help="Use blocking submit (waits up to 60s inline); default is non-urgent with polling",
    )
    parser.add_argument(
        "-r", "--recursive",
        action="store_true",
        default=False,
        help="Recursively scan directories for image files (required when a directory is passed)",
    )
    parser.add_argument("files", nargs="+", metavar="FILE|DIR", help="Image files or directories to describe")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    base_url: str = args.url.rstrip("/")
    input_paths = [Path(f).resolve() for f in args.files]

    missing = [p for p in input_paths if not p.exists()]
    if missing:
        for m in missing:
            print(f"error: path not found: {m}", file=sys.stderr)
        sys.exit(1)

    dirs = [p for p in input_paths if p.is_dir()]
    if dirs and not args.recursive:
        for d in dirs:
            print(f"error: {d} is a directory — use -r to scan recursively", file=sys.stderr)
        sys.exit(1)

    file_paths = expand_paths(input_paths)
    if not file_paths:
        print("error: no image files found", file=sys.stderr)
        sys.exit(1)

    # Resolve capability
    if args.model:
        capability = f"llm.{args.model}"
        print(f"Using model: {args.model}")
    else:
        print("Discovering online vision capabilities ...", flush=True)
        vision_caps = fetch_vision_capabilities(base_url, args.api_key)
        if not vision_caps:
            print("error: no online vision-capable LLM agents found", file=sys.stderr)
            sys.exit(1)
        capability = _strip_attrs(pick_largest_vision_cap(vision_caps))
        model_name = capability.removeprefix("llm.")
        size = _parse_model_size_b(pick_largest_vision_cap(vision_caps))
        size_str = f"  ({size}b params)" if size else ""
        print(f"Auto-selected model: {model_name}{size_str}")
        if len(vision_caps) > 1:
            others = ", ".join(_strip_attrs(c).removeprefix("llm.") for c in vision_caps if _strip_attrs(c) != capability)
            print(f"Other available: {others}")

    total = len(file_paths)
    mode = "urgent (blocking)" if args.urgent else "non-urgent (polling)"
    print(f"Analyzing {total} image(s) via {capability}  mode={mode}")
    print(f"Server: {base_url}")
    print()

    results: list[dict[str, Any]] = []
    progress = Progress(total, time.monotonic())

    for i, fp in enumerate(file_paths, 1):
        try:
            result = describe_image(
                base_url,
                args.api_key,
                capability,
                args.urgent,
                args.timeout,
                fp,
                args.prompt,
                args.system_prompt,
                args.poll_interval,
                i,
                total,
            )
        except KeyboardInterrupt:
            print(f"\nInterrupted. Stopping after {i - 1}/{total} image(s).", flush=True)
            break
        except Exception as exc:
            print(f"[{i}/{total}] {fp.name}: ERROR  {exc}", flush=True)
            result = {
                "file": str(fp),
                "filename": fp.name,
                "status": "error",
                "description": None,
                "error": str(exc),
                "analyzed_at": datetime.now(timezone.utc).isoformat(),
            }
        results.append(result)
        print(f"  {progress.record()}", flush=True)

    completed = sum(1 for r in results if r["status"] == "completed")
    failed = total - completed
    print()
    print(f"Summary: {completed}/{total} completed, {failed} failed/errored")

    output_doc: dict[str, Any] = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "server": base_url,
        "capability": capability,
        "prompt": args.prompt,
        "system_prompt": args.system_prompt,
        "total": total,
        "completed": completed,
        "failed": failed,
        "results": results,
    }
    Path(args.output).write_text(json.dumps(output_doc, indent=2))
    print(f"Results saved to: {args.output}")


if __name__ == "__main__":
    main()
