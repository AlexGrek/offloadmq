use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;

use crate::{error::AppError, state::AppState};

#[derive(Deserialize)]
pub struct EstimateDurationQuery {
    pub capability: String,
    pub machine_id: String,
}

#[derive(Deserialize)]
pub struct RecordsQuery {
    pub capability: Option<String>,
    pub runner_id: Option<String>,
    pub machine_id: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

/// GET /management/heuristics/records
/// Paginated listing of raw heuristic records with optional filters.
pub async fn list_records(
    State(state): State<Arc<AppState>>,
    Query(params): Query<RecordsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = params.limit.unwrap_or(50);
    let (items, next_cursor) = state
        .storage
        .heuristics
        .list_paginated(
            params.capability.as_deref(),
            params.runner_id.as_deref(),
            params.machine_id.as_deref(),
            limit,
            params.cursor.as_deref(),
        )
        .map_err(AppError::Internal)?;

    Ok(Json(json!({
        "items": items,
        "count": items.len(),
        "next_cursor": next_cursor,
    })))
}

/// GET /management/heuristics/stats/runners
/// Aggregated execution stats per (capability, runner_id) pair.
pub async fn list_runner_stats(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let raw = state
        .storage
        .heuristics
        .list_runner_stats()
        .map_err(AppError::Internal)?;

    let items: Vec<_> = raw
        .into_iter()
        .map(|(capability, runner_id, s)| {
            json!({
                "capability": capability,
                "runnerId": runner_id,
                "totalRuns": s.total_runs,
                "successCount": s.success_count,
                "failCount": s.fail_count,
                "successPct": s.success_pct,
                "successAvgMs": s.success_avg_ms,
                "successMinMs": s.success_min_ms,
                "successMaxMs": s.success_max_ms,
                "failAvgMs": s.fail_avg_ms,
                "failMinMs": s.fail_min_ms,
                "failMaxMs": s.fail_max_ms,
            })
        })
        .collect();

    Ok(Json(json!({ "items": items, "count": items.len() })))
}

/// GET /management/heuristics/estimate_duration?capability=foo&machine_id=bar
/// Returns the estimated typical execution time for a capability on a given machine.
/// Prefers machine-specific data (≥2 successful runs); falls back to global average.
/// Returns `null` when there is insufficient data.
pub async fn estimate_duration(
    State(state): State<Arc<AppState>>,
    Query(params): Query<EstimateDurationQuery>,
) -> Result<impl IntoResponse, AppError> {
    let duration = state
        .storage
        .heuristics
        .estimate_duration(&params.capability, &params.machine_id)
        .map_err(AppError::Internal)?;

    Ok(Json(json!({
        "capability": params.capability,
        "machineId": params.machine_id,
        "estimatedMs": duration.map(|d| d.as_millis()),
    })))
}

/// GET /management/heuristics/stats/machines
/// Aggregated execution stats per (capability, machine_id) pair.
pub async fn list_machine_stats(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let raw = state
        .storage
        .heuristics
        .list_machine_stats()
        .map_err(AppError::Internal)?;

    let items: Vec<_> = raw
        .into_iter()
        .map(|(capability, machine_id, s)| {
            json!({
                "capability": capability,
                "machineId": machine_id,
                "totalRuns": s.total_runs,
                "successCount": s.success_count,
                "failCount": s.fail_count,
                "successPct": s.success_pct,
                "successAvgMs": s.success_avg_ms,
                "successMinMs": s.success_min_ms,
                "successMaxMs": s.success_max_ms,
                "failAvgMs": s.fail_avg_ms,
                "failMinMs": s.fail_min_ms,
                "failMaxMs": s.fail_max_ms,
            })
        })
        .collect();

    Ok(Json(json!({ "items": items, "count": items.len() })))
}
