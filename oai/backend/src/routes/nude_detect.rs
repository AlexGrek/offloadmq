use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::nude_detect,
    error::AppError,
    middleware::AuthenticatedUser,
    services::nude_detect as detect,
    state::AppState,
};

#[derive(Serialize)]
pub struct AvailabilityResponse {
    pub available: bool,
    pub capability: String,
    pub active_runners: Vec<detect::ActiveRunner>,
    pub runners_error: Option<String>,
}

pub async fn availability(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<AvailabilityResponse>, AppError> {
    let resp = detect::check_availability(&state).await?;
    Ok(Json(AvailabilityResponse {
        available: resp.available,
        capability: resp.capability.to_string(),
        active_runners: resp.active_runners,
        runners_error: resp.runners_error,
    }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub image_id: String,
    pub threshold: f64,
}

#[derive(Serialize)]
pub struct StartJobResponse {
    pub job_id: String,
    pub status: String,
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let image_id = parse_id(&req.image_id, "image_id")?;
    let job_id = detect::start_job(
        &state,
        user_id,
        detect::StartJobParams {
            threshold: req.threshold,
            image_id,
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse {
            job_id: job_id.to_string(),
            status: "submitted".into(),
        }),
    ))
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub threshold: f64,
    pub input_image_id: Option<String>,
    pub result: Option<serde_json::Value>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = detect::list_user_jobs(&state, user_id, 100).await?;
    Ok(Json(jobs.into_iter().map(job_details_response).collect()))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = nude_detect::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(job_details_response(job)))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = detect::poll_job(&state, user_id, job_id).await?;
    Ok(Json(job_details_response(job)))
}

#[derive(Serialize)]
pub struct CancelJobResponse {
    pub job_id: String,
    pub status: String,
    pub message: String,
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let out = detect::cancel_job(&state, user_id, job_id).await?;
    Ok(Json(CancelJobResponse {
        job_id: out.job_id.to_string(),
        status: out.status,
        message: out.message,
    }))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let new_id = detect::retry_job(&state, user_id, job_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse {
            job_id: new_id.to_string(),
            status: "submitted".into(),
        }),
    ))
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    detect::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn job_details_response(job: nude_detect::NudeDetectJob) -> JobDetailsResponse {
    let result = job
        .result
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        threshold: job.threshold,
        input_image_id: job.input_image_id.map(|i| i.to_string()),
        result,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}

fn parse_id(value: &str, field: &str) -> Result<i64, AppError> {
    value.parse::<i64>().map_err(|_| AppError::BadRequest(format!("invalid {field}")))
}
