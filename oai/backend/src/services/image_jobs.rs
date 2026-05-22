//! Image-generation job orchestration: create/submit jobs, poll the offload
//! task, download + persist outputs, and reconcile missing results. All the
//! multi-step logic that used to live inside the image route handlers lives
//! here so the handlers stay thin (parse request → call service → map DTO).

use base64::Engine;
use serde::Deserialize;

use crate::{
    db::{app_settings, image_generation},
    error::AppError,
    offload::{
        image_tasks::{OffloadImageClient, OffloadTaskId},
        CapabilityInfo, OffloadClient,
    },
    services::{image_processing, offload_factory, storage},
    state::AppState,
};

/// Input contract for starting a generation job (the service's command type).
#[derive(Deserialize)]
pub struct StartJobParams {
    pub capability: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub workflow: Option<String>,
    pub input_image_id: Option<String>,
}

/// Result of polling a job — domain data the route maps to its response DTO.
pub struct PolledJob {
    pub status: String,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub output_files: Vec<image_generation::ImageFile>,
}

/// A job plus its files and pipeline events, used to build detail responses.
pub struct JobDetail {
    pub job: image_generation::ImageGenerationJob,
    pub files: Vec<image_generation::ImageFile>,
    pub events: Vec<image_generation::ImagePipelineEvent>,
}

pub async fn upload_input_image(
    state: &AppState,
    user_id: i64,
    filename: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<image_generation::ImageFile, AppError> {
    let op = storage::operator(state)?;
    let processed = image_processing::process_image(bytes, Some(content_type))?;

    let image_id = state.next_id();
    let storage_path = format!("users/{user_id}/images/input/{image_id}.jpg");
    storage::write(op, &storage_path, processed.bytes.clone()).await?;

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
    .await
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;
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
    record_event(state, job_id, "job.created", "ok", None).await?;

    let client = offload_factory::image_client(state).await?;
    let output_bucket = client.create_bucket(false).await?;
    record_event(
        state,
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
        let input = get_owned_input_file(state, input_image_id, user_id).await?;
        let bytes = storage::read(storage::operator(state)?, &input.storage_path).await?;
        let bucket = client.create_bucket(true).await?;
        let upload = client
            .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &input.content_type)
            .await?;
        input_bucket_uid = Some(bucket.bucket_uid.clone());
        record_event(
            state,
            job_id,
            "offload.input.upload",
            "ok",
            Some(&format!("bucket={} file_uid={}", bucket.bucket_uid, upload.file_uid)),
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
            state,
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
        state,
        job_id,
        "offload.submit",
        "ok",
        Some(&format!("cap={} id={}", task_id.cap, task_id.id)),
    )
    .await?;

    if let Some(input_id) = req.input_image_id
        && let Ok(input_image_id) = input_id.parse::<i64>()
    {
        image_generation::set_image_file_job(&state.db, input_image_id, user_id, job_id).await?;
    }

    Ok(job_id)
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<PolledJob, AppError> {
    storage::operator(state)?;
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;

    if matches!(job.status.as_str(), "completed" | "failed" | "canceled") {
        if job.status == "completed" {
            reconcile_job_outputs_if_missing(state, &job, user_id).await?;
        }
        return Ok(PolledJob {
            output_files: output_files(state, job.id).await?,
            status: job.status,
            stage: None,
            error: job.error,
        });
    }

    let client = offload_factory::image_client(state).await?;
    let poll = client
        .poll_task(&OffloadTaskId { cap: task.offload_cap.clone(), id: task.offload_task_id.clone() })
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
        state,
        job.id,
        "offload.poll",
        "ok",
        Some(&format!("status={} stage={}", poll.status, poll.stage.clone().unwrap_or_default())),
    )
    .await?;

    match poll.status.as_str() {
        "completed" => {
            fetch_and_store_outputs(state, user_id, &job, poll.output).await?;
        }
        "failed" | "canceled" => {
            let err = poll
                .output
                .as_ref()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()))
                .unwrap_or("offload task failed");
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), Some(err))
                .await?;
            record_event(state, job.id, "job.finalize", "error", Some(err)).await?;
        }
        _ => {}
    }

    let job = image_generation::get_job(&state.db, job.id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(PolledJob {
        output_files: output_files(state, job.id).await?,
        status: job.status,
        stage: poll.stage,
        error: job.error,
    })
}

