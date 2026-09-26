//! Read models: job detail views, the imggen capability listing, and admin listings.

use super::*;

/// A job plus its files and pipeline events, used to build detail responses.
pub struct JobDetail {
    pub job: image_generation::ImageGenerationJob,
    pub files: Vec<image_generation::ImageFile>,
    pub events: Vec<image_generation::ImagePipelineEvent>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub started_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub typical_runtime_seconds: Option<f64>,
    pub submitted_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub queued_seconds: Option<f64>,
    pub execution_seconds: Option<f64>,
}

/// Number of the user's most recent runs to consider when ranking models by usage.
pub(super) const USAGE_HISTORY_RUNS: u64 = 20;

pub(super) async fn recent_capability_usage(
    state: &AppState,
    user_id: i64,
) -> Result<HashMap<String, u32>, AppError> {
    let recent_caps =
        image_generation::recent_job_capabilities(&state.db, user_id, USAGE_HISTORY_RUNS).await?;
    let mut usage = HashMap::new();
    for capability in recent_caps {
        *usage.entry(capability).or_insert(0) += 1;
    }
    Ok(usage)
}

pub async fn list_imggen_capabilities(
    state: &AppState,
    user_id: i64,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    use std::collections::HashSet;

    let usage = recent_capability_usage(state, user_id).await?;
    let settings = app_settings::get(&state.db).await?;
    let api_key = settings.client_api_token.clone().unwrap_or_default();

    if api_key.is_empty() {
        // No client token — return known caps from DB, all marked offline.
        let online_bases = HashSet::new();
        return imggen_capabilities::list_for_display(&state.db, &online_bases, &usage).await;
    }

    let client =
        OffloadClient::new(state.http.clone(), settings.offloadmq_url, api_key, state.watch.clone());
    let now = chrono::Utc::now().to_rfc3339();
    let online_caps: Vec<LlmCapabilityInfo> = client
        .list_capabilities_with_prefix("imggen.")
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|c| LlmCapabilityInfo {
            base: c.base,
            tags: c.tags,
            raw: c.raw,
            online: true,
            last_available_at: now.clone(),
            usage_count: 0,
        })
        .collect();

    imggen_capabilities::sync_online(&state.db, &online_caps).await?;
    let online_bases: HashSet<String> = online_caps.iter().map(|c| c.base.clone()).collect();
    imggen_capabilities::list_for_display(&state.db, &online_bases, &usage).await
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

pub(super) async fn job_detail(
    state: &AppState,
    job: image_generation::ImageGenerationJob,
) -> Result<JobDetail, AppError> {
    let files = limit_job_output_files(image_generation::list_job_files(&state.db, job.id).await?);
    let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
    let offload = image_generation::get_offload_task_by_job(&state.db, job.id).await?;
    let progress = offload.as_ref().map(offload_progress_meta);
    Ok(JobDetail {
        job,
        files,
        events,
        offload_cap: offload.as_ref().map(|t| t.offload_cap.clone()),
        offload_task_id: offload.map(|t| t.offload_task_id),
        started_at: progress.as_ref().and_then(|p| p.started_at),
        typical_runtime_seconds: progress.as_ref().and_then(|p| p.typical_runtime_seconds),
        submitted_at: progress.as_ref().and_then(|p| p.submitted_at),
        queued_seconds: progress.as_ref().and_then(|p| p.queued_seconds),
        execution_seconds: progress.and_then(|p| p.execution_seconds),
    })
}

/// Batched sibling of [`job_detail`] for list endpoints: fetches files, events,
/// and offload tasks for every job in one query each (instead of three queries
/// per job), then assembles each `JobDetail` from the grouped results.
pub(super) async fn collect_details(
    state: &AppState,
    jobs: Vec<image_generation::ImageGenerationJob>,
) -> Result<Vec<JobDetail>, AppError> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    let job_ids: Vec<i64> = jobs.iter().map(|j| j.id).collect();

    let all_files = image_generation::list_job_files_for_jobs(&state.db, &job_ids).await?;
    let all_events = image_generation::list_pipeline_events_for_jobs(&state.db, &job_ids).await?;
    let all_offload = image_generation::list_offload_tasks_for_jobs(&state.db, &job_ids).await?;

    let mut files_by_job: HashMap<i64, Vec<image_generation::ImageFile>> = HashMap::new();
    for f in all_files {
        if let Some(jid) = f.job_id {
            files_by_job.entry(jid).or_default().push(f);
        }
    }
    let mut events_by_job: HashMap<i64, Vec<image_generation::ImagePipelineEvent>> = HashMap::new();
    for e in all_events {
        events_by_job.entry(e.job_id).or_default().push(e);
    }
    let mut offload_by_job: HashMap<i64, image_generation::ImageOffloadTask> = HashMap::new();
    for t in all_offload {
        offload_by_job.insert(t.job_id, t);
    }

    let mut out = Vec::with_capacity(jobs.len());
    for job in jobs {
        let files = limit_job_output_files(files_by_job.remove(&job.id).unwrap_or_default());
        let events = events_by_job.remove(&job.id).unwrap_or_default();
        let offload = offload_by_job.remove(&job.id);
        let progress = offload.as_ref().map(offload_progress_meta);
        out.push(JobDetail {
            offload_cap: offload.as_ref().map(|t| t.offload_cap.clone()),
            offload_task_id: offload.map(|t| t.offload_task_id),
            started_at: progress.as_ref().and_then(|p| p.started_at),
            typical_runtime_seconds: progress.as_ref().and_then(|p| p.typical_runtime_seconds),
            submitted_at: progress.as_ref().and_then(|p| p.submitted_at),
            queued_seconds: progress.as_ref().and_then(|p| p.queued_seconds),
            execution_seconds: progress.and_then(|p| p.execution_seconds),
            job,
            files,
            events,
        });
    }
    Ok(out)
}

pub(super) async fn output_files(
    state: &AppState,
    job_id: i64,
) -> Result<Vec<image_generation::ImageFile>, AppError> {
    let files = limit_job_output_files(image_generation::list_job_files(&state.db, job_id).await?);
    Ok(files.into_iter().filter(|f| f.direction == "output").collect())
}
