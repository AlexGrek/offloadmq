use std::io::Cursor;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
};
use base64::Engine;
use image::{
    DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder, ImageFormat, ImageReader,
    codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    db::{app_settings, image_generation},
    error::AppError,
    middleware::AuthenticatedUser,
    offload::{OffloadClient, image_tasks::{OffloadImageClient, OffloadTaskId}},
    state::AppState,
};

const MAX_IMAGE_EDGE: u32 = 1920;
const JPEG_QUALITY: u8 = 88;
const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub capability: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub workflow: Option<String>,
    pub input_image_id: Option<String>,
}

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
    pub status: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub capability: String,
    pub workflow: String,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub input_image_id: Option<String>,
    pub error: Option<String>,
    pub files: Vec<JobFile>,
    pub events: Vec<JobEvent>,
}

#[derive(Serialize)]
pub struct ImgGenCapability {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
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

struct ProcessedImage {
    bytes: Vec<u8>,
    content_type: String,
    width: i32,
    height: i32,
    original_width: Option<i32>,
    original_height: Option<i32>,
    original_bytes: Option<i64>,
    rescaled: bool,
    reencoded: bool,
    exif_orientation: Option<i32>,
    sha256: String,
}

pub async fn upload_input_image(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    ensure_storage_enabled(&state)?;
    let (filename, bytes, content_type) = read_upload(multipart).await?;
    let processed = process_image(bytes, Some(content_type))?;

    let image_id = state.next_id();
    let storage_path = format!("users/{user_id}/images/input/{image_id}.jpg");
    write_storage(
        state.storage.as_ref().expect("checked"),
        &storage_path,
        processed.bytes.clone(),
    )
    .await?;

    image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: image_id,
            user_id,
            job_id: None,
            direction: "input",
            source: "upload",
            storage_path: &storage_path,
            filename: &filename,
            content_type: &processed.content_type,
            original_bytes: processed.original_bytes,
            stored_bytes: processed.bytes.len() as i64,
            original_width: processed.original_width,
            original_height: processed.original_height,
            stored_width: processed.width,
            stored_height: processed.height,
            exif_orientation: processed.exif_orientation,
            rescaled: processed.rescaled,
            reencoded: processed.reencoded,
            sha256: &processed.sha256,
            offload_bucket_uid: None,
            offload_file_uid: None,
        },
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            image_id: image_id.to_string(),
            filename,
            content_type: processed.content_type,
            width: processed.width,
            height: processed.height,
            size_bytes: processed.bytes.len() as i64,
            rescaled: processed.rescaled,
            reencoded: processed.reencoded,
        }),
    ))
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    ensure_storage_enabled(&state)?;
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    if !req.capability.starts_with("imggen.") {
        return Err(AppError::BadRequest("capability must start with imggen.".into()));
    }

    let workflow = req.workflow.unwrap_or_else(|| {
        if req.input_image_id.is_some() {
            "img2img".to_string()
        } else {
            "txt2img".to_string()
        }
    });

    let job_id = state.next_id();
    image_generation::create_job(
        &state.db,
        image_generation::NewJobInput {
            id: job_id,
            user_id,
            prompt: req.prompt.trim(),
            negative_prompt: req.negative_prompt.as_deref(),
            capability: &req.capability,
            workflow: &workflow,
            width: req.width,
            height: req.height,
            seed: req.seed,
            input_image_id: req.input_image_id.as_deref().and_then(|s| s.parse().ok()),
        },
    )
    .await?;
    record_event(&state, job_id, "job.created", "ok", None).await?;

    let client = offload_client(&state).await?;
    let output_bucket = client.create_bucket(false).await?;
    record_event(
        &state,
        job_id,
        "offload.output_bucket.create",
        "ok",
        Some(&format!("bucket={}", output_bucket.bucket_uid)),
    )
    .await?;

    let mut input_bucket_uid: Option<String> = None;
    if let Some(input_id_str) = &req.input_image_id {
        let input_image_id = input_id_str
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("invalid input_image_id".into()))?;
        let input = get_owned_input_file(&state, input_image_id, user_id).await?;
        let bytes = read_storage(
            state.storage.as_ref().expect("checked"),
            &input.storage_path,
        )
        .await?;
        let bucket = client.create_bucket(true).await?;
        let upload = client
            .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &input.content_type)
            .await?;
        input_bucket_uid = Some(bucket.bucket_uid.clone());
        record_event(
            &state,
            job_id,
            "offload.input.upload",
            "ok",
            Some(&format!(
                "bucket={} file_uid={}",
                bucket.bucket_uid, upload.file_uid
            )),
        )
        .await?;
    }

    let mut payload = serde_json::json!({
        "workflow": workflow,
        "prompt": req.prompt.trim(),
        "resolution": {
            "width": req.width,
            "height": req.height,
        }
    });
    if let Some(neg) = req.negative_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["secondary_prompts"] = serde_json::json!({ "negative": neg });
    }
    if let Some(seed) = req.seed {
        payload["seed"] = serde_json::json!(seed);
    }
    if let Some(input_id) = req.input_image_id.as_deref() {
        let input = get_owned_input_file(
            &state,
            input_id
                .parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid input_image_id".into()))?,
            user_id,
        )
        .await?;
        payload["input_image"] = serde_json::json!(input.filename);
    }

    let (task_id, submit_payload) = client
        .submit_img_task(
            &req.capability,
            payload,
            input_bucket_uid.as_deref(),
            &output_bucket.bucket_uid,
        )
        .await?;
    let offload_row_id = state.next_id();
    image_generation::create_offload_task(
        &state.db,
        offload_row_id,
        job_id,
        &task_id.cap,
        &task_id.id,
        &submit_payload.to_string(),
    )
    .await?;
    image_generation::update_job_status(&state.db, job_id, "submitted", None).await?;
    record_event(
        &state,
        job_id,
        "offload.submit",
        "ok",
        Some(&format!("cap={} id={}", task_id.cap, task_id.id)),
    )
    .await?;

    if let Some(input_id) = req.input_image_id {
        if let Ok(input_image_id) = input_id.parse::<i64>() {
            attach_input_file_to_job(&state, input_image_id, user_id, job_id).await?;
        }
    }

    Ok((StatusCode::CREATED, Json(StartJobResponse { job_id: job_id.to_string(), status: "submitted".into() })))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<PollResponse>, AppError> {
    ensure_storage_enabled(&state)?;
    let job_id = job_id_str
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid job_id".into()))?;
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;

    if matches!(job.status.as_str(), "completed" | "failed" | "canceled") {
        if job.status == "completed" {
            reconcile_job_outputs_if_missing(&state, &job, user_id).await?;
        }
        let files = image_generation::list_job_files(&state.db, job.id).await?;
        let output_images = files
            .into_iter()
            .filter(|f| f.direction == "output")
            .map(map_image_ref)
            .collect();
        return Ok(Json(PollResponse {
            job_id: job.id.to_string(),
            status: job.status,
            stage: None,
            error: job.error,
            output_images,
        }));
    }

    let client = offload_client(&state).await?;
    let poll = client
        .poll_task(&OffloadTaskId {
            cap: task.offload_cap.clone(),
            id: task.offload_task_id.clone(),
        })
        .await?;

    image_generation::update_offload_task_poll(
        &state.db,
        task.id,
        Some(&poll.status),
        poll.stage.as_deref(),
        poll.log.as_deref(),
        poll.output.as_ref().map(|v| v.to_string()).as_deref(),
    )
    .await?;
    record_event(
        &state,
        job.id,
        "offload.poll",
        "ok",
        Some(&format!(
            "status={} stage={}",
            poll.status,
            poll.stage.clone().unwrap_or_default()
        )),
    )
    .await?;

    match poll.status.as_str() {
        "completed" => {
            fetch_and_store_outputs(&state, user_id, &job, poll.output).await?;
        }
        "failed" | "canceled" => {
            let err = poll
                .output
                .as_ref()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()))
                .unwrap_or("offload task failed");
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), Some(err)).await?;
            record_event(&state, job.id, "job.finalize", "error", Some(err)).await?;
        }
        _ => {}
    }

    let job = image_generation::get_job(&state.db, job.id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    let output_images = files
        .into_iter()
        .filter(|f| f.direction == "output")
        .map(map_image_ref)
        .collect();
    Ok(Json(PollResponse {
        job_id: job.id.to_string(),
        status: job.status,
        stage: poll.stage,
        error: job.error,
        output_images,
    }))
}