pub async fn image_bytes(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<(Vec<u8>, String), AppError> {
    let op = storage::operator(state)?;
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let bytes = storage::read(op, &file.storage_path).await?;
    Ok((bytes, file.content_type))
}

pub async fn list_imggen_capabilities(state: &AppState) -> Result<Vec<CapabilityInfo>, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let api_key = settings.client_api_token.clone().unwrap_or_default();
    if api_key.is_empty() {
        return Ok(vec![]);
    }
    let client = OffloadClient::new(state.http.clone(), settings.offloadmq_url, api_key);
    client.list_capabilities_with_prefix("imggen.").await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<JobDetail, AppError> {
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    job_detail(state, job).await
}

pub async fn list_user_job_details(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<JobDetail>, AppError> {
    let jobs = image_generation::list_jobs(&state.db, user_id, limit).await?;
    collect_details(state, jobs).await
}

pub async fn any_job_detail(state: &AppState, job_id: i64) -> Result<JobDetail, AppError> {
    let job = image_generation::get_job_global(&state.db, job_id)
        .await?
        .ok_or(AppError::NotFound)?;
    job_detail(state, job).await
}

pub async fn list_all_job_details(
    state: &AppState,
    limit: u64,
) -> Result<Vec<JobDetail>, AppError> {
    let jobs = image_generation::list_jobs_global(&state.db, limit).await?;
    collect_details(state, jobs).await
}

/// Admin-triggered reconcile of a single job by id (any owner).
pub async fn reconcile_job(state: &AppState, job_id: i64) -> Result<(), AppError> {
    let job = image_generation::get_job_global(&state.db, job_id)
        .await?
        .ok_or(AppError::NotFound)?;
    reconcile_job_outputs_if_missing(state, &job, job.user_id).await
}

/// Background worker pass: advances pending jobs and reconciles completed ones
/// that are missing their output files.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    let jobs = image_generation::list_jobs_for_background_worker(&state.db, batch_size).await?;
    for job in jobs {
        let user_id = job.user_id;
        match job.status.as_str() {
            "created" | "submitted" | "pending" | "running" => {
                if let Err(e) = background_poll_once(state, &job).await {
                    let _ = record_event(state, job.id, "worker.poll", "error", Some(&format!("{e}")))
                        .await;
                }
            }
            "completed" => {
                if let Err(e) = reconcile_job_outputs_if_missing(state, &job, user_id).await {
                    let _ =
                        record_event(state, job.id, "worker.reconcile", "error", Some(&format!("{e}")))
                            .await;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ── Internal orchestration helpers ──────────────────────────────────────────

async fn job_detail(
    state: &AppState,
    job: image_generation::ImageGenerationJob,
) -> Result<JobDetail, AppError> {
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
    Ok(JobDetail { job, files, events })
}

async fn collect_details(
    state: &AppState,
    jobs: Vec<image_generation::ImageGenerationJob>,
) -> Result<Vec<JobDetail>, AppError> {
    let mut out = Vec::with_capacity(jobs.len());
    for job in jobs {
        out.push(job_detail(state, job).await?);
    }
    Ok(out)
}

async fn output_files(
    state: &AppState,
    job_id: i64,
) -> Result<Vec<image_generation::ImageFile>, AppError> {
    let files = image_generation::list_job_files(&state.db, job_id).await?;
    Ok(files.into_iter().filter(|f| f.direction == "output").collect())
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
    if images.is_empty()
        && let Some(cached) = offload.last_poll_output.as_deref()
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(cached)
    {
        images = value
            .get("images")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
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
    let client =
        offload_factory::image_client_from_settings(state, app_settings::get(&state.db).await?)?;
    let op = storage::operator(state)?;
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
            image_processing::process_image(bytes, image["content_type"].as_str().map(ToOwned::to_owned))?
        } else {
            let (bytes, content_type) =
                download_with_retries(&client, &output_bucket, file_uid, 3).await?;
            image_processing::process_image(bytes, Some(content_type))?
        };

        let image_id = state.next_id();
        let storage_path = format!("users/{user_id}/images/output/{}/{}.jpg", job.id, image_id);
        storage::write(op, &storage_path, processed.bytes.clone()).await?;
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
    let client = offload_factory::image_client(state).await?;
    let poll = client
        .poll_task(&OffloadTaskId { cap: task.offload_cap.clone(), id: task.offload_task_id.clone() })
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
        Some(&format!("status={} stage={}", poll.status, poll.stage.clone().unwrap_or_default())),
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
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), Some(err))
                .await?;
            let _ = record_event(state, job.id, "job.finalize", "error", Some(err)).await;
        }
        _ => {
            image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), None).await?;
        }
    }
    Ok(())
}

async fn reconcile_job_outputs_if_missing(
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

async fn get_owned_input_file(
    state: &AppState,
    image_id: i64,
    user_id: i64,
) -> Result<image_generation::ImageFile, AppError> {
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if file.direction != "input" {
        return Err(AppError::BadRequest(
            "input_image_id must reference an input image".into(),
        ));
    }
    Ok(file)
}
