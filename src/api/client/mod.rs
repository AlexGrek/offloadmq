pub mod service;
pub mod storage;

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use serde_json::json;

use crate::{
    error::AppError,
    middleware::OptionalMgmtOverride,
    mq::types::UrgentSubmitOutcome,
    schema::{ApiKeyRequest, TaskId, TaskSubmissionRequest},
    state::AppState,
};

pub async fn submit_task_blocking(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl IntoResponse, AppError> {
    let outcome = service::do_submit_task_blocking(&app_state, req, mgmt.is_active()).await?;
    Ok(urgent_outcome_to_response(outcome))
}

pub async fn submit_task(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl IntoResponse, AppError> {
    match service::do_submit_task(&app_state, req, mgmt.is_active()).await? {
        service::SubmitOutcome::Urgent(outcome) => Ok(urgent_outcome_to_response(outcome)),
        service::SubmitOutcome::Queued { id, capability } => {
            Ok(Json(json!({
                "id": id,
                "capability": capability,
                "status": "queued",
                "message": "Added to tasks queue"
            }))
            .into_response())
        }
    }
}

pub async fn poll_task_status(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Path((cap, id)): Path<(String, String)>,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = TaskId::from_url(id, cap)?;
    match service::do_poll_task_status(&app_state, task_id, &req.api_key, mgmt.is_active()).await? {
        service::PollOutcome::Found(report) => Ok(Json(report).into_response()),
        service::PollOutcome::FoundUrgent(task) => Ok(Json(task).into_response()),
    }
}

pub async fn cancel_task(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Path((cap, id)): Path<(String, String)>,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = TaskId::from_url(id, cap)?;
    let resp = service::do_cancel_task(&app_state, task_id, &req.api_key, mgmt.is_active())?;
    Ok(Json(resp))
}

pub async fn capabilities_online(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let caps = service::do_capabilities_online(&app_state, &req.api_key, mgmt.is_active(), true)?;
    Ok(Json(caps))
}

pub async fn capabilities_online_ext(
    State(app_state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let caps = service::do_capabilities_online(&app_state, &req.api_key, mgmt.is_active(), false)?;
    Ok(Json(caps))
}

/// Convert an UrgentSubmitOutcome to an Axum response, preserving the original JSON shape.
fn urgent_outcome_to_response(outcome: UrgentSubmitOutcome) -> axum::response::Response {
    match outcome {
        UrgentSubmitOutcome::Completed(task) => Json(task).into_response(),
        UrgentSubmitOutcome::CompletedPartial { id, status, message } => {
            Json(json!({"id": id, "status": status, "message": message})).into_response()
        }
    }
}
