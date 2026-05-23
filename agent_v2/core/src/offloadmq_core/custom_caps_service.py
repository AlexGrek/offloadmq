"""Custom capability file management."""
from __future__ import annotations

from typing import Any

from offloadmq_agent.custom_caps import (
    _find_custom_caps_dir,
    delete_custom_cap as _delete,
    discover_custom_caps,
    validate_custom_cap_yaml,
)


def list_custom_caps() -> list[dict[str, str]]:
    return [
        {"name": c.name, "capability": c.capability_string()}
        for c in discover_custom_caps()
    ]


def get_custom_cap(name: str) -> str:
    caps_dir = _find_custom_caps_dir()
    for suffix in (".yaml", ".yml"):
        path = caps_dir / f"{name}{suffix}"
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"Custom cap '{name}' not found")


def save_custom_cap(name: str, yaml_text: str) -> None:
    validate_custom_cap_yaml(yaml_text)
    caps_dir = _find_custom_caps_dir()
    caps_dir.mkdir(parents=True, exist_ok=True)
    (caps_dir / f"{name}.yaml").write_text(yaml_text, encoding="utf-8")


def delete_custom_cap(name: str) -> None:
    if not _delete(name):
        raise FileNotFoundError(f"Custom cap '{name}' not found")


def validate_yaml(yaml_text: str) -> dict[str, Any]:
    cap = validate_custom_cap_yaml(yaml_text)
    return cap.to_dict()
