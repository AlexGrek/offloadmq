use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{entities::img_utils_jobs::Entity as ImgUtilsJobEntity, img_utils, offload_jobs},
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::img_utils as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<service::ImgUtilCapability>,
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
    pub capability: String,
    pub workflow: Option<String>,
    /// `image_files` id from `POST /api/images/upload`.
    pub input_image_id: String,
    /// Second input for utilities that need one (face-swap donor).
    pub source_image_id: Option<String>,
    /// Extra workflow knobs, forwarded as `payload.secondary_prompts`.
    pub options: Option<serde_json::Map<String, serde_json::Value>>,
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let source_image_id = req
        .source_image_id
        .as_deref()
        .map(|s| parse_id(s, "source_image_id"))
        .transpose()?;
    let job_id = service::start_job(
        &state,
        user_id,
        service::StartJobParams {
            capability: req.capability,
            workflow: req.workflow,
            input_image_id: parse_id(&req.input_image_id, "input_image_id")?,
            source_image_id,
            options: req.options,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub capability: String,
    pub utility: String,
    pub workflow: String,
    pub input_image_id: Option<String>,
    pub source_image_id: Option<String>,
    pub output_image_id: Option<String>,
    pub options: Option<serde_json::Map<String, serde_json::Value>>,
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
    let job = offload_jobs::get_job::<ImgUtilsJobEntity>(&state.db, job_id, user_id)
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

fn job_details_response(job: img_utils::ImgUtilsJob) -> JobDetailsResponse {
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        capability: job.capability,
        utility: job.utility,
        workflow: job.workflow,
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        source_image_id: job.source_image_id.map(|id| id.to_string()),
        output_image_id: job.output_image_id.map(|id| id.to_string()),
        options: service::parse_options(job.options_json.as_deref()),
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}
