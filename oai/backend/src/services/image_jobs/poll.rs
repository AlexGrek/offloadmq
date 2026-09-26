//! Polling, cancelling and reconciling image jobs against OffloadMQ, including the
//! two-task external-resize promotion and the background worker pass.

use super::*;

/// Result of polling a job — domain data the route maps to its response DTO.
pub struct PolledJob {
    pub status: String,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub output_files: Vec<image_generation::ImageFile>,
    /// When the task began executing on an agent (None while still queued).
    pub started_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    /// Heuristic execution-time estimate in seconds (None when unknown).
    pub typical_runtime_seconds: Option<f64>,
    /// When the task was submitted to OffloadMQ (queue-wait anchor).
    pub submitted_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    /// Time spent waiting in queue before an agent began execution (seconds).
    pub queued_seconds: Option<f64>,
    /// Time spent actually executing on an agent (seconds). Only set once terminal.
    pub execution_seconds: Option<f64>,
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
    let Some(task) = image_generation::get_offload_task_by_job(&state.db, job.id).await? else {
        let message = "Canceled before OffloadMQ task was created";
        image_generation::update_job_status(&state.db, job.id, "canceled", Some(message)).await?;
        record_event(state, job.id, "job.cancel", "ok", Some(message)).await?;
        return Ok(CancelJobOutcome {
            job_id: job.id,
            offload_cap: String::new(),
            offload_task_id: String::new(),
            status: "canceled".to_string(),
            message: message.to_string(),
        });
    };
    let resp = match send_offload_cancel(state, &task.offload_cap, &task.offload_task_id).await {
        Ok(r) => r,
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                mark_poll_unreachable(state, job.id, &reason).await?;
                return Ok(CancelJobOutcome {
                    job_id: job.id,
                    offload_cap: task.offload_cap,
                    offload_task_id: task.offload_task_id,
                    status: "failed".to_string(),
                    message: reason,
                });
            }
            return Err(e);
        }
    };
    image_generation::update_job_status(&state.db, job.id, &resp.status, None).await?;
    if is_terminal(&resp.status) {
        image_generation::mark_offload_task_finished(&state.db, task.id).await?;
        // `cancelRequested` is not the end — the poll that sees `canceled`
        // frees the buckets then.
        release_job_buckets(state, job.id).await;
    }
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
        let progress = offload_progress_meta(&task);
        return Ok(PolledJob {
            output_files: output_files(state, job.id).await?,
            status: job.status,
            stage: task.last_poll_stage,
            error: job.error,
            started_at: progress.started_at,
            typical_runtime_seconds: progress.typical_runtime_seconds,
            submitted_at: progress.submitted_at,
            queued_seconds: progress.queued_seconds,
            execution_seconds: progress.execution_seconds,
        });
    }

    let poll = match poll_and_persist(state, &task).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                mark_poll_unreachable(state, job.id, &reason).await?;
                let job = image_generation::get_job(&state.db, job.id, user_id)
                    .await?
                    .ok_or(AppError::NotFound)?;
                let progress = offload_progress_meta(&task);
                return Ok(PolledJob {
                    output_files: output_files(state, job.id).await?,
                    status: job.status,
                    stage: task.last_poll_stage,
                    error: job.error,
                    started_at: progress.started_at,
                    typical_runtime_seconds: progress.typical_runtime_seconds,
                    submitted_at: progress.submitted_at,
                    queued_seconds: progress.queued_seconds,
                    execution_seconds: progress.execution_seconds,
                });
            }
            return Err(e);
        }
    };
    record_event(state, job.id, "offload.poll", "ok", Some(&poll_summary(&poll))).await?;
    apply_poll_outcome_to_job(state, &job, &task, &poll).await?;

    // Re-read the offload task to pick up `started_at`/`finished_at` (set by
    // poll_and_persist the first time the agent began/finished executing).
    let task = image_generation::get_offload_task_by_job(&state.db, job.id)
        .await?
        .ok_or_else(|| AppError::BadRequest("job has no offload task".into()))?;
    let progress = offload_progress_meta(&task);
    let job = image_generation::get_job(&state.db, job.id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(PolledJob {
        output_files: output_files(state, job.id).await?,
        status: job.status,
        stage: poll.stage,
        error: job.error,
        started_at: progress.started_at,
        typical_runtime_seconds: progress.typical_runtime_seconds,
        submitted_at: progress.submitted_at,
        queued_seconds: progress.queued_seconds,
        execution_seconds: progress.execution_seconds,
    })
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
            "completed" => (
                "worker.reconcile",
                reconcile_job_outputs_if_missing(state, &job, job.user_id).await,
            ),
            // Everything else the pickup query returns is in flight — including the
            // raw upstream statuses (`queued`/`assigned`/`starting`) a poll mirrors
            // into the row. Matching a narrower list here would silently drop them.
            status if !is_terminal(status) => {
                ("worker.poll", background_poll_once(state, &job).await)
            }
            _ => continue,
        };
        if let (step, Err(e)) = outcome {
            record_event(state, job.id, step, "error", Some(&format!("{e}")))
                .await
                .log_warn("record pipeline error event");
        }
    }
    Ok(())
}

