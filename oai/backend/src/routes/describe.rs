use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::image_analysis,
    error::AppError,
    middleware::AuthenticatedUser,
    offload::LlmCapabilityInfo,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::image_analysis as analysis,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<LlmCapabilityInfo>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = analysis::list_vision_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub capability: String,
    pub prompt: String,
    pub image_id: String,
    /// Optional OffloadMQ `dataPreparation` map (glob → action), e.g.
    /// `{"*": "scale/max[px=1024]"}` — rescales the image before analysis.
    #[serde(default)]
    pub data_preparation: Option<HashMap<String, String>>,
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let image_id = parse_id(&req.image_id, "image_id")?;
    let job_id = analysis::start_job(
        &state,
        user_id,
        analysis::StartJobParams {
            capability: req.capability,
            prompt: req.prompt,
            image_id,
            data_preparation: req.data_preparation,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub prompt: String,
    pub capability: String,
    pub input_image_id: Option<String>,
    pub result: Option<String>,
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
    let jobs = analysis::list_user_jobs(&state, user_id, 100).await?;
    Ok(Json(jobs.into_iter().map(job_details_response).collect()))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let detail = analysis::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(job_details_response(detail.job)))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = analysis::poll_job(&state, user_id, job_id).await?;
    Ok(Json(job_details_response(job)))
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let out = analysis::cancel_job(&state, user_id, job_id).await?;
    Ok(Json(out.into()))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let new_id = analysis::retry_job(&state, user_id, job_id).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(new_id))))
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    analysis::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn job_details_response(job: image_analysis::ImageAnalysisJob) -> JobDetailsResponse {
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        prompt: job.prompt,
        capability: job.capability,
        input_image_id: job.input_image_id.map(|i| i.to_string()),
        result: job.result,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}
