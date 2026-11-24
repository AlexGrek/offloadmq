//! VR Worlds routes: the standard offload-job set under `/api/worlds/jobs`, the
//! scene/preview blobs, share links, and the signed public blob endpoints the
//! headset uses without logging in.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{image_generation, worlds},
    error::AppError,
    middleware::{AuthenticatedUser, cache},
    routes::{
        img_utils::JobImageRef,
        job_common::{CancelJobResponse, StartJobResponse, parse_id},
    },
    services::{oauth::public_base_url, storage, worlds as service},
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<service::WorldCapability>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    Ok(Json(CapabilitiesResponse { capabilities: service::list_capabilities(&state).await? }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub capability: String,
    /// `image_files` id from the image library or `POST /api/images/upload`.
    pub input_image_id: String,
    /// `mode`, `max_width`, `fill_lean`, `hfov`, `near`, `far` — all optional;
    /// `prompt`, `pitch`, `seed` are used by `world.pano360` only.
    #[serde(flatten)]
    pub params: service::WorldParamsInput,
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
            params: req.params,
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
    /// Requested mode (`auto` / `perspective` / `pano`); the resolved one is `result.mode`.
    pub mode: String,
    pub params: Option<service::WorldParams>,
    pub input_image_id: Option<String>,
    /// Populated on single-job endpoints only.
    pub input_image: Option<JobImageRef>,
    /// Agent summary: `mode`, `splat_count`, `depth_range_m`, `timings`, `source`, …
    pub result: Option<serde_json::Value>,
    pub has_scene: bool,
    pub has_preview: bool,
    pub ply_bytes: Option<i64>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub started_at: Option<String>,
    pub typical_runtime_seconds: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

fn details(job: worlds::WorldJob) -> JobDetailsResponse {
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        capability: job.capability,
        mode: job.mode,
        params: service::parse_params(&job.params_json),
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        input_image: None,
        result: job.result_json.as_deref().and_then(|s| serde_json::from_str(s).ok()),
        has_scene: job.ply_path.is_some(),
        has_preview: job.preview_path.is_some(),
        ply_bytes: job.ply_bytes,
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

async fn details_with_image(state: &AppState, user_id: i64, job: worlds::WorldJob) -> Result<JobDetailsResponse, AppError> {
    let input_id = job.input_image_id;
    let mut out = details(job);
    if let Some(id) = input_id {
        out.input_image = image_generation::get_image_file(&state.db, id, user_id).await?.map(|f| JobImageRef {
            image_id: f.id.to_string(),
            filename: f.filename,
            content_type: f.content_type,
            width: f.stored_width,
            height: f.stored_height,
            size_bytes: f.stored_bytes,
            rescaled: f.rescaled,
            reencoded: f.reencoded,
            direction: f.direction,
        });
    }
    Ok(out)
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = service::list_user_jobs(&state, user_id, 100).await?;
    Ok(Json(jobs.into_iter().map(details).collect()))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job = service::get_user_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    Ok(Json(details_with_image(&state, user_id, job).await?))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job = service::poll_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    Ok(Json(details_with_image(&state, user_id, job).await?))
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let out = service::cancel_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    Ok(Json(out.into()))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let new_id = service::retry_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(new_id))))
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::delete_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn share(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<service::ShareLink>, AppError> {
    let base = public_base_url(&headers);
    Ok(Json(service::share_link(&state, &base, user_id, parse_id(&id, "job_id")?).await?))
}

// --------------------------------------------------------------------------- blobs

#[derive(Clone, Copy)]
enum Blob {
    Scene,
    Preview,
}

async fn serve_blob(
    state: &AppState,
    job: &worlds::WorldJob,
    blob: Blob,
    headers: &HeaderMap,
    cache_control: HeaderValue,
) -> Result<Response, AppError> {
    let (path, content_type, filename) = match blob {
        Blob::Scene => (job.ply_path.as_deref(), "application/octet-stream", format!("world-{}.ply", job.id)),
        Blob::Preview => (job.preview_path.as_deref(), "image/png", format!("world-{}-preview.png", job.id)),
    };
    let path = path.ok_or(AppError::NotFound)?;
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let mut resp = storage::stream_file(storage::operator(state)?, path, content_type, range).await?;
    if resp.status().is_success() {
        let h = resp.headers_mut();
        h.insert(header::CACHE_CONTROL, cache_control);
        h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
        if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{filename}\"")) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(resp)
}

async fn owned_blob(
    state: Arc<AppState>,
    user_id: i64,
    id: String,
    headers: HeaderMap,
    blob: Blob,
) -> Result<Response, AppError> {
    let job = service::get_user_job(&state, user_id, parse_id(&id, "job_id")?).await?;
    // Written once per job id, so the URL's bytes never change.
    serve_blob(&state, &job, blob, &headers, cache::IMMUTABLE_PRIVATE).await
}

pub async fn get_scene(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    owned_blob(state, user_id, id, headers, Blob::Scene).await
}

pub async fn get_preview(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    owned_blob(state, user_id, id, headers, Blob::Preview).await
}

#[derive(Deserialize)]
pub struct SignedQuery {
    u: i64,
    exp: i64,
    sig: String,
}

async fn public_blob(state: Arc<AppState>, id: String, q: SignedQuery, headers: HeaderMap, blob: Blob) -> Result<Response, AppError> {
    let job_id = parse_id(&id, "job_id").map_err(|_| AppError::Forbidden)?;
    let job = service::verify_public(&state, job_id, q.u, q.exp, &q.sig).await?;
    let mut resp = serve_blob(&state, &job, blob, &headers, HeaderValue::from_static("private, max-age=3600")).await?;
    resp.headers_mut().insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    Ok(resp)
}

/// `GET /api/worlds/public/{id}/scene.ply?u&exp&sig` — authorized by the signature alone.
pub async fn public_scene(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<SignedQuery>,
) -> Result<Response, AppError> {
    public_blob(state, id, q, headers, Blob::Scene).await
}

pub async fn public_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<SignedQuery>,
) -> Result<Response, AppError> {
    public_blob(state, id, q, headers, Blob::Preview).await
}
