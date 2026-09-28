"""Power-source detection (macOS only, via ``pmset``)."""
from __future__ import annotations

import re
import shutil
import subprocess
import sys

_SOURCE_RE = re.compile(r"Now drawing from '([^']+)'")


def available() -> bool:
    return sys.platform == "darwin" and shutil.which("pmset") is not None


def parse_pmset(output: str) -> bool | None:
    """``pmset -g ps`` output → True on battery, False on AC/UPS, None if unrecognised."""
    match = _SOURCE_RE.search(output)
    if match is None:
        return None
    return match.group(1) == "Battery Power"


def on_battery() -> bool | None:
    """True on battery, False on external power, None when unknown or unsupported."""
    if not available():
        return None
    try:
        proc = subprocess.run(
            ["pmset", "-g", "ps"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return parse_pmset(proc.stdout)