pub async fn run_background_reconcile_pass(state: &AppState, batch_size: u64) -> Result<(), AppError> {
    let jobs = image_generation::list_jobs_for_background_worker(&state.db, batch_size).await?;
    for job in jobs {
        let user_id = job.user_id;
        match job.status.as_str() {
            "created" | "submitted" | "pending" | "running" => {
                if let Err(e) = background_poll_once(state, &job).await {
                    let _ = record_event(
                        state,
                        job.id,
                        "worker.poll",
                        "error",
                        Some(&format!("{e}")),
                    )
                    .await;
                }
            }
            "completed" => {
                if let Err(e) = reconcile_job_outputs_if_missing(state, &job, user_id).await {
                    let _ = record_event(
                        state,
                        job.id,
                        "worker.reconcile",
                        "error",
                        Some(&format!("{e}")),
                    )
                    .await;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = job_id_str
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid job_id".into()))?;
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let files = image_generation::list_job_files(&state.db, job_id).await?;
    let events = image_generation::list_pipeline_events(&state.db, job_id).await?;
    Ok(Json(JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        prompt: job.prompt,
        negative_prompt: job.negative_prompt,
        capability: job.capability,
        workflow: job.workflow,
        width: job.width,
        height: job.height,
        seed: job.seed,
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        error: job.error,
        files: files
            .into_iter()
            .map(|f| JobFile {
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
            })
            .collect(),
        events: events
            .into_iter()
            .map(|e| JobEvent {
                step: e.step,
                state: e.state,
                details: e.details,
                created_at: e.created_at.to_rfc3339(),
            })
            .collect(),
    }))
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = image_generation::list_jobs(&state.db, user_id, 50).await?;
    let mut out = Vec::with_capacity(jobs.len());
    for job in jobs {
        let files = image_generation::list_job_files(&state.db, job.id).await?;
        let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
        out.push(JobDetailsResponse {
            job_id: job.id.to_string(),
            status: job.status,
            prompt: job.prompt,
            negative_prompt: job.negative_prompt,
            capability: job.capability,
            workflow: job.workflow,
            width: job.width,
            height: job.height,
            seed: job.seed,
            input_image_id: job.input_image_id.map(|id| id.to_string()),
            error: job.error,
            files: files
                .into_iter()
                .map(|f| JobFile {
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
                })
                .collect(),
            events: events
                .into_iter()
                .map(|e| JobEvent {
                    step: e.step,
                    state: e.state,
                    details: e.details,
                    created_at: e.created_at.to_rfc3339(),
                })
                .collect(),
        });
    }
    Ok(Json(out))
}

pub async fn list_imggen_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_user_id): AuthenticatedUser,
) -> Result<Json<Vec<ImgGenCapability>>, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let api_key = settings.client_api_token.unwrap_or_default();
    if api_key.is_empty() {
        return Ok(Json(vec![]));
    }
    let client = OffloadClient::new(state.http.clone(), settings.offloadmq_url, api_key);
    let caps = client.list_capabilities_with_prefix("imggen.").await?;
    Ok(Json(
        caps.into_iter()
            .map(|c| ImgGenCapability { base: c.base, tags: c.tags, raw: c.raw })
            .collect(),
    ))
}

