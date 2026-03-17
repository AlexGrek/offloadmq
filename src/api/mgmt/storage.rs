//! Management Storage API handlers.
//!
//! All routes live under `/management/storage` and use the same management
//! token auth as the rest of the management API.
//!
//! Endpoints:
//!   GET    /management/storage/buckets              – list all buckets grouped by API key
//!   GET    /management/storage/quotas               – quotas/usage for all keys (or ?api_key=...)
//!   DELETE /management/storage/bucket/{bucket_uid}  – delete a specific bucket
//!   DELETE /management/storage/key/{api_key}/buckets – delete all buckets of a key
//!   DELETE /management/storage/buckets              – purge all buckets

use std::{collections::HashMap, sync::Arc};

use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;
use tracing::info;

use crate::{error::AppError, state::AppState};

// ── GET /management/storage/buckets ─────────────────────────────────────────

pub async fn list_all_buckets(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let all_buckets = state.storage.buckets.list_all_buckets();

    // Group buckets by api_key
    let mut by_key: HashMap<String, serde_json::Value> = HashMap::new();
    for bucket in &all_buckets {
        let entry = by_key.entry(bucket.api_key.clone()).or_insert_with(|| {
            json!({
                "bucket_count": 0u64,
                "total_files": 0u64,
                "total_bytes": 0u64,
                "buckets": []
            })
        });

        let obj = entry.as_object_mut().unwrap();
        *obj.get_mut("bucket_count").unwrap() =
            json!(obj["bucket_count"].as_u64().unwrap() + 1);
        *obj.get_mut("total_files").unwrap() =
            json!(obj["total_files"].as_u64().unwrap() + bucket.files.len() as u64);
        *obj.get_mut("total_bytes").unwrap() =
            json!(obj["total_bytes"].as_u64().unwrap() + bucket.used_bytes);

        let bucket_summary = json!({
            "bucket_uid":  bucket.uid,
            "created_at":  bucket.created_at,
            "file_count":  bucket.files.len(),
            "used_bytes":  bucket.used_bytes,
            "tasks":       bucket.tasks,
        });
        obj["buckets"].as_array_mut().unwrap().push(bucket_summary);
    }

    Ok(Json(json!({ "buckets_by_key": by_key })))
}

// ── GET /management/storage/quotas ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct QuotaQuery {
    api_key: Option<String>,
}

pub async fn get_quotas(
    State(state): State<Arc<AppState>>,
    Query(params): Query<QuotaQuery>,
) -> Result<impl IntoResponse, AppError> {
    let cfg = &state.config.storage;
    let limits = json!({
        "max_buckets_per_key": cfg.max_buckets_per_key,
        "bucket_size_bytes":   cfg.bucket_size_bytes,
        "bucket_ttl_minutes":  cfg.bucket_ttl_minutes,
    });

    let usage: HashMap<String, serde_json::Value> = if let Some(key) = params.api_key {
        let buckets = state.storage.buckets.list_buckets_for_key(&key);
        let total_bytes: u64 = buckets.iter().map(|b| b.used_bytes).sum();
        let total_files: u64 = buckets.iter().map(|b| b.files.len() as u64).sum();
        let mut map = HashMap::new();
        map.insert(key, json!({
            "bucket_count": buckets.len(),
            "total_bytes":  total_bytes,
            "total_files":  total_files,
        }));
        map
    } else {
        let all_buckets = state.storage.buckets.list_all_buckets();
        let mut map: HashMap<String, (usize, u64, u64)> = HashMap::new(); // (count, bytes, files)
        for bucket in &all_buckets {
            let entry = map.entry(bucket.api_key.clone()).or_default();
            entry.0 += 1;
            entry.1 += bucket.used_bytes;
            entry.2 += bucket.files.len() as u64;
        }
        map.into_iter()
            .map(|(k, (count, bytes, files))| {
                (k, json!({
                    "bucket_count": count,
                    "total_bytes":  bytes,
                    "total_files":  files,
                }))
            })
            .collect()
    };

    Ok(Json(json!({ "limits": limits, "usage": usage })))
}

// ── DELETE /management/storage/bucket/{bucket_uid} ──────────────────────────

pub async fn delete_bucket(
    State(state): State<Arc<AppState>>,
    Path(bucket_uid): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let bucket = state
        .storage
        .buckets
        .get_bucket(&bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

    state
        .storage
        .file_store
        .delete_bucket(&bucket_uid)
        .await
        .map_err(AppError::Internal)?;

    state
        .storage
        .buckets
        .delete_bucket(&bucket_uid, &bucket.api_key)?;

    info!("Management: deleted bucket {}", bucket_uid);
    Ok(Json(json!({ "deleted_bucket_uid": bucket_uid })))
}

// ── DELETE /management/storage/key/{api_key}/buckets ─────────────────────────

pub async fn delete_key_buckets(
    State(state): State<Arc<AppState>>,
    Path(api_key): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let buckets = state.storage.buckets.list_buckets_for_key(&api_key);
    let count = buckets.len();

    for bucket in &buckets {
        if let Err(e) = state.storage.file_store.delete_bucket(&bucket.uid).await {
            log::warn!("Management: failed to delete bucket files {}: {}", bucket.uid, e);
        }
        state.storage.buckets.delete_bucket(&bucket.uid, &api_key)?;
    }

    info!("Management: deleted {} bucket(s) for key ...{}", count, &api_key[api_key.len().saturating_sub(6)..]);
    Ok(Json(json!({ "api_key": api_key, "deleted_count": count })))
}

// ── DELETE /management/storage/buckets ──────────────────────────────────────

pub async fn purge_all_buckets(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let all_buckets = state.storage.buckets.list_all_buckets();
    let count = all_buckets.len();

    for bucket in &all_buckets {
        if let Err(e) = state.storage.file_store.delete_bucket(&bucket.uid).await {
            log::warn!("Management: failed to delete bucket files {}: {}", bucket.uid, e);
        }
        if let Err(e) = state.storage.buckets.delete_bucket(&bucket.uid, &bucket.api_key) {
            log::warn!("Management: failed to delete bucket metadata {}: {}", bucket.uid, e);
        }
    }

    info!("Management: purged all {} bucket(s)", count);
    Ok(Json(json!({ "deleted_count": count })))
}
