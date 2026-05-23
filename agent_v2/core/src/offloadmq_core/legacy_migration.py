"""Import legacy ~/.offload-agent.json into v2 settings."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from offloadmq_core.settings import SETTINGS_FILE, Settings, save_settings

LEGACY_CONFIG = Path.home() / ".offload-agent.json"


def _list_field(raw: dict[str, Any], *keys: str) -> list[str]:
    for key in keys:
        val = raw.get(key)
        if isinstance(val, list):
            return [str(x) for x in val]
    return []


def map_legacy_config(raw: dict[str, Any]) -> Settings:
    """Map legacy config dict to v2 Settings (does not persist)."""
    caps = _list_field(raw, "capabilities")
    custom = [c for c in caps if c.startswith("custom.")]

    return Settings(
        server=str(raw.get("server", "")).strip(),
        api_key=str(raw.get("apiKey", raw.get("api_key", ""))).strip(),
        display_name=str(raw.get("displayName", raw.get("display_name", ""))).strip(),
        capabilities=[c for c in caps if not c.startswith("custom.")],
        custom_caps=custom or _list_field(raw, "custom-caps", "custom_caps"),
        max_concurrent=int(raw.get("capacity", raw.get("max_concurrent", 1)) or 1),
        autostart=bool(raw.get("autostart", False)),
        webui_port=int(raw.get("webuiPort", raw.get("webui_port", 8090)) or 8090),
        regular_disabled_caps=_list_field(raw, "regular-disabled-caps", "regular_disabled_caps"),
        sensitive_allowed_caps=_list_field(raw, "sensitive-allowed-caps", "sensitive_allowed_caps"),
        slavemode_allowed_caps=_list_field(raw, "slavemode-allowed-caps", "slavemode_allowed_caps"),
        comfyui_url=str(raw.get("comfyuiUrl", raw.get("comfyui_url", "http://127.0.0.1:8188"))).strip(),
        win_startup_enabled=bool(raw.get("winStartup", raw.get("win_startup_enabled", False))),
        mac_startup_enabled=bool(raw.get("macStartup", raw.get("mac_startup_enabled", False))),
        onnx_slavemode_initialized=bool(raw.get("_onnx_slavemode_initialized", False)),
        agent_id=str(raw.get("agentId", raw.get("agent_id", ""))).strip(),
        key=str(raw.get("key", "")).strip(),
        jwt_token=str(raw.get("jwtToken", raw.get("jwt_token", ""))).strip(),
        token_expires_in=int(raw.get("tokenExpiresIn", raw.get("token_expires_in", 0)) or 0),
    )


def load_legacy_config(path: Path = LEGACY_CONFIG) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data: dict[str, Any] = json.loads(path.read_text())
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def import_legacy_config(
    *,
    legacy_path: Path = LEGACY_CONFIG,
    target_path: Path = SETTINGS_FILE,
    merge: bool = True,
) -> Settings:
    """Import legacy config into v2 settings file."""
    legacy = load_legacy_config(legacy_path)
    if not legacy:
        raise FileNotFoundError(f"No legacy config at {legacy_path}")

    imported = map_legacy_config(legacy)
    if merge and target_path.exists():
        current = Settings.model_validate(json.loads(target_path.read_text()))
        data = current.model_dump()
        for key, value in imported.model_dump().items():
            if key in ("agent_id", "key", "jwt_token", "token_expires_in"):
                if value:
                    data[key] = value
            elif value not in (None, "", [], False, 0):
                data[key] = value
        imported = Settings.model_validate(data)

    save_settings(imported, target_path)
    return imported
