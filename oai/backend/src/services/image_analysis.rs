//! Image-analysis job orchestration: persist describe jobs, submit to OffloadMQ
//! vision tasks, poll for results and reconcile in-flight jobs in the
//! background. Mirrors the image-generation service but produces a single text
//! result instead of output image files.

use std::collections::{HashMap, HashSet};

use crate::{
    db::{image_analysis, image_generation, llm_capabilities},
    error::AppError,
    offload::{LlmCapabilityInfo, PollResponse, TaskId},
    services::{image_processing, offload_factory, storage},
    state::AppState,
};

pub struct StartJobParams {
    pub capability: String,
    pub prompt: String,
    pub image_id: i64,
    /// OffloadMQ `dataPreparation` map (glob → action) applied to the input image
    /// before the vision task runs. Empty / `None` = send the image as-is.
    pub data_preparation: Option<HashMap<String, String>>,
}

pub struct JobDetail {
    pub job: image_analysis::ImageAnalysisJob,
}

pub struct CancelJobOutcome {
    pub job_id: i64,
    pub status: String,
    pub message: String,
}

pub async fn list_vision_capabilities(
    state: &AppState,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    let all = llm_capabilities::list_for_display(&state.db, &online_bases).await?;
    Ok(all
        .into_iter()
        .filter(|c| c.tags.iter().any(|t| t.eq_ignore_ascii_case("vision")))
        .collect())
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    if req.capability.is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }

    let input = image_generation::get_image_file(&state.db, req.image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    // Stored uploads are already normalized and capped to MAX_IMAGE_EDGE.
    // Optional dataPreparation can still ask the agent to shrink further for
    // model-specific context limits.
    let data_prep = data_preparation_map(&req.data_preparation);
    let data_prep_json = data_prep
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| AppError::Internal(format!("serialize dataPreparation: {e}")))?;

    let job_id = state.next_id();
    image_analysis::create_job(
        &state.db,
        image_analysis::NewJobInput {
            id: job_id,
            user_id,
            prompt,
            capability: &req.capability,
            input_image_id: Some(input.id),
            data_preparation: data_prep_json.as_deref(),
        },
    )
    .await?;

    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    let (bytes, content_type) = if data_prep.is_some() {
        (bytes, input.content_type.clone())
    } else {
        let processed = image_processing::process_image(bytes, Some(input.content_type.clone()))?;
        (processed.bytes, processed.content_type)
    };
    img_client
        .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &content_type)
        .await?;

    let chat_client = offload_factory::chat_client(state).await?;
    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    let task_id = chat_client
        .submit_vision_task(&req.capability, messages, &bucket.bucket_uid, data_prep.as_ref())
        .await?;

    image_analysis::set_offload_task(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        &bucket.bucket_uid,
    )
    .await?;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    let image_id = job
        .input_image_id
        .ok_or_else(|| AppError::BadRequest("retry requires the original input image".into()))?;
    let data_preparation = job
        .data_preparation
        .as_deref()
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok());
    start_job(
        state,
        user_id,
        StartJobParams {
            capability: job.capability.clone(),
            prompt: job.prompt.clone(),
            image_id,
            data_preparation,
        },
    )
    .await
}

