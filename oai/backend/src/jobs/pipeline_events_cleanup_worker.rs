//! Bounds the two image tables that would otherwise grow without limit:
//! `image_pipeline_events` (trimmed to the most recent rows per job) and
//! `image_worker_logs` (trimmed by age).
//!
//! A job's events are meant to be a short timeline for the UI, but a bug in the
//! reconcile pass (fixed alongside this worker) let a handful of jobs retry
//! forever and accumulate hundreds of thousands of rows each. Worker logs have
//! no per-job bound at all — the pipeline worker appends one row per pass
//! forever. This runs once at startup (so a freshly deployed pod doesn't wait a
//! full tick to start shrinking an already-bloated table) and then on a long
//! interval, since trimming is cheap once the tables are caught up.

use std::{sync::Arc, time::Duration};

use crate::{db::image_generation, db::image_worker_logs, error::AppError, state::AppState};

const DEFAULT_TICK_SECS: u64 = 6 * 3600;
/// Most-recent events kept per job.
const KEEP_PER_JOB: u64 = 300;
/// Worst-offender job ids trimmed per pass, bounding how much work one pass does.
const JOB_BATCH: u64 = 1000;
/// Age cutoff for `image_worker_logs`, which is a pure time series.
const WORKER_LOG_MAX_AGE_DAYS: u64 = 7;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let tick_secs = std::env::var("PIPELINE_EVENTS_CLEANUP_TICK_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TICK_SECS);

        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));

        loop {
            if let Err(e) = run_pass(&state).await {
                tracing::warn!("pipeline events cleanup pass failed: {e}");
            }
            ticker.tick().await;
        }
    });
}

async fn run_pass(state: &AppState) -> Result<(), AppError> {
    prune_pipeline_events(state).await?;
    prune_worker_logs(state).await
}

async fn prune_pipeline_events(state: &AppState) -> Result<(), AppError> {
    let job_ids =
        image_generation::jobs_with_excess_pipeline_events(&state.db, KEEP_PER_JOB, JOB_BATCH).await?;
    if job_ids.is_empty() {
        return Ok(());
    }

    let mut total_deleted = 0u64;
    for job_id in job_ids {
        total_deleted +=
            image_generation::prune_pipeline_events_for_job(&state.db, job_id, KEEP_PER_JOB).await?;
    }
    tracing::info!("pipeline events cleanup removed {total_deleted} stale event row(s)");
    Ok(())
}

async fn prune_worker_logs(state: &AppState) -> Result<(), AppError> {
    let deleted =
        image_worker_logs::delete_older_than(&state.db, WORKER_LOG_MAX_AGE_DAYS).await?;
    if deleted > 0 {
        tracing::info!(
            "worker log cleanup removed {deleted} row(s) older than {WORKER_LOG_MAX_AGE_DAYS} days"
        );
    }
    Ok(())
}