pub(super) async fn mark_poll_unreachable(state: &AppState, job_id: i64, reason: &str) -> Result<(), AppError> {
    image_generation::update_job_status(&state.db, job_id, "failed", Some(reason)).await?;
    if let Some(task) = image_generation::get_offload_task_by_job(&state.db, job_id).await? {
        image_generation::mark_offload_task_finished(&state.db, task.id).await?;
    }
    release_job_buckets(state, job_id).await;
    record_event(state, job_id, "offload.poll", "error", Some(reason)).await?;
    record_event(state, job_id, "job.finalize", "error", Some(reason)).await
}

pub(super) fn poll_summary(poll: &OffloadPollResponse) -> String {
    format!("status={} stage={}", poll.status, poll.stage.clone().unwrap_or_default())
}


pub(super) fn offload_progress_meta(task: &image_generation::ImageOffloadTask) -> OffloadTiming {
    let queued_seconds = task
        .started_at
        .map(|started| (started - task.submitted_at).num_milliseconds() as f64 / 1000.0);
    let execution_seconds = task
        .started_at
        .zip(task.finished_at)
        .map(|(started, finished)| (finished - started).num_milliseconds() as f64 / 1000.0);
    OffloadTiming {
        started_at: task.started_at,
        typical_runtime_seconds: task.typical_runtime_seconds.filter(|s| *s > 0.0),
        submitted_at: Some(task.submitted_at),
        queued_seconds,
        execution_seconds,
    }
}

/// Polls the offload task and writes the latest poll snapshot to the DB.
pub(super) async fn poll_and_persist(
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
        poll.typical_runtime_seconds.map(|d| d.as_secs_f64()),
    )
    .await?;
    // Stamp the real execution-start time the first time the agent actually
    // begins work (not while pending/queued/assigned), so the progress bar
    // measures run time rather than queue wait. Set-once via IS NULL filter.
    if matches!(poll.status.as_str(), "starting" | "running") {
        image_generation::mark_offload_task_started(&state.db, task.id).await?;
    }
    // Stamp the finish time the first time the task reaches a terminal status,
    // so execution duration (finished_at - started_at) can be computed and
    // displayed separately from queue-wait time. Set-once via IS NULL filter.
    if is_terminal(&poll.status) {
        image_generation::mark_offload_task_finished(&state.db, task.id).await?;
    }
    Ok(poll)
}

pub(super) fn extract_offload_error(poll: &OffloadPollResponse) -> &str {
    poll.output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()))
        .unwrap_or("offload task failed")
}

pub(super) async fn mark_failed(
    state: &AppState,
    job_id: i64,
    poll: &OffloadPollResponse,
) -> Result<(), AppError> {
    let err = extract_offload_error(poll);
    image_generation::update_job_status(&state.db, job_id, poll.status.as_str(), Some(err)).await?;
    // Nothing will be downloaded from a failed or canceled task.
    release_job_buckets(state, job_id).await;
    record_event(state, job_id, "job.finalize", "error", Some(err)).await
}

/// Mirror OffloadMQ poll status into `image_generation_jobs.status` for in-flight tasks.
pub(super) async fn apply_poll_outcome_to_job(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
    task: &image_generation::ImageOffloadTask,
    poll: &OffloadPollResponse,
) -> Result<(), AppError> {
    match poll.status.as_str() {
        // A completed pre-step is not a finished job: it hands its output bucket
        // to the real task, which is submitted now and polled from here on.
        "completed" if external_resize::is_pre_step(&task.offload_cap) => {
            promote_after_resize(state, job, task, poll).await?
        }
        "completed" => fetch_and_store_outputs(state, job.user_id, job, poll.output.clone()).await?,
        "failed" | "canceled" => mark_failed(state, job.id, poll).await?,
        status => {
            image_generation::update_job_status(&state.db, job.id, status, None).await?;
        }
    }
    Ok(())
}

