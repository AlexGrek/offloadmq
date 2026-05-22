//! Image-generation job orchestration: create/submit jobs, poll the offload
//! task, download + persist outputs, and reconcile missing results. All the
//! multi-step logic that used to live inside the image route handlers lives
//! here so the handlers stay thin (parse request → call service → map DTO).

use std::collections::HashMap;

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    db::{app_settings, image_generation, users},
    error::AppError,
    offload::{
        image_tasks::{OffloadImageClient, OffloadPollResponse, OffloadTaskId},
        CapabilityInfo, OffloadClient,
    },
    services::{image_processing, image_processing::ProcessedImage, offload_factory, storage},
    state::AppState,
};

/// Input contract for starting a generation job (the service's command type).
#[derive(Deserialize)]
pub struct StartJobParams {
    pub capability: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    /// When true, send `secondary_prompts.negative`; when false, use the workflow default.
    #[serde(default)]
    pub override_negative: bool,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub workflow: Option<String>,
    pub input_image_id: Option<String>,
    /// OffloadMQ `dataPreparation` map (glob mask → action), applied to input bucket files.
    pub data_preparation: Option<HashMap<String, String>>,
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
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
}

/// Placement metadata for a stored image — everything `store_image` needs that
/// isn't derived from the processed pixels.
struct StoredImageSpec<'a> {
    image_id: i64,
    user_id: i64,
    job_id: Option<i64>,
    direction: &'a str,
    source: &'a str,
    storage_path: &'a str,
    filename: &'a str,
    offload_bucket_uid: Option<&'a str>,
    offload_file_uid: Option<&'a str>,
}

