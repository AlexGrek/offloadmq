//! Client-facing Storage API handlers.
//!
//! All routes live under `/api/storage`.  Auth is via the `X-API-Key` header
//! carrying the caller's **regular client API key** — the same key used for
//! task submission.  A separate header is used (instead of a JSON body field)
//! because some endpoints are GET / DELETE / multipart and have no JSON body.
//!
//! Endpoints:
//!   GET    /api/storage/limits                        – query limits for this key
//!   POST   /api/storage/bucket/create                 – create a new bucket
//!   POST   /api/storage/bucket/{bucket_uid}/upload    – upload a file (multipart/form-data)
//!   GET    /api/storage/bucket/{bucket_uid}/stat      – list files + remaining space
//!   GET    /api/storage/bucket/{bucket_uid}/file/{file_uid}/hash  – SHA-256 of a file
//!   DELETE /api/storage/bucket/{bucket_uid}/file/{file_uid}       – delete a single file
//!   DELETE /api/storage/bucket/{bucket_uid}           – delete the whole bucket

use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use log::info;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    db::bucket_storage::FileMeta,
    error::AppError,
    middleware::StorageApiKey,
    state::AppState,
};

// ── GET /api/storage/buckets ─────────────────────────────────────────────────

pub async fn list_buckets(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
) -> impl IntoResponse {
    let buckets = state.storage.buckets.list_buckets_for_key(&api_key);
    let capacity = state.config.storage.bucket_size_bytes;
    let list: Vec<_> = buckets
        .iter()
        .map(|b| {
            json!({
                "bucket_uid":      b.uid,
                "created_at":      b.created_at,
                "file_count":      b.files.len(),
                "used_bytes":      b.used_bytes,
                "remaining_bytes": capacity.saturating_sub(b.used_bytes),
                "tasks":           b.tasks,
            })
        })
        .collect();
    Json(json!({ "buckets": list }))
}

// ── GET /api/storage/limits ──────────────────────────────────────────────────

pub async fn get_limits(
    State(state): State<Arc<AppState>>,
    StorageApiKey(_api_key): StorageApiKey,
) -> impl IntoResponse {
    let cfg = &state.config.storage;
    Json(json!({
        "max_buckets_per_key": cfg.max_buckets_per_key,
        "bucket_size_bytes":   cfg.bucket_size_bytes,
        "bucket_ttl_minutes":  cfg.bucket_ttl_minutes,
    }))
}

// ── POST /api/storage/bucket/create ─────────────────────────────────────────

pub async fn create_bucket(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
) -> Result<impl IntoResponse, AppError> {
    let cfg = &state.config.storage;
    let current = state.storage.buckets.count_buckets_for_key(&api_key);
    if current >= cfg.max_buckets_per_key {
        return Err(AppError::Conflict(format!(
            "Bucket limit reached ({}/{})",
            current, cfg.max_buckets_per_key
        )));
    }
    let bucket = state.storage.buckets.create_bucket(&api_key)?;
    info!("Created bucket {} for key ...{}", bucket.uid, &api_key[api_key.len().saturating_sub(6)..]);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "bucket_uid": bucket.uid, "created_at": bucket.created_at })),
    ))
}

// ── POST /api/storage/bucket/{bucket_uid}/upload ─────────────────────────────
//
// Expects multipart/form-data with a single field named "file".
// The Content-Disposition filename is used as original_name.
// Early rejection via Content-Length header; authoritative check after reading.

pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
    Path(bucket_uid): Path<String>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let mut bucket = require_own_bucket(&state, &bucket_uid, &api_key)?;
    let remaining = state.config.storage.bucket_size_bytes - bucket.used_bytes;

    // Walk multipart fields; process the first "file" field.
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }

        let original_name = field
            .file_name()
            .unwrap_or("unnamed")
            .to_string();

        // Read all bytes (Content-Length is advisory only; we recheck below).
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;

        let size = data.len() as u64;
        if size > remaining {
            return Err(AppError::BadRequest(format!(
                "File too large: {} bytes, only {} bytes remaining in bucket",
                size, remaining
            )));
        }

        let file_uid = uuid::Uuid::new_v4().to_string();
        let sha256: String = Sha256::digest(&data)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        state
            .storage
            .file_store
            .put(&bucket_uid, &file_uid, data.to_vec())
            .await
            .map_err(|e| AppError::Internal(e))?;

        let file_meta = FileMeta {
            uid: file_uid.clone(),
            original_name: original_name.clone(),
            size,
            sha256: sha256.clone(),
            uploaded_at: chrono::Utc::now(),
        };
        bucket.files.push(file_meta);
        bucket.used_bytes += size;
        state.storage.buckets.save_bucket(&bucket)?;

        info!(
            "Uploaded file {} ({} bytes) to bucket {}",
            original_name, size, bucket_uid
        );

        return Ok((
            StatusCode::CREATED,
            Json(json!({
                "file_uid":      file_uid,
                "original_name": original_name,
                "size":          size,
                "sha256":        sha256,
            })),
        ));
    }

    Err(AppError::BadRequest(
        "No 'file' field found in multipart body".to_string(),
    ))
}

