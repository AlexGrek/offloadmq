#!/usr/bin/env python3
"""
Translate text via OffloadMQ.

Prefers online translate.* capabilities; if none are available falls back to a
random online llm.* model with a warning.

Text can be supplied as a positional argument or piped via stdin.

Usage:
    echo "Bonjour le monde" | python translate.py \\
        --url http://localhost:3069 --api-key ... --to English

    python translate.py \\
        --url http://localhost:3069 --api-key ... \\
        --from Spanish --to English \\
        "Hola, ¿cómo estás?"
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from typing import Any
from urllib.parse import quote

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TERMINAL_STATUSES = {"completed", "failed", "canceled"}

DEFAULT_POLL_INTERVAL = 2.0  # seconds
DEFAULT_TIMEOUT = 600.0      # seconds

# ---------------------------------------------------------------------------
# Capability helpers
# ---------------------------------------------------------------------------


def _strip_attrs(cap: str) -> str:
    idx = cap.find("[")
    return cap if idx == -1 else cap[:idx]


def pick_capability(base_url: str, api_key: str) -> str:
    resp = requests.post(
        f"{base_url}/api/capabilities/list/online_ext",
        json={"apiKey": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    all_caps: list[str] = resp.json()

    llm_caps = [_strip_attrs(c) for c in all_caps if _strip_attrs(c).startswith("llm.")]
    if not llm_caps:
        print("error: no llm.* capabilities available", file=sys.stderr)
        sys.exit(1)

    translate_caps = [c for c in llm_caps if "translate" in c.lower()]
    if translate_caps:
        return random.choice(translate_caps)

    chosen = random.choice(llm_caps)
    print(f"warning: no translate models online — falling back to {chosen}", file=sys.stderr)
    return chosen

# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def build_messages(text: str, to_lang: str, from_lang: str | None) -> list[dict[str, str]]:
    if from_lang:
        instruction = (
            f"Translate the following text from {from_lang} to {to_lang}. "
            "Output only the translated text, no explanations or metadata."
        )
    else:
        instruction = (
            f"Translate the following text to {to_lang}. "
            "Auto-detect the source language. "
            "Output only the translated text, no explanations or metadata."
        )
    return [{"role": "user", "content": f"{instruction}\n\n{text}"}]

# ---------------------------------------------------------------------------
# Task helpers
# ---------------------------------------------------------------------------


def submit_task(
    base_url: str,
    api_key: str,
    capability: str,
    messages: list[dict[str, str]],
    urgent: bool,
    timeout: float,
) -> dict[str, Any]:
    """
    Urgent mode: POST /api/task/submit_blocking — blocks until done, returns final task.
    Non-urgent:  POST /api/task/submit          — returns immediately with {id, status}.
    """
    body: dict[str, Any] = {
        "apiKey": api_key,
        "capability": capability,
        "urgent": urgent,
        "restartable": not urgent,
        "fetchFiles": [],
        "file_bucket": [],
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
        print("\nCancelling task ...", file=sys.stderr, flush=True)
        cancel_task(base_url, api_key, cap, task_id)
        raise

# ---------------------------------------------------------------------------
# Result extraction
# ---------------------------------------------------------------------------


def extract_text(output: Any) -> tuple[bool, str]:
    if not isinstance(output, dict):
        return False, f"unexpected output type: {type(output).__name__}"
    if "error" in output:
        return False, str(output["error"])
    if isinstance(output.get("message"), dict):
        content = output["message"].get("content", "")
        return bool(content), content or "(empty response)"
    if "response" in output:
        return True, str(output["response"])
    return True, str(output)

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Translate text via OffloadMQ translate.* or llm.* capability.",
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
        "--to",
        required=True,
        metavar="LANG",
        help="Target language (e.g. English, French, Japanese)",
    )
    parser.add_argument(
        "--from",
        default=None,
        dest="from_lang",
        metavar="LANG",
        help="Source language (omit to auto-detect)",
    )
    parser.add_argument(
        "--model",
        default=None,
        metavar="CAP",
        help="Capability to use (e.g. translate.opus-mt or llm.mistral); auto-selected if omitted",
    )
    parser.add_argument(
        "--urgent",
        action="store_true",
        default=False,
        help="Use blocking submit (waits up to 60s inline); default is non-urgent with polling",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        metavar="SECS",
        help="Max seconds to wait for the result (default: 600)",
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
        "text",
        nargs="?",
        default=None,
        metavar="TEXT",
        help="Text to translate (reads from stdin if omitted)",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # Read input text
    if args.text is not None:
        text = args.text
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        parser.error("provide text as an argument or pipe it via stdin")

    text = text.strip()
    if not text:
        parser.error("input text is empty")

    base_url: str = args.url.rstrip("/")

    # Resolve capability
    if args.model:
        capability = args.model
        print(f"Using capability: {capability}", file=sys.stderr)
    else:
        capability = pick_capability(base_url, args.api_key)
        print(f"Using capability: {capability}", file=sys.stderr)

    mode = "urgent (blocking)" if args.urgent else "non-urgent (polling)"
    print(f"Mode: {mode}", file=sys.stderr)
    print(file=sys.stderr)

    messages = build_messages(text, args.to, args.from_lang)

    try:
        submit_resp = submit_task(base_url, args.api_key, capability, messages, args.urgent, args.timeout)
        cap: str = submit_resp["id"]["cap"]
        task_id: str = submit_resp["id"]["id"]

        final = submit_resp if args.urgent else poll_until_done(
            base_url, args.api_key, cap, task_id, args.poll_interval, args.timeout
        )
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(1)

    status: str = final.get("status", "unknown")
    raw_output = final.get("output") or final.get("result")

    if status == "completed":
        ok, translation = extract_text(raw_output)
        if ok:
            print(translation)
        else:
            print(f"error: {translation}", file=sys.stderr)
            sys.exit(1)
    elif status == "failed":
        err = (
            raw_output.get("error", str(raw_output))
            if isinstance(raw_output, dict)
            else str(raw_output)
        )
        print(f"error: task failed — {err}", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"error: unexpected terminal status: {status}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