/// Submit the job's real task now that the resize pre-step has produced a smaller
/// input, and repoint the job's offload task row at it.
///
/// The resized image is never downloaded: it already sits in an OffloadMQ bucket,
/// which becomes the real task's input bucket directly.
pub(super) async fn promote_after_resize(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
    task: &image_generation::ImageOffloadTask,
    poll: &OffloadPollResponse,
) -> Result<(), AppError> {
    let fallback = external_resize::bucket_from_submit_payload(&task.submit_payload);
    let Some(resized) = external_resize::completed_output(poll.output.as_ref(), fallback.as_deref())
    else {
        // Retrying cannot help — the pre-step finished and produced nothing to use.
        let msg = "external resize finished without an output image";
        record_event(state, job.id, "offload.resize.promote", "error", Some(msg)).await?;
        image_generation::update_job_status(&state.db, job.id, "failed", Some(msg)).await?;
        // The pre-step's own buckets die with the job — the offload row still
        // describes them here, before `replace_offload_task` would overwrite it.
        release_job_buckets(state, job.id).await;
        return Ok(());
    };

    let params = pipeline_params_for_job(job);
    let client = offload_factory::image_client(state).await?;
    let output_bucket = client.create_bucket(false).await?;
    record_event(
        state,
        job.id,
        "offload.output_bucket.create",
        "ok",
        Some(&format!("bucket={}", output_bucket.bucket_uid)),
    )
    .await?;

    let payload = build_promoted_payload(&params, &resized.filename);
    let data_prep = data_preparation_map(&params.data_preparation);
    let (task_id, submit_payload) = client
        .submit_img_task(
            &crate::offload::base_capability(&params.capability).to_string(),
            payload,
            Some(&resized.bucket_uid),
            &output_bucket.bucket_uid,
            data_prep.as_ref(),
        )
        .await?;

    image_generation::replace_offload_task(
        &state.db,
        task.id,
        &task_id.cap,
        &task_id.id,
        &submit_payload.to_string(),
    )
    .await?;
    state.watch.untrack(&task.offload_cap, &task.offload_task_id).await;
    state.watch.track(&task_id.cap, &task_id.id).await;
    image_generation::update_job_status(&state.db, job.id, "submitted", None).await?;
    record_event(
        state,
        job.id,
        "offload.submit",
        "ok",
        Some(&format!(
            "cap={} id={} resized_input={} (after external resize)",
            task_id.cap, task_id.id, resized.filename
        )),
    )
    .await?;
    Ok(())
}

/// The real task's payload, rebuilt from the job's stored pipeline params and
/// pointed at the resized file rather than the original upload.
pub(super) fn build_promoted_payload(params: &ImagePipelineParams, input_filename: &str) -> Value {
    let mut payload = serde_json::json!({
        "workflow": params.workflow,
        "prompt": params.prompt.trim(),
        "resolution": { "width": params.width, "height": params.height },
        "input_image": input_filename,
    });
    if params.override_negative {
        if let Some(neg) = params.negative_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
            payload["secondary_prompts"] = serde_json::json!({ "negative": neg });
        }
    }
    if let Some(seed) = params.seed {
        payload["seed"] = serde_json::json!(seed);
    }
    if let Some(length) = params.video_length {
        payload["length"] = serde_json::json!(length);
    }
    payload
}

pub(super) async fn send_offload_cancel(
    state: &AppState,
    cap: &str,
    id: &str,
) -> Result<crate::offload::CancelTaskResponse, AppError> {
    let client = offload_factory::image_client(state).await?;
    client
        .cancel_task(&OffloadTaskId {
            cap: cap.to_string(),
            id: id.to_string(),
        })
        .await
}

pub(super) async fn background_poll_once(
    state: &AppState,
    job: &image_generation::ImageGenerationJob,
) -> Result<(), AppError> {
    let Some(task) = image_generation::get_offload_task_by_job(&state.db, job.id).await? else {
        if !is_terminal(&job.status) {
            mark_poll_unreachable(state, job.id, OFFLOAD_TASK_MISSING).await?;
        }
        return Ok(());
    };
    if job.status == "cancelRequested" {
        match send_offload_cancel(state, &task.offload_cap, &task.offload_task_id).await {
            Ok(_) => {
                record_event(
                    state,
                    job.id,
                    "worker.offload.cancel",
                    "ok",
                    Some("re-send cancel for in-flight job"),
                )
                .await?;
            }
            Err(e) => {
                if let Some(reason) = offload_task_missing_message(&e) {
                    mark_poll_unreachable(state, job.id, &reason).await?;
                    return Ok(());
                }
                return Err(e);
            }
        }
    }
    let poll = match poll_and_persist(state, &task).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                mark_poll_unreachable(state, job.id, &reason).await?;
                return Ok(());
            }
            return Err(e);
        }
    };
    record_event(state, job.id, "worker.offload.poll", "ok", Some(&poll_summary(&poll)))
        .await
        .log_warn("record poll event");
    apply_poll_outcome_to_job(state, job, &task, &poll).await?;
    Ok(())
}
