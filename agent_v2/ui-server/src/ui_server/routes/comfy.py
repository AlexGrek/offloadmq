"""ComfyUI workflow / param-map routes.

All validation, path-safety, and file I/O for workflow graphs and param maps
lives in :mod:`offloadmq_core.comfy_service`, reached only via ``orch.*`` — see
SKILL.md's dependency graph (ui-server never imports core directly).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import (
    ComfyLaunchPayload,
    ComfyUrlPayload,
    ParamMapPayload,
    ParamMapSavePayload,
    WorkflowAddPayload,
    WorkflowDeletePayload,
    WorkflowMovePayload,
    WorkflowImportPayload,
    dump,
)


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.get("/comfy/workflows")
    def comfy_workflows() -> dict[str, Any]:
        return orch.list_comfy_workflows()

    @router.post("/comfy/url")
    def comfy_url(payload: ComfyUrlPayload) -> dict[str, Any]:
        return dump(orch.apply_settings(comfyui_url=payload.comfyui_url.strip()))

    # ---- Agent-managed local ComfyUI server ----

    @router.get("/comfy/process")
    def comfy_process_status() -> dict[str, Any]:
        return orch.comfy_process_status()

    @router.post("/comfy/process/settings")
    def comfy_process_settings(payload: ComfyLaunchPayload) -> dict[str, Any]:
        fields = payload.model_dump(exclude_none=True)
        if "comfyui_args" in fields:
            fields["comfyui_args"] = [a.strip() for a in fields["comfyui_args"] if a.strip()]
        return dump(orch.apply_settings(**fields))

    @router.get("/comfy/process/detect")
    def comfy_process_detect() -> dict[str, Any]:
        return {"install": orch.detect_comfy_install()}

    @router.post("/comfy/process/{action}")
    def comfy_process_action(action: str) -> dict[str, Any]:
        if action not in ("start", "stop", "restart"):
            raise HTTPException(status_code=404, detail=f"Unknown action {action!r}")
        try:
            return orch.comfy_process_action(action)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/add")
    def comfy_add_workflow(payload: WorkflowAddPayload) -> dict[str, Any]:
        try:
            orch.add_comfy_workflow(
                payload.workflow_name, payload.task_type, payload.namespace, payload.graph_json
            )
            orch.start_background_scan()
            return {"ok": True}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/comfy/workflows/graph")
    def comfy_get_workflow_graph(
        workflow_name: str = Query(""),
        task_type: str = Query(""),
        namespace: str = Query(""),
    ) -> dict[str, str]:
        try:
            graph_json = orch.get_comfy_workflow_graph(workflow_name, task_type, namespace)
            return {"graph_json": graph_json}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/comfy/workflows/export")
    def comfy_export_workflow(
        workflow_name: str = Query(""),
        namespace: str = Query(""),
    ) -> dict[str, Any]:
        try:
            return orch.export_comfy_workflow(workflow_name, namespace)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/import")
    def comfy_import_workflow(payload: WorkflowImportPayload) -> dict[str, Any]:
        try:
            result = orch.import_comfy_workflow(
                payload.bundle, payload.name, payload.namespace, payload.overwrite
            )
            orch.start_background_scan()
            return {"ok": True, **result}
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"could not write workflow files: {exc}") from exc

    @router.post("/comfy/workflows/delete")
    def comfy_delete_workflow(payload: WorkflowDeletePayload) -> dict[str, bool]:
        try:
            orch.delete_comfy_workflow(payload.workflow_name, payload.namespace)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        orch.start_background_scan()
        return {"ok": True}

    @router.post("/comfy/workflows/rename")
    def comfy_rename_workflow(payload: WorkflowMovePayload) -> dict[str, bool]:
        try:
            orch.rename_comfy_workflow(
                payload.workflow_name,
                payload.namespace,
                payload.new_workflow_name,
                payload.new_namespace,
            )
            orch.start_background_scan()
            return {"ok": True}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/duplicate")
    def comfy_duplicate_workflow(payload: WorkflowMovePayload) -> dict[str, bool]:
        try:
            orch.duplicate_comfy_workflow(
                payload.workflow_name,
                payload.namespace,
                payload.new_workflow_name,
                payload.new_namespace,
            )
            orch.start_background_scan()
            return {"ok": True}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/comfy/workflows/param-map")
    def comfy_get_param_map(
        workflow_name: str = Query(""),
        task_type: str = Query(""),
        namespace: str = Query(""),
    ) -> dict[str, Any]:
        try:
            return orch.get_comfy_param_map(workflow_name, task_type, namespace)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/param-map")
    def comfy_save_param_map(payload: ParamMapSavePayload) -> dict[str, bool]:
        try:
            orch.save_comfy_param_map(
                payload.workflow_name, payload.task_type, payload.namespace, payload.params
            )
            orch.start_background_scan()
            return {"ok": True}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/comfy/workflows/param-map/autodetect")
    def comfy_autodetect_param_map(payload: ParamMapPayload) -> dict[str, Any]:
        try:
            result = orch.autodetect_comfy_param_map(
                payload.workflow_name, payload.task_type, payload.namespace
            )
            orch.start_background_scan()
            return {"ok": True, **result}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return router
