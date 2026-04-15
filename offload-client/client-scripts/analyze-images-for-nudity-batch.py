#!/usr/bin/env python3
"""
Batch nudity / explicit-content analysis via OffloadMQ onnx.nudenet capability.

Each image is uploaded to a temporary storage bucket, submitted as an ONNX
detection task, polled until completion, and the result printed immediately.
All results are saved to a JSON file at the end.

Usage:
    python analyze-images-for-nudity-batch.py \\
        --url http://localhost:3069 \\
        --api-key client_secret_key_123 \\
        image1.jpg image2.png dir/*.webp

    # Custom threshold:
    python analyze-images-for-nudity-batch.py \\
        --url http://localhost:3069 --api-key ... \\
        --threshold 0.3 --output results.json \\
        photos/*.jpg
"""

from __future__ import annotations

import argparse
import json
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

CAPABILITY = "onnx.nudenet"
DEFAULT_THRESHOLD = 0.25
DEFAULT_OUTPUT = "nudity-result.json"
DEFAULT_POLL_INTERVAL = 2.0  # seconds

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
    bucket_uid: str,
    threshold: float,
    urgent: bool,
    timeout: float,
) -> dict[str, Any]:
    """
    Urgent mode: POST /api/task/submit_blocking — blocks until done, returns final task.
    Non-urgent:  POST /api/task/submit          — returns immediately with {id, status}.
    """
    body: dict[str, Any] = {
        "apiKey": api_key,
        "capability": CAPABILITY,
        "urgent": urgent,
        "restartable": not urgent,
        "fetchFiles": [],
        "file_bucket": [bucket_uid],
        "artifacts": [],
        "payload": {"threshold": threshold},
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


def parse_detections(output: Any) -> dict[str, Any]:
    if not isinstance(output, dict):
        return {"parse_error": f"unexpected output type: {type(output).__name__}"}
    if "error" in output:
        return {"agent_error": str(output["error"])}

    results = output.get("results", [])
    if not results:
        return {"parse_error": "no results in output", "raw": output}

    # One image per task → exactly one entry.
    image_result = results[0]
    detections = image_result.get("detections", [])
    detection_count = image_result.get("detection_count", len(detections))

    return {
        "has_nudity": detection_count > 0,
        "detection_count": detection_count,
        "threshold": output.get("threshold", DEFAULT_THRESHOLD),
        "detections": detections,
    }


def _top_labels(detections: list[dict[str, Any]], n: int = 3) -> str:
    """Return the top-N labels by confidence as a compact string."""
    sorted_d = sorted(detections, key=lambda d: d.get("confidence", 0.0), reverse=True)
    parts = [
        f"{d['label']}({d['confidence']:.2f})"
        for d in sorted_d[:n]
        if "label" in d
    ]
    return ", ".join(parts) if parts else "(none)"


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


def analyze_image(
    base_url: str,
    api_key: str,
    threshold: float,
    urgent: bool,
    timeout: float,
    file_path: Path,
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
    submit_resp = submit_task(base_url, api_key, bucket_uid, threshold, urgent, timeout)
    cap: str = submit_resp["id"]["cap"]
    task_id: str = submit_resp["id"]["id"]

    # Urgent: submit_blocking already returned the finished task.
    # Non-urgent: poll until terminal state.
    final = submit_resp if urgent else poll_until_done(base_url, api_key, cap, task_id, poll_interval, timeout)
    status: str = final.get("status", "unknown")
    raw_output = final.get("output") or final.get("result")

    if status == "completed":
        analysis = parse_detections(raw_output)
        has_nudity = analysis.get("has_nudity", False)
        count = analysis.get("detection_count", 0)
        if has_nudity:
            labels = _top_labels(analysis.get("detections", []))
            print(f"{tag}: DONE  nudity=YES  detections={count}  [{labels}]", flush=True)
        else:
            print(f"{tag}: DONE  nudity=NO", flush=True)
    elif status == "failed":
        err = (
            raw_output.get("error", str(raw_output))
            if isinstance(raw_output, dict)
            else str(raw_output)
        )
        analysis = {"agent_error": err[:400]}
        print(f"{tag}: FAILED  {err[:200]}", flush=True)
    else:
        analysis = {"status_error": f"unexpected terminal status: {status}"}
        print(f"{tag}: {status.upper()}", flush=True)

    return {
        "file": str(file_path),
        "filename": file_path.name,
        "status": status,
        "task_id": task_id,
        "capability": cap,
        "analysis": analysis,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=f"Batch nudity analysis via OffloadMQ {CAPABILITY}.",
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
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        metavar="FLOAT",
        help=f"Detection confidence threshold 0.0–1.0 (default: {DEFAULT_THRESHOLD})",
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
    parser.add_argument("files", nargs="+", metavar="FILE|DIR", help="Image files or directories to analyze")
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

    total = len(file_paths)
    mode = "urgent (blocking)" if args.urgent else "non-urgent (polling)"
    print(f"Analyzing {total} image(s) via {CAPABILITY}  threshold={args.threshold}  mode={mode}")
    print(f"Server: {base_url}")
    print()

    results: list[dict[str, Any]] = []
    progress = Progress(total, time.monotonic())

    for i, fp in enumerate(file_paths, 1):
        try:
            result = analyze_image(
                base_url,
                args.api_key,
                args.threshold,
                args.urgent,
                args.timeout,
                fp,
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
                "error": str(exc),
                "analyzed_at": datetime.now(timezone.utc).isoformat(),
            }
        results.append(result)
        print(f"  {progress.record()}", flush=True)

    completed = sum(1 for r in results if r["status"] == "completed")
    flagged = sum(
        1 for r in results
        if r["status"] == "completed" and r["analysis"].get("has_nudity")
    )
    failed = total - completed
    print()
    print(f"Summary: {completed}/{total} completed — {flagged} flagged, {failed} failed/errored")

    output_doc: dict[str, Any] = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "server": base_url,
        "capability": CAPABILITY,
        "threshold": args.threshold,
        "total": total,
        "completed": completed,
        "flagged": flagged,
        "failed": failed,
        "results": results,
    }
    output_path = Path(args.output)
    output_path.write_text(json.dumps(output_doc, indent=2))
    print(f"Results saved to: {output_path}")


if __name__ == "__main__":
    main()