pub async fn get_image(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(image_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    ensure_storage_enabled(&state)?;
    let image_id = image_id_str
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid image_id".into()))?;
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let bytes = read_storage(state.storage.as_ref().expect("checked"), &file.storage_path).await?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&file.content_type).unwrap_or(HeaderValue::from_static("image/jpeg")),
    );
    Ok((StatusCode::OK, headers, bytes))
}

async fn fetch_and_store_outputs(
    state: &AppState,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output: Option<serde_json::Value>,
) -> Result<(), AppError> {
    let offload = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("missing offload row".into()))?;
    let submit_payload: serde_json::Value = serde_json::from_str(&offload.submit_payload)
        .map_err(|e| AppError::Internal(format!("invalid submit payload in db: {e}")))?;
    let output_bucket = submit_payload["output_bucket"]
        .as_str()
        .ok_or_else(|| AppError::Internal("missing output_bucket".into()))?
        .to_string();
    let mut images = output
        .as_ref()
        .and_then(|o| o.get("images"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if images.is_empty() {
        if let Some(cached) = offload.last_poll_output.as_deref() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(cached) {
                images = value
                    .get("images")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
            }
        }
    }
    if images.is_empty() {
        record_event(
            state,
            job.id,
            "download.outputs",
            "pending",
            Some("no output images in poll payload; keep job submitted for retry"),
        )
        .await?;
        return Ok(());
    }
    let client = offload_client_from_settings(state, app_settings::get(&state.db).await?).await?;
    for (idx, image) in images.into_iter().enumerate() {
        let file_uid = image["file_uid"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("output image missing file_uid".into()))?;
        let filename = image["filename"]
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("output_{}.jpg", idx + 1));

        let processed = if let Some(data_base64) = image["data_base64"].as_str() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64)
                .map_err(|e| AppError::ExternalService(format!("bad base64 image: {e}")))?;
            process_image(bytes, image["content_type"].as_str().map(ToOwned::to_owned))?
        } else {
            let (bytes, content_type) =
                download_with_retries(&client, &output_bucket, file_uid, 3).await?;
            process_image(bytes, Some(content_type))?
        };

        let image_id = state.next_id();
        let storage_path = format!("users/{user_id}/images/output/{}/{}.jpg", job.id, image_id);
        write_storage(
            state.storage.as_ref().expect("checked"),
            &storage_path,
            processed.bytes.clone(),
        )
        .await?;
        image_generation::create_image_file(
            &state.db,
            image_generation::NewImageFileInput {
                id: image_id,
                user_id,
                job_id: Some(job.id),
                direction: "output",
                source: "offload_download",
                storage_path: &storage_path,
                filename: &filename,
                content_type: &processed.content_type,
                original_bytes: processed.original_bytes,
                stored_bytes: processed.bytes.len() as i64,
                original_width: processed.original_width,
                original_height: processed.original_height,
                stored_width: processed.width,
                stored_height: processed.height,
                exif_orientation: processed.exif_orientation,
                rescaled: processed.rescaled,
                reencoded: processed.reencoded,
                sha256: &processed.sha256,
                offload_bucket_uid: Some(&output_bucket),
                offload_file_uid: Some(file_uid),
            },
        )
        .await?;
        record_event(
            state,
            job.id,
            "download.image.store",
            "ok",
            Some(&format!("image_id={} file_uid={}", image_id, file_uid)),
        )
        .await?;
    }
    image_generation::update_job_status(&state.db, job.id, "completed", None).await?;
    record_event(state, job.id, "job.finalize", "ok", Some("completed")).await?;
    Ok(())
}

