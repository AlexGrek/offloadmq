use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{entities::music_generation_jobs::Entity as MusicJobEntity, music_generation, offload_jobs},
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::music_generation as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<service::MusicCapability>,
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
    pub tags: String,
    pub lyrics: Option<String>,
    pub bpm: Option<i32>,
    #[serde(default = "default_duration")]
    pub duration: i32,
    pub seed: Option<i32>,
    pub language: Option<String>,
    pub keyscale: Option<String>,
    pub cfg_scale: Option<f64>,
    pub temperature: Option<f64>,
}

fn default_duration() -> i32 {
    30
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
            tags: req.tags,
            lyrics: req.lyrics,
            bpm: req.bpm,
            duration: req.duration,
            seed: req.seed,
            language: req.language,
            keyscale: req.keyscale,
            cfg_scale: req.cfg_scale,
            temperature: req.temperature,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

#[derive(Serialize)]
pub struct AudioTrackInfo {
    pub track: usize,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub capability: String,
    pub tags: String,
    pub lyrics: Option<String>,
    pub bpm: Option<i32>,
    pub duration: i32,
    pub seed: Option<i32>,
    pub language: Option<String>,
    pub keyscale: Option<String>,
    pub cfg_scale: Option<f64>,
    pub temperature: Option<f64>,
    pub result_seed: Option<i32>,
    pub audio_tracks: Vec<AudioTrackInfo>,
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
    let job = offload_jobs::get_job::<MusicJobEntity>(&state.db, job_id, user_id)
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

pub async fn get_audio(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path((job_id_str, track_str)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let track: usize = track_str
        .parse()
        .map_err(|_| AppError::BadRequest("invalid track index".into()))?;
    let (bytes, content_type, _filename) =
        service::audio_bytes(&state, user_id, job_id, track).await?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("audio/mpeg")),
    );
    Ok((StatusCode::OK, headers, bytes))
}

fn job_details_response(job: music_generation::MusicJob) -> JobDetailsResponse {
    let audio_tracks = service::parse_audio_files(job.audio_files_json.as_deref())
        .into_iter()
        .enumerate()
        .map(|(i, r)| AudioTrackInfo {
            track: i,
            filename: r.filename,
            content_type: r.content_type,
            size_bytes: r.size_bytes,
        })
        .collect();
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        capability: job.capability,
        tags: job.tags,
        lyrics: job.lyrics,
        bpm: job.bpm,
        duration: job.duration,
        seed: job.seed,
        language: job.language,
        keyscale: job.keyscale,
        cfg_scale: job.cfg_scale,
        temperature: job.temperature,
        result_seed: job.result_seed,
        audio_tracks,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}
