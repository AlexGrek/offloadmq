from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, field_validator

CONFIG_FILE = Path(".offloadmq-agent.json")


class AgentConfig(BaseModel):
    server: str = ""
    api_key: str = ""
    agent_id: str = ""
    key: str = ""
    jwt_token: str = ""
    token_expires_in: int = 0
    capabilities: list[str] = []
    custom_caps: list[str] = []
    autostart: bool = False
    tier: int = 1
    capacity: int = 4

    @field_validator("server", "api_key", mode="before")
    @classmethod
    def strip_whitespace(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v

    @property
    def is_configured(self) -> bool:
        return bool(self.server and self.api_key)

    @property
    def all_capabilities(self) -> list[str]:
        return self.capabilities + self.custom_caps


def _config_path() -> Path:
    return CONFIG_FILE


def load_config() -> AgentConfig:
    path = _config_path()
    if not path.exists():
        return AgentConfig()
    try:
        data: dict[str, Any] = json.loads(path.read_text())
        return AgentConfig.model_validate(data)
    except Exception:
        return AgentConfig()


def save_config(cfg: AgentConfig) -> None:
    _config_path().write_text(cfg.model_dump_json(indent=2))