async fn background_poll_once(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
) -> Result<(), AppError> {
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;
    let client = offload_client(state).await?;
    let poll = client
        .poll_task(&OffloadTaskId {
            cap: task.offload_cap.clone(),
            id: task.offload_task_id.clone(),
        })
        .await?;
    image_generation::update_offload_task_poll(
        &state.db,
        task.id,
        Some(&poll.status),
        poll.stage.as_deref(),
        poll.log.as_deref(),
        poll.output.as_ref().map(|v| v.to_string()).as_deref(),
    )
    .await?;
    let _ = record_event(
        state,
        job.id,
        "worker.offload.poll",
        "ok",
        Some(&format!(
            "status={} stage={}",
            poll.status,
            poll.stage.clone().unwrap_or_default()
        )),
    )
    .await;
    match poll.status.as_str() {
        "completed" => {
            fetch_and_store_outputs(state, job.user_id, job, poll.output).await?;
        }
        "failed" | "canceled" => {
            let err = poll
                .output
                .as_ref()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()))
                .unwrap_or("offload task failed");
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), Some(err)).await?;
            let _ = record_event(state, job.id, "job.finalize", "error", Some(err)).await;
        }
        _ => {
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), None).await?;
        }
    }
    Ok(())
}

pub(crate) async fn reconcile_job_outputs_if_missing(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
    user_id: i64,
) -> Result<(), AppError> {
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    if files.iter().any(|f| f.direction == "output") {
        return Ok(());
    }
    if let Err(e) = fetch_and_store_outputs(state, user_id, job, None).await {
        record_event(
            state,
            job.id,
            "download.reconcile",
            "error",
            Some(&format!("reconcile failed: {e}")),
        )
        .await?;
    } else {
        record_event(state, job.id, "download.reconcile", "ok", Some("reconcile success")).await?;
    }
    Ok(())
}

