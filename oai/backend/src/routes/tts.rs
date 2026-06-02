use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::tts,
    error::AppError,
    middleware::AuthenticatedUser,
    services::tts as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<service::TtsCapability>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = service::list_tts_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub capability: String,
    pub voice: String,
    pub text: String,
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
    let job_id = service::start_job(
        &state,
        user_id,
        service::StartJobParams {
            capability: req.capability,
            voice: req.voice,
            text: req.text,
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
    pub text: String,
    pub capability: String,
    pub voice: String,
    pub model: String,
    pub audio_content_type: Option<String>,
    pub audio_size_bytes: Option<i64>,
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
    let jobs = service::list_user_jobs(&state, user_id, 100).await?;
    Ok(Json(jobs.into_iter().map(job_details_response).collect()))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let detail = service::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(job_details_response(detail.job)))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::poll_job(&state, user_id, job_id).await?;
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
    let out = service::cancel_job(&state, user_id, job_id).await?;
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
    let new_id = service::retry_job(&state, user_id, job_id).await?;
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
    service::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_audio(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let (bytes, content_type) = service::audio_bytes(&state, user_id, job_id).await?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("audio/wav")),
    );
    Ok((StatusCode::OK, headers, bytes))
}

fn job_details_response(job: tts::TtsJob) -> JobDetailsResponse {
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        text: job.text,
        capability: job.capability,
        voice: job.voice,
        model: job.model,
        audio_content_type: job.audio_content_type,
        audio_size_bytes: job.audio_size_bytes,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}

fn parse_id(value: &str, field: &str) -> Result<i64, AppError> {
    value
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest(format!("invalid {field}")))
}