// ── GET /api/storage/bucket/{bucket_uid}/stat ────────────────────────────────

pub async fn bucket_stat(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
    Path(bucket_uid): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let bucket = require_own_bucket(&state, &bucket_uid, &api_key)?;
    let capacity = state.config.storage.bucket_size_bytes;
    let files: Vec<_> = bucket
        .files
        .iter()
        .map(|f| {
            json!({
                "file_uid":      f.uid,
                "original_name": f.original_name,
                "size":          f.size,
                "uploaded_at":   f.uploaded_at,
            })
        })
        .collect();

    Ok(Json(json!({
        "bucket_uid":      bucket.uid,
        "created_at":      bucket.created_at,
        "used_bytes":      bucket.used_bytes,
        "capacity_bytes":  capacity,
        "remaining_bytes": capacity - bucket.used_bytes,
        "file_count":      files.len(),
        "files":           files,
    })))
}

// ── GET /api/storage/bucket/{bucket_uid}/file/{file_uid}/hash ────────────────

pub async fn file_hash(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
    Path((bucket_uid, file_uid)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let bucket = require_own_bucket(&state, &bucket_uid, &api_key)?;
    let file = bucket
        .files
        .iter()
        .find(|f| f.uid == file_uid)
        .ok_or_else(|| AppError::NotFound(format!("File {} not found", file_uid)))?;

    Ok(Json(json!({
        "file_uid": file.uid,
        "sha256":   file.sha256,
    })))
}

// ── DELETE /api/storage/bucket/{bucket_uid}/file/{file_uid} ─────────────────

pub async fn delete_file(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
    Path((bucket_uid, file_uid)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let mut bucket = require_own_bucket(&state, &bucket_uid, &api_key)?;
    let idx = bucket
        .files
        .iter()
        .position(|f| f.uid == file_uid)
        .ok_or_else(|| AppError::NotFound(format!("File {} not found", file_uid)))?;

    let file = bucket.files.remove(idx);
    bucket.used_bytes = bucket.used_bytes.saturating_sub(file.size);

    state
        .storage
        .file_store
        .delete_file(&bucket_uid, &file_uid)
        .await
        .map_err(|e| AppError::Internal(e))?;

    state.storage.buckets.save_bucket(&bucket)?;

    Ok(Json(json!({ "deleted_file_uid": file_uid })))
}

// ── DELETE /api/storage/bucket/{bucket_uid} ──────────────────────────────────

pub async fn delete_bucket(
    State(state): State<Arc<AppState>>,
    StorageApiKey(api_key): StorageApiKey,
    Path(bucket_uid): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    // Verify ownership before deleting.
    require_own_bucket(&state, &bucket_uid, &api_key)?;

    state
        .storage
        .file_store
        .delete_bucket(&bucket_uid)
        .await
        .map_err(|e| AppError::Internal(e))?;

    state
        .storage
        .buckets
        .delete_bucket(&bucket_uid, &api_key)?;

    info!("Deleted bucket {}", bucket_uid);
    Ok(Json(json!({ "deleted_bucket_uid": bucket_uid })))
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn require_own_bucket(
    state: &AppState,
    bucket_uid: &str,
    api_key: &str,
) -> Result<crate::db::bucket_storage::BucketMeta, AppError> {
    let bucket = state
        .storage
        .buckets
        .get_bucket(bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

    if bucket.api_key != api_key {
        return Err(AppError::Authorization("Bucket not owned by this key".to_string()));
    }
    Ok(bucket)
}
