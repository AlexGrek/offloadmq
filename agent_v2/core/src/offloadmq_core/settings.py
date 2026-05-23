"""Settings JSON management — owned by core.

The settings file lives in the current working directory. Core is the single
authority for loading and persisting it; everything else goes through the
orchestrator.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, field_validator

SETTINGS_FILE = Path(".offloadmq-agent.json")


class Settings(BaseModel):
    server: str = ""
    api_key: str = ""
    capabilities: list[str] = []
    custom_caps: list[str] = []
    tier: int = 1
    max_concurrent: int = 1  # parallel executor threads, 1 by default
    autostart: bool = False

    # Credentials populated after registration (not user-edited).
    agent_id: str = ""
    key: str = ""
    jwt_token: str = ""
    token_expires_in: int = 0

    @field_validator("server", "api_key", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v

    @field_validator("max_concurrent", "tier", mode="before")
    @classmethod
    def _min_one(cls, v: Any) -> Any:
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            return 1

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
