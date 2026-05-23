"""Settings JSON management — owned by core."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

SETTINGS_FILE = Path(".offloadmq-agent.json")
TransportMode = Literal["http", "websocket"]


class Settings(BaseModel):
    server: str = ""
    api_key: str = ""
    display_name: str = ""
    transport: TransportMode = "http"
    capabilities: list[str] = []
    custom_caps: list[str] = []
    tier: int = 1
    max_concurrent: int = 1
    autostart: bool = False
    webui_port: int = 8090

    # Tiered capability policy (v2-native names).
    regular_disabled_caps: list[str] = Field(default_factory=list)
    sensitive_allowed_caps: list[str] = Field(default_factory=list)
    slavemode_allowed_caps: list[str] = Field(default_factory=list)

    # ComfyUI / workflows
    comfyui_url: str = "http://127.0.0.1:8188"

    # OS integration flags (persisted; platform modules apply changes).
    win_startup_enabled: bool = False
    mac_startup_enabled: bool = False

    # Internal flags
    onnx_slavemode_initialized: bool = False

    # Credentials populated after registration (not user-edited).
    agent_id: str = ""
    key: str = ""
    jwt_token: str = ""
    token_expires_in: int = 0

    @field_validator("server", "api_key", "display_name", "comfyui_url", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v

    @field_validator("max_concurrent", "tier", "webui_port", mode="before")
    @classmethod
    def _min_one(cls, v: Any) -> Any:
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            return 1

    @field_validator("transport", mode="before")
    @classmethod
    def _transport(cls, v: Any) -> Any:
        if v in ("http", "websocket"):
            return v
        return "http"

    @property
    def is_configured(self) -> bool:
        return bool(self.server and self.api_key)

    @property
    def all_capabilities(self) -> list[str]:
        return [*self.capabilities, *self.custom_caps]


def load_settings(path: Path = SETTINGS_FILE) -> Settings:
    if not path.exists():
        return Settings()
    try:
        return Settings.model_validate(json.loads(path.read_text()))
    except (json.JSONDecodeError, ValueError, OSError):
        return Settings()


def save_settings(cfg: Settings, path: Path = SETTINGS_FILE) -> None:
    path.write_text(cfg.model_dump_json(indent=2))
