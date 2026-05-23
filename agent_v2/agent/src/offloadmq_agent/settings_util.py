"""Lightweight settings read for executors (no core dependency)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SETTINGS_FILE = Path(".offloadmq-agent.json")


def load_agent_settings() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        data: dict[str, Any] = json.loads(SETTINGS_FILE.read_text())
        return data
    except (json.JSONDecodeError, OSError):
        return {}
