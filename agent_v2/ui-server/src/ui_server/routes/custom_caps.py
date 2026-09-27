"""Custom capability YAML CRUD routes."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import CustomDeletePayload, CustomSavePayload


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.get("/custom/list")
    def custom_list() -> dict[str, object]:
        return {"caps": orch.list_custom_caps()}

    @router.get("/custom/get/{cap_name}")
    def custom_get(cap_name: str) -> dict[str, str]:
        try:
            return {"yaml": orch.get_custom_cap(cap_name)}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.post("/custom/save")
    def custom_save(payload: CustomSavePayload) -> dict[str, bool]:
        orch.save_custom_cap(payload.name, payload.yaml)
        orch.start_background_scan()
        return {"ok": True}

    @router.post("/custom/delete")
    def custom_delete(payload: CustomDeletePayload) -> dict[str, bool]:
        orch.delete_custom_cap(payload.name)
        orch.start_background_scan()
        return {"ok": True}

    @router.post("/custom/upload")
    async def custom_upload(file: UploadFile = File(...)) -> dict[str, bool]:
        content = (await file.read()).decode("utf-8", errors="replace")
        name = (file.filename or "custom").replace(".yaml", "").replace(".yml", "")
        orch.save_custom_cap(name, content)
        orch.start_background_scan()
        return {"ok": True}

    return router