/// Convert a non-empty rescale map into a JSON object for the OffloadMQ
/// `dataPreparation` field. Empty / `None` yields `None` (no explicit rescale).
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

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelJobOutcome, AppError> {
    let job = image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }

    let (Some(cap), Some(task_id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) else {
        let message = "Canceled before OffloadMQ task was created";
        image_analysis::update_status(&state.db, job.id, "canceled", None, Some(message)).await?;
        return Ok(CancelJobOutcome {
            job_id: job.id,
            status: "canceled".into(),
            message: message.into(),
        });
    };

    let client = offload_factory::chat_client(state).await?;
    match client.cancel_task(&TaskId { cap, id: task_id }).await {
        Ok(resp) => {
            image_analysis::update_status(&state.db, job.id, &resp.status, None, None).await?;
            Ok(CancelJobOutcome {
                job_id: job.id,
                status: resp.status,
                message: resp.message,
            })
        }
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                image_analysis::update_status(&state.db, job.id, "failed", None, Some(&reason))
                    .await?;
                Ok(CancelJobOutcome {
                    job_id: job.id,
                    status: "failed".into(),
                    message: reason,
                })
            } else {
                Err(e)
            }
        }
    }
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    image_analysis::delete_job(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<image_analysis::ImageAnalysisJob, AppError> {
    let job = image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if is_terminal(&job.status) {
        return Ok(job);
    }
    let Some(cap) = job.offload_cap.clone() else {
        return Ok(job);
    };
    let Some(task_id) = job.offload_task_id.clone() else {
        return Ok(job);
    };
    if let Err(e) = run_poll_once(state, &job, &cap, &task_id).await {
        if let Some(reason) = offload_task_missing_message(&e) {
            image_analysis::update_status(&state.db, job.id, "failed", None, Some(&reason)).await?;
        } else {
            return Err(e);
        }
    }
    image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<JobDetail, AppError> {
    let job = image_analysis::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(JobDetail { job })
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<image_analysis::ImageAnalysisJob>, AppError> {
    image_analysis::list_jobs(&state.db, user_id, limit).await
}

/// Background worker pass: advances in-flight analysis jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    let jobs = image_analysis::list_jobs_for_background_worker(&state.db, batch_size).await?;
    for job in jobs {
        let (Some(cap), Some(task_id)) = (job.offload_cap.clone(), job.offload_task_id.clone())
        else {
            continue;
        };
        match run_poll_once(state, &job, &cap, &task_id).await {
            Ok(()) => {}
            Err(e) => {
                if let Some(reason) = offload_task_missing_message(&e) {
                    let _ = image_analysis::update_status(
                        &state.db,
                        job.id,
                        "failed",
                        None,
                        Some(&reason),
                    )
                    .await;
                } else {
                    tracing::warn!("image analysis poll failed for job {}: {e}", job.id);
                }
            }
        }
    }
    Ok(())
}

async fn run_poll_once(
    state: &AppState,
    job: &image_analysis::ImageAnalysisJob,
    cap: &str,
    task_id: &str,
) -> Result<(), AppError> {
    let client = offload_factory::chat_client(state).await?;
    let poll = client
        .poll_task(&TaskId { cap: cap.to_string(), id: task_id.to_string() })
        .await?;
    apply_poll(state, job, &poll).await
}

async fn apply_poll(
    state: &AppState,
    job: &image_analysis::ImageAnalysisJob,
    poll: &PollResponse,
) -> Result<(), AppError> {
    match poll.status.as_str() {
        "completed" => {
            let text = extract_llm_text(&poll.output);
            if text.is_empty() {
                image_analysis::update_status(
                    &state.db,
                    job.id,
                    "failed",
                    None,
                    Some("vision task returned empty result"),
                )
                .await?;
            } else {
                image_analysis::set_result(&state.db, job.id, &text).await?;
            }
        }
        "failed" => {
            let err = extract_error_text(&poll.output);
            image_analysis::update_status(&state.db, job.id, "failed", None, Some(&err)).await?;
        }
        "canceled" => {
            image_analysis::update_status(&state.db, job.id, "canceled", None, None).await?;
        }
        other => {
            image_analysis::update_status(&state.db, job.id, other, poll.stage.as_deref(), None)
                .await?;
        }
    }
    Ok(())
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

fn extract_llm_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(extract_llm_text_from_value)
        .unwrap_or_default()
        .to_string()
}

fn extract_llm_text_from_value(v: &serde_json::Value) -> Option<&str> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            v.get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c0| c0.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| v.get("response").and_then(|r| r.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| v.get("content").and_then(|c| c.as_str()).filter(|s| !s.is_empty()))
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("vision task failed")
        .to_string()
}

const OFFLOAD_TASK_MISSING: &str =
    "OffloadMQ task not found (likely deleted or archived on the server)";

fn offload_task_missing_message(err: &AppError) -> Option<String> {
    let AppError::ExternalService(msg) = err else {
        return None;
    };
    if let Some(rest) = msg.strip_prefix("POLL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    if let Some(rest) = msg.strip_prefix("CANCEL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not found") || lower.contains("not_found") {
        return Some(OFFLOAD_TASK_MISSING.to_string());
    }
    None
}

fn offload_http_is_task_missing(rest: &str) -> bool {
    matches!(
        rest.split_once(':').map(|(code, _)| code),
        Some("404") | Some("410")
    )
}
