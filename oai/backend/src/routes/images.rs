use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::image_generation,
    error::AppError,
    middleware::AuthenticatedUser,
    services::{
        image_jobs::{self, JobDetail, StartJobParams},
        image_pipeline_params::ImagePipelineParams,
    },
    state::AppState,
};

#[derive(Serialize)]
pub struct StartJobResponse {
    pub job_id: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct UploadResponse {
    pub image_id: String,
    pub filename: String,
    pub content_type: String,
    pub width: i32,
    pub height: i32,
    pub size_bytes: i64,
    pub rescaled: bool,
    pub reencoded: bool,
}

#[derive(Serialize)]
pub struct PollResponse {
    pub job_id: String,
    pub status: String,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub output_images: Vec<ImageRef>,
}

#[derive(Serialize)]
pub struct ImageRef {
    pub image_id: String,
    pub filename: String,
    pub width: i32,
    pub height: i32,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub display_name: String,
    pub status: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub capability: String,
    pub workflow: String,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub input_image_id: Option<String>,
    pub pipeline_params: ImagePipelineParams,
    pub error: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub files: Vec<JobFile>,
    pub events: Vec<JobEvent>,
}

#[derive(Serialize)]
pub struct ImgGenCapability {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
    pub online: bool,
    pub last_available_at: String,
}

#[derive(Serialize)]
pub struct JobFile {
    pub image_id: String,
    pub direction: String,
    pub source: String,
    pub filename: String,
    pub content_type: String,
    pub width: i32,
    pub height: i32,
    pub size_bytes: i64,
    pub rescaled: bool,
    pub reencoded: bool,
}

#[derive(Serialize)]
pub struct JobEvent {
    pub step: String,
    pub state: String,
    pub details: Option<String>,
    pub created_at: String,
}

pub async fn upload_input_image(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let (filename, bytes, content_type) = read_upload(multipart).await?;
    let file = image_jobs::upload_input_image(&state, user_id, filename, bytes, content_type).await?;
    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            image_id: file.id.to_string(),
            filename: file.filename,
            content_type: file.content_type,
            width: file.stored_width,
            height: file.stored_height,
            size_bytes: file.stored_bytes,
            rescaled: file.rescaled,
            reencoded: file.reencoded,
        }),
    ))
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobParams>,
) -> Result<impl IntoResponse, AppError> {
    // Record the prompts as recents (best-effort) for cross-job reuse, so the
    // frontend doesn't need a second request to maintain the recents lists.
    if !req.prompt.trim().is_empty() {
        let _ = crate::db::prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "imggen-prompt",
            &req.prompt,
        )
        .await;
    }
    if let Some(neg) = req.negative_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        let _ = crate::db::prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "imggen-negative",
            neg,
        )
        .await;
    }

    let job_id = image_jobs::start_job(&state, user_id, req).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse { job_id: job_id.to_string(), status: "submitted".into() }),
    ))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<PollResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let polled = image_jobs::poll_job(&state, user_id, job_id).await?;
    Ok(Json(PollResponse {
        job_id: job_id.to_string(),
        status: polled.status,
        stage: polled.stage,
        error: polled.error,
        output_images: polled.output_files.into_iter().map(map_image_ref).collect(),
    }))
}

#[derive(Serialize)]
pub struct CancelJobResponse {
    pub job_id: String,
    pub status: String,
    pub message: String,
    pub offload_cap: String,
    pub offload_task_id: String,
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    image_jobs::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let out = image_jobs::cancel_job(&state, user_id, job_id).await?;
    Ok(Json(CancelJobResponse {
        job_id: out.job_id.to_string(),
        status: out.status,
        message: out.message,
        offload_cap: out.offload_cap,
        offload_task_id: out.offload_task_id,
    }))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let new_id = image_jobs::retry_job(&state, user_id, job_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse {
            job_id: new_id.to_string(),
            status: "submitted".into(),
        }),
    ))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let detail = image_jobs::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(job_details_response(detail)))
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let details = image_jobs::list_user_job_details(&state, user_id, 50).await?;
    Ok(Json(details.into_iter().map(job_details_response).collect()))
}

pub async fn list_imggen_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_user_id): AuthenticatedUser,
) -> Result<Json<Vec<ImgGenCapability>>, AppError> {
    let caps = image_jobs::list_imggen_capabilities(&state).await?;
    Ok(Json(
        caps.into_iter()
            .map(|c| ImgGenCapability {
                base: c.base,
                tags: c.tags,
                raw: c.raw,
                online: c.online,
                last_available_at: c.last_available_at,
            })
            .collect(),
    ))
}

