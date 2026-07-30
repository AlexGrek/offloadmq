use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::prompts,
    error::AppError,
    middleware::AuthenticatedUser,
    offload::LlmCapabilityInfo,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::movie as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub llm: Vec<LlmCapabilityInfo>,
    pub video: Vec<LlmCapabilityInfo>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let caps = service::list_capabilities(&state, user_id).await?;
    Ok(Json(CapabilitiesResponse { llm: caps.llm, video: caps.video }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub idea: String,
    pub width: i32,
    pub height: i32,
    pub scene_count: i32,
    pub scene_length: i32,
    #[serde(default = "default_true")]
    pub long_shot: bool,
    #[serde(default = "default_true")]
    pub auto_approve: bool,
    #[serde(default = "default_true")]
    pub expand_prompt: bool,
    pub director_model: String,
    pub scene_model: String,
    pub txt2video_capability: String,
    pub img2video_capability: Option<String>,
    pub director_system: Option<String>,
    pub scene_system: Option<String>,
    pub initial_image_id: Option<String>,
}

fn default_true() -> bool {
    true
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let director_system = req
        .director_system
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(service::DEFAULT_DIRECTOR_SYSTEM);
    let scene_system = req
        .scene_system
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(service::DEFAULT_SCENE_SYSTEM);

    if !req.idea.trim().is_empty() {
        let _ = prompts::record_use(&state.db, || state.next_id(), user_id, "movie-idea", &req.idea).await;
    }
    let _ = prompts::record_use(
        &state.db,
        || state.next_id(),
        user_id,
        "movie-director-system",
        director_system,
    )
    .await;
    let _ = prompts::record_use(
        &state.db,
        || state.next_id(),
        user_id,
        "movie-scene-system",
        scene_system,
    )
    .await;

    let job_id = service::start_job(
        &state,
        user_id,
        service::StartJobParams {
            idea: req.idea,
            width: req.width,
            height: req.height,
            scene_count: req.scene_count,
            scene_length: req.scene_length,
            long_shot: req.long_shot,
            auto_approve: req.auto_approve,
            expand_prompt: req.expand_prompt,
            director_model: req.director_model,
            scene_model: req.scene_model,
            txt2video_capability: req.txt2video_capability,
            img2video_capability: req.img2video_capability,
            director_system: director_system.to_string(),
            scene_system: scene_system.to_string(),
            initial_image_id: req.initial_image_id,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

pub type JobDetailsResponse = service::MovieJobView;

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = service::list_user_jobs(&state, user_id, 50).await?;
    let out = jobs.into_iter().map(service::job_view).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(out))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(service::job_view(job)?))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::poll_job(&state, user_id, job_id).await?;
    Ok(Json(service::job_view(job)?))
}

#[derive(Deserialize, Default)]
pub struct ApproveRequest {
    #[serde(default)]
    pub outline: Option<Vec<String>>,
}

pub async fn approve(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
    Json(body): Json<ApproveRequest>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::approve(&state, user_id, job_id, service::ApproveParams { outline: body.outline }).await?;
    Ok(Json(service::job_view(job)?))
}

pub async fn stop(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::stop(&state, user_id, job_id).await?;
    Ok(Json(service::job_view(job)?))
}

pub async fn resume(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::resume(&state, user_id, job_id).await?;
    Ok(Json(service::job_view(job)?))
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

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    service::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
