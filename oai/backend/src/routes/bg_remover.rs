use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::bg_remover,
    error::AppError,
    middleware::AuthenticatedUser,
    routes::{
        img_utils::{JobImageRef, load_image_ref},
        job_common::{CancelJobResponse, StartJobResponse, parse_id},
    },
    services::bg_remover::{self as service, BgRemoverOptions, CAPABILITY_PREFIX},
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<service::BgRemoverCapability>,
    /// The model the page should preselect when it is available.
    pub default_model: &'static str,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = service::list_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse {
        capabilities,
        default_model: service::DEFAULT_MODEL,
    }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    /// `onnx.bgremove.<model>`, from `GET /api/bg-remover/capabilities`.
    pub capability: String,
    /// `image_files` id from `POST /api/images/upload`.
    pub input_image_id: String,
    /// Every field optional — see [`BgRemoverOptions`].
    #[serde(default)]
    pub options: BgRemoverOptions,
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
            input_image_id: parse_id(&req.input_image_id, "input_image_id")?,
            options: req.options,
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(job_id)),
    ))
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub capability: String,
    /// Capability minus `onnx.bgremove.`, e.g. `birefnet-general`.
    pub model: String,
    pub input_image_id: Option<String>,
    pub output_image_id: Option<String>,
    /// Full metadata for the image slots. Populated on the single-job endpoints only;
    /// the listing leaves them `null` to stay one query.
    pub input_image: Option<JobImageRef>,
    pub output_image: Option<JobImageRef>,
    pub options: BgRemoverOptions,
    /// Mean alpha of the cutout. Near 0: nothing was detected; near 1: the background
    /// was kept. Null until completed.
    pub foreground_ratio: Option<f64>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    /// RFC3339 time execution began on an agent; null while still queued.
    pub started_at: Option<String>,
    /// Heuristic execution-time estimate in seconds; null when unknown.
    pub typical_runtime_seconds: Option<f64>,
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
    let job = service::get_user_job(&state, user_id, job_id).await?;
    Ok(Json(job_details_with_images(&state, user_id, job).await?))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::poll_job(&state, user_id, job_id).await?;
    Ok(Json(job_details_with_images(&state, user_id, job).await?))
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
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(new_id)),
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

fn job_details_response(job: bg_remover::BgRemoverJob) -> JobDetailsResponse {
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        model: job
            .capability
            .strip_prefix(CAPABILITY_PREFIX)
            .unwrap_or(&job.capability)
            .to_string(),
        capability: job.capability,
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        output_image_id: job.output_image_id.map(|id| id.to_string()),
        input_image: None,
        output_image: None,
        options: BgRemoverOptions::from_stored(job.options_json.as_deref()),
        foreground_ratio: job.foreground_ratio,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        started_at: job.started_at.map(|t| t.to_rfc3339()),
        typical_runtime_seconds: job.typical_runtime_seconds.filter(|s| *s > 0.0),
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}

/// Job details with the input/output image metadata resolved. Used by the single-job
/// endpoints, where two extra point lookups are cheap and let the page render a lightbox
/// and hand images to other features without extra requests.
async fn job_details_with_images(
    state: &AppState,
    user_id: i64,
    job: bg_remover::BgRemoverJob,
) -> Result<JobDetailsResponse, AppError> {
    let (input_id, output_id) = (job.input_image_id, job.output_image_id);
    let mut details = job_details_response(job);
    details.input_image = load_image_ref(state, user_id, input_id).await?;
    details.output_image = load_image_ref(state, user_id, output_id).await?;
    Ok(details)
}