pub async fn get_image(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let image_id = parse_id(&image_id_str, "image_id")?;
    let (bytes, content_type) = image_jobs::image_bytes(&state, user_id, image_id).await?;
    Ok(image_jpeg_response(bytes, &content_type))
}

pub async fn get_image_thumbnail(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let image_id = parse_id(&image_id_str, "image_id")?;
    let bytes = image_jobs::image_thumbnail_bytes(&state, user_id, image_id).await?;
    Ok(image_jpeg_response(bytes, "image/jpeg"))
}

#[derive(Serialize)]
pub struct ImageStarredResponse {
    pub starred: bool,
}

pub async fn get_image_starred(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
) -> Result<Json<ImageStarredResponse>, AppError> {
    let image_id = parse_id(&image_id_str, "image_id")?;
    let starred = image_jobs::image_is_starred(&state, user_id, image_id).await?;
    Ok(Json(ImageStarredResponse { starred }))
}

#[derive(Deserialize)]
pub struct SetImageStarredRequest {
    pub starred: bool,
}

pub async fn set_image_starred(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
    Json(req): Json<SetImageStarredRequest>,
) -> Result<Json<ImageStarredResponse>, AppError> {
    let image_id = parse_id(&image_id_str, "image_id")?;
    let starred = image_jobs::set_image_starred(&state, user_id, image_id, req.starred).await?;
    Ok(Json(ImageStarredResponse { starred }))
}

pub async fn delete_image(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let image_id = parse_id(&image_id_str, "image_id")?;
    image_jobs::remove_user_image(&state, user_id, image_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn image_jpeg_response(bytes: Vec<u8>, content_type: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).unwrap_or(HeaderValue::from_static("image/jpeg")),
    );
    (StatusCode::OK, headers, bytes)
}

// ── Shared DTO mapping (also used by the admin routes) ──────────────────────

pub fn job_details_response(detail: JobDetail) -> JobDetailsResponse {
    let JobDetail {
        job,
        files,
        events,
        offload_cap,
        offload_task_id,
    } = detail;
    let pipeline_params = image_jobs::pipeline_params_for_job(&job);
    let display_name = image_jobs::display_name_for_job(&job);
    JobDetailsResponse {
        job_id: job.id.to_string(),
        display_name,
        status: job.status,
        prompt: job.prompt,
        negative_prompt: job.negative_prompt,
        capability: job.capability,
        workflow: job.workflow,
        width: job.width,
        height: job.height,
        seed: job.seed,
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        pipeline_params,
        error: job.error,
        offload_cap,
        offload_task_id,
        files: files.into_iter().map(map_job_file).collect(),
        events: events.into_iter().map(map_job_event).collect(),
    }
}

fn map_job_file(f: image_generation::ImageFile) -> JobFile {
    JobFile {
        image_id: f.id.to_string(),
        direction: f.direction,
        source: f.source,
        filename: f.filename,
        content_type: f.content_type,
        width: f.stored_width,
        height: f.stored_height,
        size_bytes: f.stored_bytes,
        rescaled: f.rescaled,
        reencoded: f.reencoded,
    }
}

fn map_job_event(e: image_generation::ImagePipelineEvent) -> JobEvent {
    JobEvent {
        step: e.step,
        state: e.state,
        details: e.details,
        created_at: e.created_at.to_rfc3339(),
    }
}

fn map_image_ref(f: image_generation::ImageFile) -> ImageRef {
    ImageRef {
        image_id: f.id.to_string(),
        filename: f.filename,
        width: f.stored_width,
        height: f.stored_height,
        content_type: f.content_type,
        size_bytes: f.stored_bytes,
    }
}

fn parse_id(value: &str, field: &str) -> Result<i64, AppError> {
    value.parse::<i64>().map_err(|_| AppError::BadRequest(format!("invalid {field}")))
}

async fn read_upload(mut multipart: Multipart) -> Result<(String, Vec<u8>, String), AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart read error: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "upload.jpg".into());
        let content_type = field
            .content_type()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "application/octet-stream".into());
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("multipart field read error: {e}")))?;
        return Ok((filename, bytes.to_vec(), content_type));
    }
    Err(AppError::BadRequest("missing multipart field `file`".into()))
}
