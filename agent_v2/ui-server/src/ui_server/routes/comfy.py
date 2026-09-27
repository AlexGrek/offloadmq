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
    ComfyUrlPayload,
    ParamMapPayload,
    ParamMapSavePayload,
    WorkflowAddPayload,
    WorkflowDeletePayload,
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

    @router.post("/comfy/workflows/delete")
    def comfy_delete_workflow(payload: WorkflowDeletePayload) -> dict[str, bool]:
        orch.delete_comfy_workflow(payload.workflow_name, payload.namespace)
        orch.start_background_scan()
        return {"ok": True}

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
