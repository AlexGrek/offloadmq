"""Client Storage API: `/api/storage/*` (mirror `src/api/client/storage.rs`).

Auth via the ``X-API-Key`` header (:func:`deps.storage_api_key`).
"""

from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response

from .. import deps
from ..config import settings
from ..errors import AppError
from ..responses import OffloadJSONResponse
from ..state import BucketMeta, FileMeta
from ..utils import iso_z, now_utc

router = APIRouter()


def _require_own_bucket(bucket_uid: str, api_key: str) -> BucketMeta:
    bucket = deps.store.get_bucket(bucket_uid)
    if bucket is None:
        raise AppError.not_found(f"Bucket {bucket_uid} not found")
    if bucket.api_key != api_key:
        raise AppError.authorization("Bucket not owned by this key")
    return bucket


def _sanitize_upload_path(name: str) -> str:
    is_absolute = (
        name.startswith("/")
        or name.startswith("\\")
        or (len(name) >= 3 and name[1] == ":" and name[2] in ("/", "\\"))
    )
    if is_absolute:
        return name.replace("\\", "/").rsplit("/", 1)[-1] or "unnamed"
    normalized = name.replace("\\", "/")
    components = [c for c in normalized.split("/") if c and c not in (".", "..")]
    return "/".join(components) if components else "unnamed"


@router.get("/limits")
async def get_limits(api_key: str = Depends(deps.storage_api_key)) -> dict:
    cfg = settings.storage
    return {
        "max_buckets_per_key": cfg.max_buckets_per_key,
        "bucket_size_bytes": cfg.bucket_size_bytes,
        "bucket_ttl_minutes": cfg.bucket_ttl_minutes,
    }


@router.get("/buckets")
async def list_buckets(api_key: str = Depends(deps.storage_api_key)) -> dict:
    capacity = settings.storage.bucket_size_bytes
    buckets = [
        {
            "bucket_uid": b.uid,
            "created_at": iso_z(b.created_at),
            "file_count": len(b.files),
            "used_bytes": b.used_bytes,
            "remaining_bytes": max(0, capacity - b.used_bytes),
            "tasks": b.tasks,
            "rm_after_task": b.rm_after_task,
        }
        for b in deps.store.list_buckets_for_key(api_key)
    ]
    return {"buckets": buckets}


@router.post("/bucket/create")
async def create_bucket(
    rm_after_task: bool = False, api_key: str = Depends(deps.storage_api_key)
):
    cfg = settings.storage
    current = deps.store.count_buckets_for_key(api_key)
    if current >= cfg.max_buckets_per_key:
        raise AppError.conflict(
            f"Bucket limit reached ({current}/{cfg.max_buckets_per_key})"
        )
    bucket = deps.store.create_bucket(api_key, rm_after_task)
    return OffloadJSONResponse(
        status_code=201,
        content={
            "bucket_uid": bucket.uid,
            "created_at": iso_z(bucket.created_at),
            "rm_after_task": bucket.rm_after_task,
        },
    )


@router.post("/bucket/{bucket_uid}/upload")
async def upload_file(
    bucket_uid: str,
    file: UploadFile = File(...),  # noqa: B008
    api_key: str = Depends(deps.storage_api_key),
):
    bucket = _require_own_bucket(bucket_uid, api_key)
    remaining = settings.storage.bucket_size_bytes - bucket.used_bytes
    original_name = _sanitize_upload_path(file.filename) if file.filename else "unnamed"
    data = await file.read()
    size = len(data)
    if size > remaining:
        raise AppError.bad_request(
            f"File too large: {size} bytes, only {remaining} bytes remaining in bucket"
        )
    file_uid = str(uuid.uuid4())
    sha256 = hashlib.sha256(data).hexdigest()
    deps.store.put_file(bucket_uid, file_uid, data)
    bucket.files.append(
        FileMeta(
            uid=file_uid,
            original_name=original_name,
            size=size,
            sha256=sha256,
            uploaded_at=now_utc(),
        )
    )
    bucket.used_bytes += size
    deps.store.save_bucket(bucket)
    return OffloadJSONResponse(
        status_code=201,
        content={
            "file_uid": file_uid,
            "original_name": original_name,
            "size": size,
            "sha256": sha256,
        },
    )


@router.get("/bucket/{bucket_uid}/stat")
async def bucket_stat(bucket_uid: str, api_key: str = Depends(deps.storage_api_key)) -> dict:
    bucket = _require_own_bucket(bucket_uid, api_key)
    capacity = settings.storage.bucket_size_bytes
    files = [
        {
            "file_uid": f.uid,
            "original_name": f.original_name,
            "size": f.size,
            "uploaded_at": iso_z(f.uploaded_at),
        }
        for f in bucket.files
    ]
    return {
        "bucket_uid": bucket.uid,
        "created_at": iso_z(bucket.created_at),
        "used_bytes": bucket.used_bytes,
        "capacity_bytes": capacity,
        "remaining_bytes": capacity - bucket.used_bytes,
        "file_count": len(files),
        "files": files,
        "rm_after_task": bucket.rm_after_task,
    }


@router.get("/bucket/{bucket_uid}/file/{file_uid}/hash")
async def file_hash(
    bucket_uid: str, file_uid: str, api_key: str = Depends(deps.storage_api_key)
) -> dict:
    bucket = _require_own_bucket(bucket_uid, api_key)
    meta = next((f for f in bucket.files if f.uid == file_uid), None)
    if meta is None:
        raise AppError.not_found(f"File {file_uid} not found")
    return {"file_uid": meta.uid, "sha256": meta.sha256}


@router.get("/bucket/{bucket_uid}/file/{file_uid}")
async def download_file(
    bucket_uid: str, file_uid: str, api_key: str = Depends(deps.storage_api_key)
) -> Response:
    bucket = _require_own_bucket(bucket_uid, api_key)
    meta = next((f for f in bucket.files if f.uid == file_uid), None)
    if meta is None:
        raise AppError.not_found(f"File {file_uid} not found")
    data = deps.store.get_file(bucket_uid, file_uid)
    base_name = meta.original_name.rsplit("/", 1)[-1].replace('"', '\\"')
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"content-disposition": f'attachment; filename="{base_name}"'},
    )


@router.delete("/bucket/{bucket_uid}/file/{file_uid}")
async def delete_file(
    bucket_uid: str, file_uid: str, api_key: str = Depends(deps.storage_api_key)
) -> dict:
    bucket = _require_own_bucket(bucket_uid, api_key)
    idx = next((i for i, f in enumerate(bucket.files) if f.uid == file_uid), None)
    if idx is None:
        raise AppError.not_found(f"File {file_uid} not found")
    meta = bucket.files.pop(idx)
    bucket.used_bytes = max(0, bucket.used_bytes - meta.size)
    deps.store.delete_file(bucket_uid, file_uid)
    deps.store.save_bucket(bucket)
    return {"deleted_file_uid": file_uid}


@router.delete("/bucket/{bucket_uid}")
async def delete_bucket(bucket_uid: str, api_key: str = Depends(deps.storage_api_key)) -> dict:
    _require_own_bucket(bucket_uid, api_key)
    deps.store.delete_bucket(bucket_uid)
    return {"deleted_bucket_uid": bucket_uid}