fn process_image(bytes: Vec<u8>, content_type_hint: Option<String>) -> Result<ProcessedImage, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty image".into()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::BadRequest("image exceeds 32MB limit".into()));
    }

    let orientation = orientation_from_exif(&bytes);
    let mut img = decode_with_hint(&bytes, content_type_hint.as_deref())?;
    img.apply_orientation(orientation.unwrap_or(Orientation::NoTransforms));
    let (ow, oh) = img.dimensions();
    let mut rescaled = false;
    if ow.max(oh) > MAX_IMAGE_EDGE {
        let scale = MAX_IMAGE_EDGE as f64 / (ow.max(oh) as f64);
        let nw = ((ow as f64) * scale).round().max(1.0) as u32;
        let nh = ((oh as f64) * scale).round().max(1.0) as u32;
        img = DynamicImage::from(image::imageops::resize(&img, nw, nh, FilterType::Triangle));
        rescaled = true;
    }
    let (sw, sh) = img.dimensions();
    let encoded = encode_jpeg(&img)?;
    let sha256 = sha256_hex(&encoded);

    Ok(ProcessedImage {
        bytes: encoded,
        content_type: "image/jpeg".to_string(),
        width: sw as i32,
        height: sh as i32,
        original_width: Some(ow as i32),
        original_height: Some(oh as i32),
        original_bytes: Some(bytes.len() as i64),
        rescaled,
        reencoded: true,
        exif_orientation: orientation_to_exif_int(orientation),
        sha256,
    })
}

async fn record_event(
    state: &AppState,
    job_id: i64,
    step: &str,
    event_state: &str,
    details: Option<&str>,
) -> Result<(), AppError> {
    image_generation::create_pipeline_event(
        &state.db,
        state.next_id(),
        job_id,
        step,
        event_state,
        details,
    )
    .await?;
    Ok(())
}

async fn offload_client(state: &AppState) -> Result<OffloadImageClient, AppError> {
    let settings = app_settings::get(&state.db).await?;
    offload_client_from_settings(state, settings).await
}

