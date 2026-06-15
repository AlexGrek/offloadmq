use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{llm_compare, prompts},
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::llm_compare as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<crate::offload::LlmCapabilityInfo>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = service::list_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub models: Vec<String>,
    pub system_prompt: Option<String>,
    pub user_prompt: String,
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    if let Some(system) = req.system_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        let _ = prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "llm-compare-system",
            system,
        )
        .await;
    }
    if !req.user_prompt.trim().is_empty() {
        let _ = prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "llm-compare-user",
            &req.user_prompt,
        )
        .await;
    }

    let job_id = service::start_job(
        &state,
        user_id,
        service::StartJobParams {
            models: req.models,
            system_prompt: req.system_prompt.unwrap_or_default(),
            user_prompt: req.user_prompt,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

#[derive(Serialize)]
pub struct CompareSlotResponse {
    pub model: String,
    pub status: String,
    pub content: Option<String>,
    pub log: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub slots: Vec<CompareSlotResponse>,
    pub error: Option<String>,
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
    let job = service::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(job_details_response(job)))
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

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let out = service::cancel_job(&state, user_id, job_id).await?;
    Ok(Json(out.into()))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let new_id = service::retry_job(&state, user_id, job_id).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(new_id))))
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

fn job_details_response(job: llm_compare::LlmCompareJob) -> JobDetailsResponse {
    let slots = service::parse_job_slots(&job)
        .unwrap_or_default()
        .into_iter()
        .map(|s| CompareSlotResponse {
            model: s.model,
            status: s.status,
            content: s.content,
            log: s.log,
            error: s.error,
        })
        .collect();
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        system_prompt: job.system_prompt,
        user_prompt: job.user_prompt,
        slots,
        error: job.error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}
