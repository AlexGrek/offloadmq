"""Request/response payload models shared across the route modules."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SettingsPayload(BaseModel):
    server: str | None = None
    api_key: str | None = None
    display_name: str | None = None
    capabilities: list[str] | None = None
    custom_caps: list[str] | None = None
    max_concurrent: int | None = None
    autostart: bool | None = None
    webui_port: int | None = None
    comfyui_url: str | None = None
    kokoro_api_url: str | None = None
    kokoro_api_key: str | None = None
    rescan_interval_secs: int | None = None
    win_startup_enabled: bool | None = None
    mac_startup_enabled: bool | None = None
    keep_awake_enabled: bool | None = None
    auto_update_enabled: bool | None = None
    auto_update_interval_hours: int | None = None


class CapabilityPolicyPayload(BaseModel):
    regular_disabled: list[str] = Field(default_factory=list)
    sensitive_allowed: list[str] = Field(default_factory=list)
    slavemode_allowed: list[str] = Field(default_factory=list)


class RescanPayload(BaseModel):
    restart_if_changed: bool = False


class RawConfigPayload(BaseModel):
    json_text: str = Field(alias="json")

    model_config = {"populate_by_name": True}


class CustomSavePayload(BaseModel):
    name: str
    yaml: str


class CustomDeletePayload(BaseModel):
    name: str


class ComfyUrlPayload(BaseModel):
    comfyui_url: str = ""


class KokoroSettingsPayload(BaseModel):
    kokoro_api_url: str = ""
    kokoro_api_key: str = ""


class WorkflowAddPayload(BaseModel):
    workflow_name: str
    task_type: str
    namespace: str = ""
    graph_json: str


class WorkflowDeletePayload(BaseModel):
    workflow_name: str
    namespace: str = ""


class ParamMapPayload(BaseModel):
    workflow_name: str
    task_type: str
    namespace: str = ""
    param_map_json: str


class ParamMapSavePayload(BaseModel):
    workflow_name: str
    task_type: str
    namespace: str = ""
    params: dict[str, Any]


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")