async fn download_with_retries(
    client: &OffloadImageClient,
    output_bucket: &str,
    file_uid: &str,
    attempts: usize,
) -> Result<(Vec<u8>, String), AppError> {
    let mut last_err: Option<AppError> = None;
    for attempt in 0..attempts {
        match client.download_bucket_file(output_bucket, file_uid).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < attempts {
                    let backoff_ms = 250 * (attempt as u64 + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::ExternalService("download failed".into())))
}

async fn offload_client_from_settings(
    state: &AppState,
    settings: crate::db::app_settings::AppSettings,
) -> Result<OffloadImageClient, AppError> {
    let api_key = settings.client_api_token.unwrap_or_default();
    if api_key.is_empty() {
        return Err(AppError::BadRequest(
            "missing OffloadMQ client API token in admin settings".into(),
        ));
    }
    Ok(OffloadImageClient::new(
        state.http.clone(),
        settings.offloadmq_url,
        api_key,
    ))
}

fn ensure_storage_enabled(state: &AppState) -> Result<(), AppError> {
    if state.storage.is_none() {
        return Err(AppError::BadRequest(
            "storage backend is disabled; set STORAGE_BACKEND".into(),
        ));
    }
    Ok(())
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

fn decode_with_hint(bytes: &[u8], content_type_hint: Option<&str>) -> Result<DynamicImage, AppError> {
    let format = match content_type_hint.unwrap_or_default() {
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/png" => Some(ImageFormat::Png),
        "image/webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    let mut reader = if let Some(fmt) = format {
        ImageReader::with_format(Cursor::new(bytes), fmt)
    } else {
        ImageReader::new(Cursor::new(bytes))
    };
    reader = reader
        .with_guessed_format()
        .map_err(|e| AppError::BadRequest(format!("unsupported image: {e}")))?;
    reader
        .decode()
        .map_err(|e| AppError::BadRequest(format!("decode image failed: {e}")))
}

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>, AppError> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| AppError::Internal(format!("jpeg encode failed: {e}")))?;
    Ok(out)
}

fn orientation_from_exif(bytes: &[u8]) -> Option<Orientation> {
    let mut cursor = Cursor::new(bytes);
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut cursor)
        .ok()?;
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .and_then(|v| u8::try_from(v).ok())
        .and_then(Orientation::from_exif)
}

fn orientation_to_exif_int(orientation: Option<Orientation>) -> Option<i32> {
    orientation
        .and_then(|o| match o {
            Orientation::NoTransforms => Some(1),
            Orientation::Rotate90 => Some(6),
            Orientation::Rotate180 => Some(3),
            Orientation::Rotate270 => Some(8),
            Orientation::FlipHorizontal => Some(2),
            Orientation::FlipVertical => Some(4),
            Orientation::Rotate90FlipH => Some(5),
            Orientation::Rotate270FlipH => Some(7),
        })
        .map(i32::from)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

async fn write_storage(
    op: &opendal::Operator,
    path: &str,
    bytes: Vec<u8>,
) -> Result<(), AppError> {
    op.write(path, bytes)
        .await
        .map(|_| ())
        .map_err(|e| AppError::Internal(format!("storage write failed: {e}")))
}

async fn read_storage(op: &opendal::Operator, path: &str) -> Result<Vec<u8>, AppError> {
    op.read(path)
        .await
        .map(|b| b.to_vec())
        .map_err(|e| AppError::Internal(format!("storage read failed: {e}")))
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

async fn get_owned_input_file(
    state: &AppState,
    image_id: i64,
    user_id: i64,
) -> Result<image_generation::ImageFile, AppError> {
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if file.direction != "input" {
        return Err(AppError::BadRequest("input_image_id must reference an input image".into()));
    }
    Ok(file)
}

async fn attach_input_file_to_job(
    state: &AppState,
    input_image_id: i64,
    user_id: i64,
    job_id: i64,
) -> Result<(), AppError> {
    image_generation::set_image_file_job(&state.db, input_image_id, user_id, job_id).await
}