pub async fn upload_input_image(
    state: &AppState,
    user_id: i64,
    filename: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<image_generation::ImageFile, AppError> {
    storage::operator(state)?;
    let processed = image_processing::process_image(bytes, Some(content_type))?;

    let image_id = state.next_id();
    let storage_path = format!("users/{user_id}/images/input/{image_id}.jpg");
    store_image(
        state,
        StoredImageSpec {
            image_id,
            user_id,
            job_id: None,
            direction: "input",
            source: "upload",
            storage_path: &storage_path,
            filename: &filename,
            offload_bucket_uid: None,
            offload_file_uid: None,
        },
        &processed,
    )
    .await
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let input_image_id = parse_input_image_id(&req)?;
    let input = match input_image_id {
        Some(id) => Some(get_owned_input_file(state, id, user_id).await?),
        None => None,
    };
    let workflow = resolve_workflow(&req);
    validate_start_job(&req, &workflow)?;

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
            input_image_id,
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

    let input_bucket_uid = match &input {
        Some(input) => Some(stage_input_image(state, &client, job_id, input).await?),
        None => None,
    };

    let payload = build_submit_payload(&req, &workflow, input.as_ref());
    let data_prep = data_preparation_map(&req.data_preparation);
    let (task_id, submit_payload) = client
        .submit_img_task(
            &req.capability,
            payload,
            input_bucket_uid.as_deref(),
            &output_bucket.bucket_uid,
            data_prep.as_ref(),
        )
        .await?;

    image_generation::create_offload_task(
        &state.db,
        state.next_id(),
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

    if let Some(id) = input_image_id {
        image_generation::set_image_file_job(&state.db, id, user_id, job_id).await?;
    }

    Ok(job_id)
}

pub async fn cancel_job(state: &AppState, user_id: i64, job_id: i64) -> Result<CancelJobOutcome, AppError> {
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task yet".into()))?;
    let client = offload_factory::image_client(state).await?;
    let resp = client
        .cancel_task(&OffloadTaskId {
            cap: task.offload_cap.clone(),
            id: task.offload_task_id.clone(),
        })
        .await?;
    image_generation::update_job_status(&state.db, job.id, &resp.status, None).await?;
    record_event(
        state,
        job.id,
        "offload.cancel",
        "ok",
        Some(&format!("status={} {}", resp.status, resp.message)),
    )
    .await?;
    Ok(CancelJobOutcome {
        job_id: job.id,
        offload_cap: resp.id.cap,
        offload_task_id: resp.id.id,
        status: resp.status,
        message: resp.message,
    })
}

#[derive(Debug)]
pub struct CancelJobOutcome {
    pub job_id: i64,
    pub offload_cap: String,
    pub offload_task_id: String,
    pub status: String,
    pub message: String,
}

pub async fn poll_job(state: &AppState, user_id: i64, job_id: i64) -> Result<PolledJob, AppError> {
    storage::operator(state)?;
    let job = image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;

    if is_terminal(&job.status) {
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

    let poll = poll_and_persist(state, &task).await?;
    record_event(state, job.id, "offload.poll", "ok", Some(&poll_summary(&poll))).await?;
    match poll.status.as_str() {
        "completed" => fetch_and_store_outputs(state, user_id, &job, poll.output).await?,
        "failed" | "canceled" => mark_failed(state, job.id, &poll).await?,
        "cancelRequested" => {
            image_generation::update_job_status(&state.db, job.id, "cancelRequested", None).await?;
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

/// A user's files plus the cached total used bytes from the users table —
/// backs the read-only file browser.
pub struct UserFileListing {
    pub files: Vec<image_generation::ImageFile>,
    pub used_bytes: i64,
}

pub async fn list_user_files(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<UserFileListing, AppError> {
    let files = image_generation::list_user_image_files(&state.db, user_id, limit).await?;
    let user = users::find_by_id(&state.db, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(UserFileListing { files, used_bytes: user.used_storage_bytes })
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
        let outcome = match job.status.as_str() {
            "created" | "submitted" | "pending" | "running" => {
                ("worker.poll", background_poll_once(state, &job).await)
            }
            "completed" => (
                "worker.reconcile",
                reconcile_job_outputs_if_missing(state, &job, job.user_id).await,
            ),
            _ => continue,
        };
        if let (step, Err(e)) = outcome {
            let _ = record_event(state, job.id, step, "error", Some(&format!("{e}"))).await;
        }
    }
    Ok(())
}

// ── Job-detail readers ──────────────────────────────────────────────────────

async fn job_detail(
    state: &AppState,
    job: image_generation::ImageGenerationJob,
) -> Result<JobDetail, AppError> {
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
    let offload = image_generation::get_offload_task_by_job(&state.db, job.id).await?;
    Ok(JobDetail {
        job,
        files,
        events,
        offload_cap: offload.as_ref().map(|t| t.offload_cap.clone()),
        offload_task_id: offload.map(|t| t.offload_task_id),
    })
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

// ── start_job helpers ───────────────────────────────────────────────────────

fn validate_start_job(req: &StartJobParams, workflow: &str) -> Result<(), AppError> {
    if req.prompt.trim().is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    if !req.capability.starts_with("imggen.") {
        return Err(AppError::BadRequest("capability must start with imggen.".into()));
    }
    if workflow == "img2img" && req.input_image_id.is_none() {
        return Err(AppError::BadRequest("img2img requires input_image_id".into()));
    }
    Ok(())
}

fn parse_input_image_id(req: &StartJobParams) -> Result<Option<i64>, AppError> {
    req.input_image_id
        .as_deref()
        .map(|s| s.parse::<i64>().map_err(|_| AppError::BadRequest("invalid input_image_id".into())))
        .transpose()
}

fn resolve_workflow(req: &StartJobParams) -> String {
    req.workflow.clone().unwrap_or_else(|| {
        if req.input_image_id.is_some() { "img2img".into() } else { "txt2img".into() }
    })
}

/// Uploads an owned input image into a fresh offload bucket; returns its uid.
async fn stage_input_image(
    state: &AppState,
    client: &OffloadImageClient,
    job_id: i64,
    input: &image_generation::ImageFile,
) -> Result<String, AppError> {
    let bytes = storage::read(storage::operator(state)?, &input.storage_path).await?;
    let bucket = client.create_bucket(true).await?;
    let upload = client
        .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &input.content_type)
        .await?;
    record_event(
        state,
        job_id,
        "offload.input.upload",
        "ok",
        Some(&format!("bucket={} file_uid={}", bucket.bucket_uid, upload.file_uid)),
    )
    .await?;
    Ok(bucket.bucket_uid)
}

fn data_preparation_map(
    prep: &Option<HashMap<String, String>>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let map = prep.as_ref().filter(|m| !m.is_empty())?;
    Some(
        map.iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect(),
    )
}

fn build_submit_payload(
    req: &StartJobParams,
    workflow: &str,
    input: Option<&image_generation::ImageFile>,
) -> Value {
    let mut payload = serde_json::json!({
        "workflow": workflow,
        "prompt": req.prompt.trim(),
        "resolution": { "width": req.width, "height": req.height },
    });
    if req.override_negative {
        if let Some(neg) = req.negative_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
            payload["secondary_prompts"] = serde_json::json!({ "negative": neg });
        }
    }
    if let Some(seed) = req.seed {
        payload["seed"] = serde_json::json!(seed);
    }
    if let Some(input) = input {
        payload["input_image"] = serde_json::json!(input.filename);
    }
    payload
}

// ── Polling helpers ─────────────────────────────────────────────────────────

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

fn poll_summary(poll: &OffloadPollResponse) -> String {
    format!("status={} stage={}", poll.status, poll.stage.clone().unwrap_or_default())
}

/// Polls the offload task and writes the latest poll snapshot to the DB.
async fn poll_and_persist(
    state: &AppState,
    task: &image_generation::ImageOffloadTask,
) -> Result<OffloadPollResponse, AppError> {
    let client = offload_factory::image_client(state).await?;
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
    Ok(poll)
}

fn extract_offload_error(poll: &OffloadPollResponse) -> &str {
    poll.output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()))
        .unwrap_or("offload task failed")
}

async fn mark_failed(
    state: &AppState,
    job_id: i64,
    poll: &OffloadPollResponse,
) -> Result<(), AppError> {
    let err = extract_offload_error(poll);
    image_generation::update_job_status(&state.db, job_id, poll.status.as_str(), Some(err)).await?;
    record_event(state, job_id, "job.finalize", "error", Some(err)).await
}

async fn background_poll_once(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
) -> Result<(), AppError> {
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;
    let poll = poll_and_persist(state, &task).await?;
    let _ = record_event(state, job.id, "worker.offload.poll", "ok", Some(&poll_summary(&poll))).await;
    match poll.status.as_str() {
        "completed" => fetch_and_store_outputs(state, job.user_id, job, poll.output).await?,
        "failed" | "canceled" => mark_failed(state, job.id, &poll).await?,
        _ => image_generation::update_job_status(&state.db, job.id, poll.status.as_str(), None).await?,
    }
    Ok(())
}

// ── Output download / persistence ───────────────────────────────────────────

async fn fetch_and_store_outputs(
    state: &AppState,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output: Option<Value>,
) -> Result<(), AppError> {
    let offload = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("missing offload row".into()))?;
    let output_bucket = output_bucket_of(&offload)?;
    let images = collect_output_images(output.as_ref(), offload.last_poll_output.as_deref());
    let Some(image) = images.last() else {
        record_event(
            state,
            job.id,
            "download.outputs",
            "pending",
            Some("no output images in poll payload; keep job submitted for retry"),
        )
        .await?;
        return Ok(());
    };

    let client =
        offload_factory::image_client_from_settings(state, app_settings::get(&state.db).await?)?;
    if images.len() > 1 {
        record_event(
            state,
            job.id,
            "download.outputs",
            "ok",
            Some(&format!(
                "offload returned {} images; storing last only",
                images.len()
            )),
        )
        .await?;
    }
    store_output_image(state, &client, user_id, job, &output_bucket, 0, image).await?;
    image_generation::update_job_status(&state.db, job.id, "completed", None).await?;
    record_event(state, job.id, "job.finalize", "ok", Some("completed")).await?;
    Ok(())
}

fn output_bucket_of(offload: &image_generation::ImageOffloadTask) -> Result<String, AppError> {
    let submit_payload: Value = serde_json::from_str(&offload.submit_payload)
        .map_err(|e| AppError::Internal(format!("invalid submit payload in db: {e}")))?;
    submit_payload["output_bucket"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::Internal("missing output_bucket".into()))
}

/// Pulls the `images` array from a poll payload, falling back to the cached
/// last-poll output when the live payload has none.
fn collect_output_images(output: Option<&Value>, cached: Option<&str>) -> Vec<Value> {
    let images = images_array(output);
    if !images.is_empty() {
        return images;
    }
    cached
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .map(|v| images_array(Some(&v)))
        .unwrap_or_default()
}

fn images_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(|o| o.get("images"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

async fn store_output_image(
    state: &AppState,
    client: &OffloadImageClient,
    user_id: i64,
    job: &image_generation::ImageGenerationJob,
    output_bucket: &str,
    idx: usize,
    image: &Value,
) -> Result<(), AppError> {
    let file_uid = image["file_uid"]
        .as_str()
        .ok_or_else(|| AppError::ExternalService("output image missing file_uid".into()))?;
    let filename = image["filename"]
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("output_{}.jpg", idx + 1));
    let processed = process_output_image(client, output_bucket, image, file_uid).await?;

    let image_id = state.next_id();
    let storage_path = format!("users/{user_id}/images/output/{}/{}.jpg", job.id, image_id);
    store_image(
        state,
        StoredImageSpec {
            image_id,
            user_id,
            job_id: Some(job.id),
            direction: "output",
            source: "offload_download",
            storage_path: &storage_path,
            filename: &filename,
            offload_bucket_uid: Some(output_bucket),
            offload_file_uid: Some(file_uid),
        },
        &processed,
    )
    .await?;
    record_event(
        state,
        job.id,
        "download.image.store",
        "ok",
        Some(&format!("image_id={} file_uid={}", image_id, file_uid)),
    )
    .await
}

/// Decodes an inline base64 image when present, otherwise downloads it from the
/// offload bucket. Either way the result is normalized via `process_image`.
async fn process_output_image(
    client: &OffloadImageClient,
    output_bucket: &str,
    image: &Value,
    file_uid: &str,
) -> Result<ProcessedImage, AppError> {
    if let Some(data_base64) = image["data_base64"].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| AppError::ExternalService(format!("bad base64 image: {e}")))?;
        image_processing::process_image(bytes, image["content_type"].as_str().map(ToOwned::to_owned))
    } else {
        let (bytes, content_type) = download_with_retries(client, output_bucket, file_uid, 3).await?;
        image_processing::process_image(bytes, Some(content_type))
    }
}

/// Writes the processed pixels to storage and records the DB row.
async fn store_image(
    state: &AppState,
    spec: StoredImageSpec<'_>,
    processed: &ProcessedImage,
) -> Result<image_generation::ImageFile, AppError> {
    let user_id = spec.user_id;
    storage::write(storage::operator(state)?, spec.storage_path, processed.bytes.clone()).await?;
    let file = image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: spec.image_id,
            user_id: spec.user_id,
            job_id: spec.job_id,
            direction: spec.direction,
            source: spec.source,
            storage_path: spec.storage_path,
            filename: spec.filename,
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
            offload_bucket_uid: spec.offload_bucket_uid,
            offload_file_uid: spec.offload_file_uid,
        },
    )
    .await?;
    // Refresh the user's cached storage usage on every upload / offload download.
    recalc_user_storage(state, user_id).await?;
    Ok(file)
}

/// Recomputes a user's total stored bytes and writes it to the cached
/// `users.used_storage_bytes` column.
async fn recalc_user_storage(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let total = image_generation::sum_user_stored_bytes(&state.db, user_id).await?;
    users::update_used_storage(&state.db, user_id, total).await
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
    match fetch_and_store_outputs(state, user_id, job, None).await {
        Ok(()) => record_event(state, job.id, "download.reconcile", "ok", Some("reconcile success")).await,
        Err(e) => {
            record_event(state, job.id, "download.reconcile", "error", Some(&format!("reconcile failed: {e}")))
                .await
        }
    }
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
    image_generation::create_pipeline_event(&state.db, state.next_id(), job_id, step, event_state, details)
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
