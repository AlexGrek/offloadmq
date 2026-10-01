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
        external_resize, image_processing,
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
    /// Shrink the input with an `image_resize` task on an agent instead of
    /// decoding it locally. See [`external_resize`] for why that matters for
    /// uploads big enough to bypass local processing.
    pub external_resize: bool,
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
        // A finished resize pre-step is not a finished job: it hands its output
        // bucket to the vision task, which is submitted now and polled from here on.
        if job.offload_cap.as_deref().is_some_and(external_resize::is_pre_step) {
            return promote_after_resize(state, job, poll).await;
        }

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

/// Number of the user's most recent describe jobs considered when ranking models
/// by usage — same window as image generation.
const USAGE_HISTORY_RUNS: u64 = 20;

/// Vision models for the picker: online first, ranked by how often the user ran
/// them in their recent describe jobs, then by most recent availability.
pub async fn list_vision_capabilities(
    state: &AppState,
    user_id: i64,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    let all = llm_capabilities::list_for_display(&state.db, &online_bases).await?;

    let recent =
        image_analysis::recent_job_capabilities(&state.db, user_id, USAGE_HISTORY_RUNS).await?;
    let mut usage: HashMap<String, u32> = HashMap::new();
    for capability in recent {
        *usage.entry(capability).or_insert(0) += 1;
    }

    let vision = all
        .into_iter()
        .filter(|c| c.tags.iter().any(|t| t.eq_ignore_ascii_case("vision")))
        .collect();
    Ok(rank_by_usage(vision, &usage))
}

/// Stamps `usage_count` and moves the most-used online models to the front.
/// The sort is stable, so ties keep `list_for_display`'s online-first,
/// most-recently-available order; offline models are never reordered by usage.
fn rank_by_usage(
    mut caps: Vec<LlmCapabilityInfo>,
    usage: &HashMap<String, u32>,
) -> Vec<LlmCapabilityInfo> {
    for cap in &mut caps {
        cap.usage_count = usage.get(&cap.base).copied().unwrap_or(0);
    }
    caps.sort_by_key(|c| {
        let online_usage = if c.online { c.usage_count } else { 0 };
        (!c.online, std::cmp::Reverse(online_usage))
    });
    caps
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
            external_resize: req.external_resize,
        },
    )
    .await?;

    let img_client = offload_factory::image_client(state).await?;

    // External resize makes this a two-task job: an `image_resize` pre-step runs
    // first and `promote_after_resize` submits the vision task once it lands. The
    // stored bytes go up untouched — not decoding them here is the whole point.
    if req.external_resize {
        let pre = external_resize::submit(state, &img_client, &input).await?;
        offload_jobs::set_offload_task::<ImageAnalysisJobEntity>(
            &state.db,
            job_id,
            &pre.task_id.cap,
            &pre.task_id.id,
            Some(&pre.output_bucket),
        )
        .await?;
        state.watch.track(&pre.task_id.cap, &pre.task_id.id).await;
        return Ok(job_id);
    }

    let bucket = img_client.create_bucket(true).await?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    let (bytes, content_type) = if data_prep.is_some() {
        (bytes, input.content_type.clone())
    } else {
        let processed = image_processing::process_image_async(bytes, Some(input.content_type.clone())).await?;
        (processed.bytes, processed.content_type)
    };
    img_client
        .upload_bucket_file(&bucket.bucket_uid, bytes, &input.filename, &content_type)
        .await?;

    submit_vision_task(state, job_id, &capability, prompt, &bucket.bucket_uid, data_prep.as_ref())
        .await?;

    Ok(job_id)
}

/// Submit the vision task against a bucket that already holds the input image,
/// and point the job's offload task at it.
async fn submit_vision_task(
    state: &AppState,
    job_id: i64,
    capability: &str,
    prompt: &str,
    bucket_uid: &str,
    data_prep: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<(), AppError> {
    let chat_client = offload_factory::chat_client(state).await?;
    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    let task_id = chat_client
        .submit_vision_task(capability, messages, bucket_uid, data_prep)
        .await?;

    offload_jobs::set_offload_task::<ImageAnalysisJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        Some(bucket_uid),
    )
    .await?;
    state.watch.track(&task_id.cap, &task_id.id).await;
    Ok(())
}

/// Hand the resize pre-step's output bucket to the vision task.
///
/// The resized image already sits in an OffloadMQ bucket, so it is used as the
/// vision task's `file_bucket` directly — it never round-trips through OAI.
async fn promote_after_resize(
    state: &AppState,
    job: &image_analysis::ImageAnalysisJob,
    poll: &NormalizedPoll,
) -> Result<(), AppError> {
    // The pre-step's own output bucket was recorded on the job at submit time.
    let resized =
        external_resize::completed_output(poll.output.as_ref(), job.offload_bucket_uid.as_deref());
    let Some(resized) = resized else {
        // The pre-step finished and produced nothing usable; re-polling cannot fix it.
        return offload_jobs::update_status::<ImageAnalysisJobEntity>(
            &state.db,
            job.id,
            "failed",
            None,
            Some("external resize finished without an output image"),
        )
        .await;
    };

    let data_prep = job
        .data_preparation
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(s).ok());
    submit_vision_task(
        state,
        job.id,
        &job.capability,
        &job.prompt,
        &resized.bucket_uid,
        data_prep.as_ref(),
    )
    .await
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
            external_resize: job.external_resize,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(base: &str, online: bool) -> LlmCapabilityInfo {
        LlmCapabilityInfo {
            base: base.to_string(),
            tags: vec!["vision".into()],
            raw: base.to_string(),
            online,
            last_available_at: String::new(),
            usage_count: 0,
        }
    }

    fn bases(caps: &[LlmCapabilityInfo]) -> Vec<&str> {
        caps.iter().map(|c| c.base.as_str()).collect()
    }

    #[test]
    fn most_used_online_model_comes_first() {
        let usage = HashMap::from([("llm.a".to_string(), 1u32), ("llm.b".to_string(), 5u32)]);
        let ranked = rank_by_usage(vec![cap("llm.a", true), cap("llm.b", true)], &usage);
        assert_eq!(bases(&ranked), ["llm.b", "llm.a"]);
        assert_eq!(ranked[0].usage_count, 5);
    }

    #[test]
    fn usage_ties_keep_incoming_order() {
        let usage = HashMap::new();
        let ranked = rank_by_usage(vec![cap("llm.b", true), cap("llm.a", true)], &usage);
        assert_eq!(bases(&ranked), ["llm.b", "llm.a"]);
    }

    #[test]
    fn offline_never_jumps_ahead_of_online_or_reorders_by_usage() {
        let usage = HashMap::from([("llm.c".to_string(), 100u32)]);
        let ranked = rank_by_usage(
            vec![cap("llm.a", true), cap("llm.b", false), cap("llm.c", false)],
            &usage,
        );
        assert_eq!(bases(&ranked), ["llm.a", "llm.b", "llm.c"]);
    }
}
