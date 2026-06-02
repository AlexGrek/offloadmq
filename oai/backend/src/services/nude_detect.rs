//! NudeNet (`onnx.nudenet`) job orchestration — upload image to OffloadMQ bucket,
//! submit detection task, poll and persist JSON results.

use serde::Serialize;
use serde::Deserialize;

use crate::{
    db::{app_settings, image_generation, nude_detect},
    error::AppError,
    offload::{PollResponse, TaskId},
    services::{offload_factory, storage},
    state::AppState,
};

pub const CAPABILITY: &str = "onnx.nudenet";

#[derive(Debug, Serialize)]
pub struct AvailabilityResponse {
    pub available: bool,
    pub capability: &'static str,
    pub active_runners: Vec<ActiveRunner>,
    pub runners_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ActiveRunner {
    pub uid: String,
    pub uid_short: String,
    pub display_name: Option<String>,
    pub tier: u8,
    pub capacity: u32,
    pub last_contact: Option<String>,
}

pub struct StartJobParams {
    pub threshold: f64,
    pub image_id: i64,
}

pub struct CancelJobOutcome {
    pub job_id: i64,
    pub status: String,
    pub message: String,
}

pub async fn check_availability(state: &AppState) -> Result<AvailabilityResponse, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let caps = client.list_capabilities_with_prefix("onnx.").await?;
    let available = caps.iter().any(|c| c.base == CAPABILITY);
    let (active_runners, runners_error) = match list_active_nudenet_runners(state).await {
        Ok(runners) => (runners, None),
        Err(e) => (vec![], Some(e)),
    };
    Ok(AvailabilityResponse {
        available,
        capability: CAPABILITY,
        active_runners,
        runners_error,
    })
}

#[derive(Debug, Deserialize)]
struct MgmtAgent {
    uid: String,
    uid_short: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    tier: u8,
    #[serde(default)]
    capacity: u32,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    last_contact: Option<String>,
}

async fn list_active_nudenet_runners(state: &AppState) -> Result<Vec<ActiveRunner>, String> {
    let settings = app_settings::get(&state.db).await.map_err(|e| e.to_string())?;
    let token = settings
        .management_api_token
        .as_deref()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "management_api_token is not configured".to_string())?;
    let base_url = settings.offloadmq_url.trim_end_matches('/');
    let url = format!("{base_url}/management/agents/list/online");
    let resp = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("management endpoint returned {}", resp.status()));
    }
    let agents: Vec<MgmtAgent> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(agents
        .into_iter()
        .filter(|a| {
            a.capabilities
                .iter()
                .any(|cap| base_capability(cap) == CAPABILITY)
        })
        .map(|a| ActiveRunner {
            uid: a.uid,
            uid_short: a.uid_short,
            display_name: a.display_name,
            tier: a.tier,
            capacity: a.capacity,
            last_contact: a.last_contact,
        })
        .collect())
}

fn base_capability(cap: &str) -> &str {
    cap.split_once('[').map(|(base, _)| base).unwrap_or(cap)
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    if !(0.05..=0.95).contains(&req.threshold) {
        return Err(AppError::BadRequest(
            "threshold must be between 0.05 and 0.95".into(),
        ));
    }

    let input = image_generation::get_image_file(&state.db, req.image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let job_id = state.next_id();
    nude_detect::create_job(
        &state.db,
        nude_detect::NewJobInput {
            id: job_id,
            user_id,
            threshold: req.threshold,
            input_image_id: Some(input.id),
        },
    )
    .await?;

    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    img_client
        .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &input.content_type)
        .await?;

    let chat_client = offload_factory::chat_client(state).await?;
    let task_id = chat_client
        .submit_nudenet_task(req.threshold, &bucket.bucket_uid)
        .await?;

    nude_detect::set_offload_task(
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
    let job = nude_detect::get_job(&state.db, job_id, user_id)
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
    start_job(
        state,
        user_id,
        StartJobParams {
            threshold: job.threshold,
            image_id,
        },
    )
    .await
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelJobOutcome, AppError> {
    let job = nude_detect::get_job(&state.db, job_id, user_id)
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
        nude_detect::update_status(&state.db, job.id, "canceled", None, Some(message)).await?;
        return Ok(CancelJobOutcome {
            job_id: job.id,
            status: "canceled".into(),
            message: message.into(),
        });
    };

    let client = offload_factory::chat_client(state).await?;
    match client.cancel_task(&TaskId { cap, id: task_id }).await {
        Ok(resp) => {
            nude_detect::update_status(&state.db, job.id, &resp.status, None, None).await?;
            Ok(CancelJobOutcome {
                job_id: job.id,
                status: resp.status,
                message: resp.message,
            })
        }
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                nude_detect::update_status(&state.db, job.id, "failed", None, Some(&reason))
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
    nude_detect::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    nude_detect::delete_job(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<nude_detect::NudeDetectJob, AppError> {
    let job = nude_detect::get_job(&state.db, job_id, user_id)
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
            nude_detect::update_status(&state.db, job.id, "failed", None, Some(&reason)).await?;
        } else {
            return Err(e);
        }
    }
    nude_detect::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<nude_detect::NudeDetectJob>, AppError> {
    nude_detect::list_jobs(&state.db, user_id, limit).await
}

pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    let jobs = nude_detect::list_jobs_for_background_worker(&state.db, batch_size).await?;
    for job in jobs {
        let (Some(cap), Some(task_id)) = (job.offload_cap.clone(), job.offload_task_id.clone())
        else {
            continue;
        };
        match run_poll_once(state, &job, &cap, &task_id).await {
            Ok(()) => {}
            Err(e) => {
                if let Some(reason) = offload_task_missing_message(&e) {
                    let _ = nude_detect::update_status(
                        &state.db,
                        job.id,
                        "failed",
                        None,
                        Some(&reason),
                    )
                    .await;
                } else {
                    tracing::warn!("nude detect poll failed for job {}: {e}", job.id);
                }
            }
        }
    }
    Ok(())
}

async fn run_poll_once(
    state: &AppState,
    job: &nude_detect::NudeDetectJob,
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
    job: &nude_detect::NudeDetectJob,
    poll: &PollResponse,
) -> Result<(), AppError> {
    match poll.status.as_str() {
        "completed" => {
            let json = extract_nudenet_output(&poll.output);
            if json.is_none() {
                nude_detect::update_status(
                    &state.db,
                    job.id,
                    "failed",
                    None,
                    Some("nudenet task returned empty result"),
                )
                .await?;
            } else {
                let text = serde_json::to_string(&json.unwrap())
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                nude_detect::set_result(&state.db, job.id, &text).await?;
            }
        }
        "failed" => {
            let err = extract_error_text(&poll.output);
            nude_detect::update_status(&state.db, job.id, "failed", None, Some(&err)).await?;
        }
        "canceled" => {
            nude_detect::update_status(&state.db, job.id, "canceled", None, None).await?;
        }
        other => {
            nude_detect::update_status(&state.db, job.id, other, poll.stage.as_deref(), None)
                .await?;
        }
    }
    Ok(())
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

fn extract_nudenet_output(output: &Option<serde_json::Value>) -> Option<serde_json::Value> {
    output.as_ref().and_then(|v| {
        if v.get("results").is_some() {
            Some(v.clone())
        } else {
            v.get("output").cloned().filter(|inner| inner.get("results").is_some())
        }
    })
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("nudenet task failed")
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
