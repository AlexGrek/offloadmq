//! Generic poll / cancel / reconcile driver shared by every offload-job feature.
//!
//! The lifecycle of a submitted task is identical across features: poll the
//! upstream task, and on `completed` persist the result, on `failed`/`canceled`
//! flip the local status, otherwise record progress. Only two things vary per
//! feature — which OffloadMQ client to poll with, and how to persist a completed
//! result. A feature supplies both by implementing [`JobReconciler`]; everything
//! else (the state machine, "task missing" handling, the background batch loop)
//! lives here.

use async_trait::async_trait;
use sea_orm::EntityTrait;

use crate::{
    db::offload_jobs::{self, OffloadJobEntity, OffloadJobModel},
    error::AppError,
    offload::task_status::{self, NormalizedPoll, OffloadPoller},
    state::AppState,
};

pub struct CancelOutcome {
    pub job_id: i64,
    pub status: String,
    pub message: String,
}

/// Per-feature glue for the generic driver. Implement on a zero-sized marker
/// type (e.g. `struct TtsReconciler;`).
#[async_trait]
pub trait JobReconciler: Send + Sync
where
    <Self::Entity as EntityTrait>::Model: OffloadJobModel,
{
    /// The SeaORM entity backing this feature's job table.
    type Entity: OffloadJobEntity + Send + Sync;

    /// Short label used in worker log lines, e.g. `"tts"`.
    fn label(&self) -> &'static str;

    /// Message used when a failed task carries no error text of its own.
    fn failure_fallback(&self) -> &'static str {
        "task failed"
    }

    /// Build the OffloadMQ poller for this feature (chat client vs image client).
    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError>;

    /// Persist the result of a *completed* task (text, audio blob, output files…).
    /// The failed / canceled / in-progress transitions are handled generically
    /// and never reach this method.
    async fn on_completed(
        &self,
        state: &AppState,
        job: &<Self::Entity as EntityTrait>::Model,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError>;
}

/// Poll a single job once and apply the resulting transition. Used by both the
/// foreground `poll_job` and the background `reconcile_pass`.
async fn reconcile_one<R>(
    reconciler: &R,
    state: &AppState,
    job: &<R::Entity as EntityTrait>::Model,
    cap: &str,
    task_id: &str,
) -> Result<(), AppError>
where
    R: JobReconciler,
    <R::Entity as EntityTrait>::Model: OffloadJobModel,
{
    let poller = reconciler.poller(state).await?;
    let poll = poller.poll(cap, task_id).await?;
    match poll.status.as_str() {
        "completed" => reconciler.on_completed(state, job, &poll).await?,
        "failed" => {
            let err = task_status::extract_error_text(&poll.output, reconciler.failure_fallback());
            offload_jobs::update_status::<R::Entity>(&state.db, job.id(), "failed", None, Some(&err))
                .await?;
        }
        "canceled" => {
            offload_jobs::update_status::<R::Entity>(&state.db, job.id(), "canceled", None, None)
                .await?;
        }
        other => {
            offload_jobs::update_status::<R::Entity>(
                &state.db,
                job.id(),
                other,
                poll.stage.as_deref(),
                None,
            )
            .await?;
        }
    }
    Ok(())
}

/// Foreground poll: advance one in-flight job and return the refreshed row.
/// Terminal or not-yet-submitted jobs are returned unchanged.
pub async fn poll_job<R>(
    reconciler: &R,
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<<R::Entity as EntityTrait>::Model, AppError>
where
    R: JobReconciler,
    <R::Entity as EntityTrait>::Model: OffloadJobModel,
{
    let job = offload_jobs::get_job::<R::Entity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(job.status()) {
        return Ok(job);
    }
    let (Some(cap), Some(task_id)) = (
        job.offload_cap().map(str::to_string),
        job.offload_task_id().map(str::to_string),
    ) else {
        return Ok(job);
    };
    if let Err(e) = reconcile_one(reconciler, state, &job, &cap, &task_id).await {
        if let Some(reason) = task_status::offload_task_missing_message(&e) {
            offload_jobs::update_status::<R::Entity>(&state.db, job_id, "failed", None, Some(&reason))
                .await?;
        } else {
            return Err(e);
        }
    }
    offload_jobs::get_job::<R::Entity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Request cancellation of an in-flight job. Cancels the upstream task when one
/// exists, otherwise marks the local row canceled.
pub async fn cancel_job<R>(
    reconciler: &R,
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError>
where
    R: JobReconciler,
    <R::Entity as EntityTrait>::Model: OffloadJobModel,
{
    let job = offload_jobs::get_job::<R::Entity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(job.status()) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status()
        )));
    }

    let (Some(cap), Some(task_id)) = (
        job.offload_cap().map(str::to_string),
        job.offload_task_id().map(str::to_string),
    ) else {
        let message = "Canceled before OffloadMQ task was created";
        offload_jobs::update_status::<R::Entity>(&state.db, job.id(), "canceled", None, Some(message))
            .await?;
        return Ok(CancelOutcome {
            job_id: job.id(),
            status: "canceled".into(),
            message: message.into(),
        });
    };

    let poller = reconciler.poller(state).await?;
    match poller.cancel(&cap, &task_id).await {
        Ok(resp) => {
            offload_jobs::update_status::<R::Entity>(&state.db, job.id(), &resp.status, None, None)
                .await?;
            Ok(CancelOutcome {
                job_id: job.id(),
                status: resp.status,
                message: resp.message,
            })
        }
        Err(e) => {
            if let Some(reason) = task_status::offload_task_missing_message(&e) {
                offload_jobs::update_status::<R::Entity>(
                    &state.db,
                    job.id(),
                    "failed",
                    None,
                    Some(&reason),
                )
                .await?;
                Ok(CancelOutcome {
                    job_id: job.id(),
                    status: "failed".into(),
                    message: reason,
                })
            } else {
                Err(e)
            }
        }
    }
}

/// Background worker pass: advance every non-terminal job, oldest first.
/// "Task missing" marks the job failed; other poll errors are logged and skipped
/// so a single bad job (or OffloadMQ being down) never aborts the batch.
pub async fn reconcile_pass<R>(
    reconciler: &R,
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError>
where
    R: JobReconciler,
    <R::Entity as EntityTrait>::Model: OffloadJobModel,
{
    let jobs =
        offload_jobs::list_jobs_for_background_worker::<R::Entity>(&state.db, batch_size).await?;
    for job in jobs {
        let (Some(cap), Some(task_id)) = (
            job.offload_cap().map(str::to_string),
            job.offload_task_id().map(str::to_string),
        ) else {
            continue;
        };
        match reconcile_one(reconciler, state, &job, &cap, &task_id).await {
            Ok(()) => {}
            Err(e) => {
                if let Some(reason) = task_status::offload_task_missing_message(&e) {
                    let _ = offload_jobs::update_status::<R::Entity>(
                        &state.db,
                        job.id(),
                        "failed",
                        None,
                        Some(&reason),
                    )
                    .await;
                } else {
                    tracing::warn!(
                        "{} poll failed for job {}: {e}",
                        reconciler.label(),
                        job.id()
                    );
                }
            }
        }
    }
    Ok(())
}
