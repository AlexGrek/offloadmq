"""REST API router factory."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from ui_server.protocol import OrchestratorAPI


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


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")


def create_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/settings")
    def get_settings() -> dict[str, Any]:
        return _dump(orch.get_settings())

    @router.post("/settings")
    def post_settings(payload: SettingsPayload) -> dict[str, Any]:
        fields = {k: v for k, v in payload.model_dump().items() if v is not None}
        return _dump(orch.apply_settings(**fields))

    @router.get("/config/raw")
    def get_raw_config() -> dict[str, str]:
        return {"json": orch.get_raw_settings_json()}

    @router.post("/config/raw")
    def post_raw_config(payload: RawConfigPayload) -> dict[str, Any]:
        try:
            return _dump(orch.save_raw_settings_json(payload.json_text))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/capabilities/detect")
    def detect() -> dict[str, list[str]]:
        return {"capabilities": orch.scan_capabilities()}

    @router.get("/capabilities/state")
    def capabilities_state() -> dict[str, Any]:
        return orch.get_scan_state()

    @router.post("/capabilities/rescan")
    def rescan(payload: RescanPayload) -> dict[str, Any]:
        return orch.rescan(restart_if_changed=payload.restart_if_changed)

    @router.post("/capabilities/policy")
    def save_policy(payload: CapabilityPolicyPayload) -> dict[str, Any]:
        return _dump(
            orch.update_capability_policy(
                regular_disabled=payload.regular_disabled,
                sensitive_allowed=payload.sensitive_allowed,
                slavemode_allowed=payload.slavemode_allowed,
            )
        )

    @router.post("/agent/start")
    def start() -> dict[str, Any]:
        try:
            orch.start()
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return orch.status()

    @router.post("/agent/stop")
    def stop() -> dict[str, Any]:
        orch.stop()
        return orch.status()

    @router.get("/agent/status")
    def status() -> dict[str, Any]:
        return orch.status()

    @router.get("/agent/logs")
    def agent_logs(n: int = Query(100, ge=1, le=500)) -> dict[str, list[str]]:
        return {"lines": orch.get_agent_logs(n)}

    @router.post("/agent/register")
    def register_agent() -> dict[str, str]:
        try:
            agent_id = orch.register()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"agentId": agent_id}

    @router.get("/tasks")
    def list_tasks() -> dict[str, Any]:
        return {"tasks": [_dump(t) for t in orch.list_tasks()]}

    @router.get("/tasks/{task_id}")
    def get_task(task_id: str) -> dict[str, Any]:
        record = orch.get_task(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return _dump(record)

    @router.post("/tasks/{task_id}/cancel")
    def cancel_task(task_id: str) -> dict[str, Any]:
        ok = orch.cancel_task(task_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Task not active")
        return {"ok": True}

    # ------------------------------------------------------------------
    # Custom capabilities
    # ------------------------------------------------------------------

    @router.get("/custom/list")
    def custom_list() -> dict[str, Any]:
        from offloadmq_core.custom_caps_service import list_custom_caps

        return {"caps": list_custom_caps()}

    @router.get("/custom/get/{cap_name}")
    def custom_get(cap_name: str) -> dict[str, str]:
        from offloadmq_core.custom_caps_service import get_custom_cap

        try:
            return {"yaml": get_custom_cap(cap_name)}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.post("/custom/save")
    def custom_save(payload: CustomSavePayload) -> dict[str, bool]:
        from offloadmq_core.custom_caps_service import save_custom_cap

        save_custom_cap(payload.name, payload.yaml)
        orch.start_background_scan()
        return {"ok": True}

    @router.post("/custom/delete")
    def custom_delete(payload: CustomDeletePayload) -> dict[str, bool]:
        from offloadmq_core.custom_caps_service import delete_custom_cap

        delete_custom_cap(payload.name)
        orch.start_background_scan()
        return {"ok": True}

    @router.post("/custom/upload")
    async def custom_upload(file: UploadFile = File(...)) -> dict[str, bool]:
        from offloadmq_core.custom_caps_service import save_custom_cap

        content = (await file.read()).decode("utf-8", errors="replace")
        name = (file.filename or "custom").replace(".yaml", "").replace(".yml", "")
        save_custom_cap(name, content)
        orch.start_background_scan()
        return {"ok": True}

    # ------------------------------------------------------------------
    # ComfyUI / workflows
    # ------------------------------------------------------------------

    @router.get("/comfy/workflows")
    def comfy_workflows() -> dict[str, Any]:
        from offloadmq_core.comfy_service import STANDARD_TASK_TYPES, list_workflows

        return {
            "workflows": list_workflows(),
            "standardTaskTypes": STANDARD_TASK_TYPES,
        }

    @router.post("/comfy/url")
    def comfy_url(payload: ComfyUrlPayload) -> dict[str, Any]:
        return _dump(orch.apply_settings(comfyui_url=payload.comfyui_url.strip()))

    # ------------------------------------------------------------------
    # Kokoro TTS
    # ------------------------------------------------------------------

    @router.post("/kokoro/settings")
    def kokoro_settings(payload: KokoroSettingsPayload) -> dict[str, Any]:
        result = _dump(
            orch.apply_settings(
                kokoro_api_url=payload.kokoro_api_url.strip(),
                kokoro_api_key=payload.kokoro_api_key.strip(),
            )
        )
        orch.start_background_scan()
        return result

    @router.get("/kokoro/status")
    def kokoro_status() -> dict[str, Any]:
        from offloadmq_agent.capabilities_sync import check_kokoro

        r = check_kokoro()
        return {
            "ok": r.ok,
            "capabilities": r.caps,
            "reason": r.reason,
        }

    @router.post("/comfy/workflows/add")
    def comfy_add_workflow(payload: WorkflowAddPayload) -> dict[str, Any]:
        import json

        from offloadmq_core.comfy_service import (
            _resolve_workflow_graph_path,
            _validate_comfy_api_workflow,
        )

        try:
            graph = json.loads(payload.graph_json)
            _validate_comfy_api_workflow(graph)
            path = _resolve_workflow_graph_path(
                payload.workflow_name, payload.task_type, payload.namespace
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(graph, indent=2))
            orch.start_background_scan()
            return {"ok": True}
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/delete")
    def comfy_delete_workflow(payload: WorkflowDeletePayload) -> dict[str, bool]:
        import shutil

        from offloadmq_core.comfy_service import workflows_dir

        wdir = workflows_dir()
        ns = payload.namespace.strip()
        name = payload.workflow_name.strip()
        target = (wdir / ns / name) if ns else (wdir / name)
        if target.is_dir():
            shutil.rmtree(target)
        orch.start_background_scan()
        return {"ok": True}

    @router.get("/comfy/workflows/param-map")
    def comfy_get_param_map(
        workflow_name: str = Query(""),
        task_type: str = Query(""),
        namespace: str = Query(""),
    ) -> dict[str, Any]:
        import json

        from offloadmq_core.comfy_service import (
            _PARAM_FIELD_KEY_RE,
            _build_comfy_input_options,
            _param_ui_standard_rows,
            _resolve_workflow_graph_path,
            _standard_param_field_keys,
        )

        try:
            graph_path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not graph_path.exists():
            raise HTTPException(status_code=404, detail="workflow graph JSON not found")

        try:
            graph = json.loads(graph_path.read_text())
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"invalid graph JSON: {exc}") from exc

        params_path = graph_path.with_suffix(".params.json")
        params: dict[str, Any] = {}
        if params_path.exists():
            try:
                loaded = json.loads(params_path.read_text())
                if isinstance(loaded, dict):
                    params = loaded
            except json.JSONDecodeError:
                pass

        std_keys = _standard_param_field_keys(task_type, namespace)
        extra_keys = sorted(k for k in params if k not in std_keys and _PARAM_FIELD_KEY_RE.match(k))

        return {
            "ok": True,
            "params": params,
            "standard_fields": _param_ui_standard_rows(task_type, namespace),
            "extra_keys": extra_keys,
            "input_options": _build_comfy_input_options(graph),
            # Notes explain why a field is left unwired. Only autodetect produces
            # them; they are not persisted. Present here so both responses share
            # one shape.
            "notes": {},
        }

    @router.post("/comfy/workflows/param-map")
    def comfy_save_param_map(payload: ParamMapSavePayload) -> dict[str, bool]:
        import json

        from offloadmq_core.comfy_service import (
            _resolve_workflow_graph_path,
            _validate_param_map,
        )

        try:
            graph_path = _resolve_workflow_graph_path(
                payload.workflow_name, payload.task_type, payload.namespace
            )
            if not graph_path.exists():
                raise HTTPException(status_code=404, detail="workflow graph JSON not found")
            _validate_param_map(payload.params)
            pmap = graph_path.with_suffix(".params.json")
            pmap.write_text(json.dumps(payload.params, indent=2))
            orch.start_background_scan()
            return {"ok": True}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/param-map/autodetect")
    def comfy_autodetect_param_map(payload: ParamMapPayload) -> dict[str, Any]:
        import json

        from offloadmq_core.comfy_service import (
            _resolve_workflow_graph_path,
            _validate_comfy_api_workflow,
            guess_params_ex,
        )

        try:
            graph_path = _resolve_workflow_graph_path(
                payload.workflow_name, payload.task_type, payload.namespace
            )
            graph = json.loads(graph_path.read_text())
            _validate_comfy_api_workflow(graph)
            params, notes = guess_params_ex(graph, payload.task_type, payload.namespace)
            pmap = graph_path.with_suffix(".params.json")
            pmap.write_text(json.dumps(params, indent=2))
            orch.start_background_scan()
            return {"ok": True, "paramMap": params, "notes": notes}
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # ------------------------------------------------------------------
    # System / updates / OS
    # ------------------------------------------------------------------

    @router.get("/system/info")
    def system_info() -> dict[str, Any]:
        from offloadmq_agent.systeminfo import collect_system_info

        return {"sysinfo": collect_system_info()}

    @router.get("/system/default-display-name")
    def default_display_name() -> dict[str, str]:
        from offloadmq_agent.systeminfo import (
            collect_system_info,
            effective_display_name,
        )

        sysinfo = collect_system_info()
        return {"display_name": effective_display_name("", sysinfo)}

    @router.get("/update/check")
    def update_check() -> dict[str, Any]:
        from offloadmq_core.orchestrator import APP_VERSION
        from offloadmq_core.updater import check_for_update

        return check_for_update(APP_VERSION)

    @router.post("/update/download")
    def update_download() -> dict[str, Any]:
        from offloadmq_core.updater import download_update

        lines: list[str] = []

        def _log(msg: str) -> None:
            lines.append(msg)

        result = download_update(_log)
        result["log"] = lines
        return result

    @router.get("/system/startup-status")
    def startup_status() -> dict[str, Any]:
        import os
        import sys
        from offloadmq_core import keep_awake, startup_mac, startup_win
        from offloadmq_core.systemd_service import is_installed

        settings = orch.get_settings()
        result: dict[str, Any] = {
            "platform": sys.platform,
            "mac_enabled": startup_mac.enabled(),
            "win_enabled": startup_win.enabled(),
            "systemd_installed": is_installed(),
            "gui_mode": os.environ.get("OMQ_GUI") == "1",
            "keep_awake_available": keep_awake.available(),
            "keep_awake_active": keep_awake.active(),
            "keep_awake_enabled": getattr(settings, "keep_awake_enabled", False),
            "keep_awake_method": keep_awake.method(),
        }
        # Windows debug info
        if sys.platform == "win32":
            result["win_exe"] = startup_win._get_exe_path()
            result["win_frozen"] = getattr(sys, "frozen", False)
            result["win_registry_value"] = startup_win.read_value()
        # macOS debug info
        if sys.platform == "darwin":
            result["mac_exe"] = startup_mac._get_exe_path()
            result["mac_frozen"] = getattr(sys, "frozen", False)
            result["mac_plist"] = startup_mac.read_plist()
            result["mac_log_dir"] = startup_mac._LOG_DIR
        return result

    @router.post("/system/keep-awake")
    def keep_awake_toggle(enable: bool = Query(...)) -> dict[str, Any]:
        import logging

        from offloadmq_core import keep_awake

        if enable and not keep_awake.available():
            raise HTTPException(
                status_code=400,
                detail="Keep awake is not available on this platform",
            )
        keep_awake.sync_from_settings(enable, logging.getLogger(__name__).info)
        settings = orch.apply_settings(keep_awake_enabled=enable)
        return _dump(settings)

    @router.post("/system/win-startup")
    def win_startup(enable: bool = Query(...)) -> dict[str, Any]:
        import logging
        from offloadmq_core import startup_win

        if not startup_win.available():
            raise HTTPException(status_code=400, detail="Windows startup not available")
        startup_win.set_enabled(enable, logging.getLogger(__name__).info)
        settings = orch.update_settings(win_startup_enabled=enable, autostart=enable)
        return _dump(settings)

    @router.post("/system/mac-startup")
    def mac_startup(enable: bool = Query(...)) -> dict[str, Any]:
        import logging
        from offloadmq_core import startup_mac

        if not startup_mac.available():
            raise HTTPException(status_code=400, detail="macOS LaunchAgent not available")
        startup_mac.set_enabled(enable, logging.getLogger(__name__).info)
        settings = orch.update_settings(mac_startup_enabled=enable, autostart=enable)
        return _dump(settings)

    @router.post("/system/install-systemd")
    def install_systemd(host: str = "0.0.0.0", port: int = 8090) -> dict[str, Any]:
        from offloadmq_core.systemd_service import install_systemd_unit

        return install_systemd_unit(host=host, port=port)

    @router.post("/system/uninstall-systemd")
    def uninstall_systemd() -> dict[str, Any]:
        from offloadmq_core.systemd_service import uninstall_systemd_unit

        return uninstall_systemd_unit()

    return router
