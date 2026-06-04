//! Image-analysis (describe) job orchestration: persist describe jobs, stage the
//! input image in an OffloadMQ bucket, submit a vision task, and persist the text
//! result on completion. The poll/cancel/reconcile state machine is the shared
//! [`offload_job`] driver; this module supplies the analysis-specific pieces.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;

use crate::{
    db::{
        entities::image_analysis_jobs::Entity as ImageAnalysisJobEntity, image_analysis,
        image_generation, llm_capabilities, offload_jobs,
    },
    error::AppError,
    offload::{
        task_status::{self, NormalizedPoll, OffloadPoller},
        LlmCapabilityInfo,
    },
    services::{
        image_processing,
        offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
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

/// Drives the generic poll/cancel/reconcile lifecycle for image-analysis jobs.
struct ImageAnalysisReconciler;

#[async_trait]
impl JobReconciler for ImageAnalysisReconciler {
    type Entity = ImageAnalysisJobEntity;

    fn label(&self) -> &'static str {
        "image analysis"
    }

    fn failure_fallback(&self) -> &'static str {
        "vision task failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::chat_client(state).await?))
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &image_analysis::ImageAnalysisJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        let text = task_status::extract_llm_text(&poll.output);
        if text.is_empty() {
            offload_jobs::update_status::<ImageAnalysisJobEntity>(
                &state.db,
                job.id,
                "failed",
                None,
                Some("vision task returned empty result"),
            )
            .await
        } else {
            image_analysis::set_result(&state.db, job.id, &text).await
        }
    }
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
    // OffloadMQ schedules by base capability — strip any extended attributes the
    // model picker may include (e.g. `llm.qwen3-vl:8b[vision;tools]`).
    let capability = crate::offload::base_capability(&req.capability).to_string();

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
            capability: &capability,
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
        .submit_vision_task(&capability, messages, &bucket.bucket_uid, data_prep.as_ref())
        .await?;

    offload_jobs::set_offload_task::<ImageAnalysisJobEntity>(
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
    let job = offload_jobs::get_job::<ImageAnalysisJobEntity>(&state.db, job_id, user_id)
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
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&ImageAnalysisReconciler, state, user_id, job_id).await
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    offload_jobs::get_job::<ImageAnalysisJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    offload_jobs::delete_job::<ImageAnalysisJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<image_analysis::ImageAnalysisJob, AppError> {
    offload_job::poll_job(&ImageAnalysisReconciler, state, user_id, job_id).await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<JobDetail, AppError> {
    let job = offload_jobs::get_job::<ImageAnalysisJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(JobDetail { job })
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<image_analysis::ImageAnalysisJob>, AppError> {
    offload_jobs::list_jobs::<ImageAnalysisJobEntity>(&state.db, user_id, limit).await
}

/// Background worker pass: advances in-flight analysis jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&ImageAnalysisReconciler, state, batch_size).await
}
