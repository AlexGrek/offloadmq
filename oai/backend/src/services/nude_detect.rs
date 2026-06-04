//! NudeNet (`onnx.nudenet`) job orchestration — upload image to OffloadMQ bucket,
//! submit detection task, persist JSON results. The poll/cancel/reconcile state
//! machine is the shared [`offload_job`] driver; this module supplies the
//! detection-specific pieces: availability check, job submission, and the
//! completed-result handler.

use async_trait::async_trait;
use serde::Deserialize;
use serde::Serialize;

use crate::{
    db::{
        app_settings, entities::nude_detect_jobs::Entity as NudeDetectJobEntity, image_generation,
        nude_detect, offload_jobs,
    },
    error::AppError,
    offload::task_status::{NormalizedPoll, OffloadPoller},
    services::{
        offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
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

/// Drives the generic poll/cancel/reconcile lifecycle for nude-detect jobs.
struct NudeDetectReconciler;

#[async_trait]
impl JobReconciler for NudeDetectReconciler {
    type Entity = NudeDetectJobEntity;

    fn label(&self) -> &'static str {
        "nude detect"
    }

    fn failure_fallback(&self) -> &'static str {
        "nudenet task failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::chat_client(state).await?))
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &nude_detect::NudeDetectJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        let Some(json) = extract_nudenet_output(&poll.output) else {
            return offload_jobs::update_status::<NudeDetectJobEntity>(
                &state.db,
                job.id,
                "failed",
                None,
                Some("nudenet task returned empty result"),
            )
            .await;
        };
        let text = serde_json::to_string(&json).map_err(|e| AppError::Internal(e.to_string()))?;
        nude_detect::set_result(&state.db, job.id, &text).await
    }
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

    offload_jobs::set_offload_task::<NudeDetectJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        Some(&bucket.bucket_uid),
    )
    .await?;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = offload_jobs::get_job::<NudeDetectJobEntity>(&state.db, job_id, user_id)
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
    start_job(state, user_id, StartJobParams { threshold: job.threshold, image_id }).await
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&NudeDetectReconciler, state, user_id, job_id).await
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    offload_jobs::get_job::<NudeDetectJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    offload_jobs::delete_job::<NudeDetectJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<nude_detect::NudeDetectJob, AppError> {
    offload_job::poll_job(&NudeDetectReconciler, state, user_id, job_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<nude_detect::NudeDetectJob>, AppError> {
    offload_jobs::list_jobs::<NudeDetectJobEntity>(&state.db, user_id, limit).await
}

pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&NudeDetectReconciler, state, batch_size).await
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
