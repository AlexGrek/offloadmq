//! Periodically fails jobs that have been stuck non-terminal for far too long.
//!
//! Every other worker only polls jobs that carry an OffloadMQ task id and sit in
//! a pickup status. Rows that never got that far — a pod restart between the row
//! insert and the submit call leaves `created`/`queued` with no task id — are
//! invisible to them, as are rows left behind when a pickup status set changes.
//! Those rows stay non-terminal forever and keep rendering as in-flight.
//!
//! This worker is the backstop: on a long cooldown it flips anything older than
//! the age threshold to `failed`. The cooldown is deliberately large because
//! nothing here is urgent — the threshold is measured in hours, so ticking more
//! often would only add query noise.

use std::sync::Arc;

use crate::{
    db::{entities, offload_jobs},
    error::AppError,
    jobs::worker_runtime::{self, WorkerConfig},
    state::AppState,
};

/// Written into `error` on every row this worker reaps.
const REASON: &str = "abandoned: no progress before the stale-job timeout";

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "stale_job_reaper",
            tick_env: "STALE_JOB_REAPER_TICK_SECS",
            // This worker has no batch — it is a set-based UPDATE — so the
            // generic "batch" knob carries the age threshold in hours instead.
            batch_env: "STALE_JOB_REAPER_MAX_AGE_HOURS",
            default_tick_secs: 3600,
            default_batch_size: 24,
        },
        |state, max_age_hours| async move { reap(&state, max_age_hours).await },
    );
}

/// Fail every non-terminal job across all job tables whose `updated_at` is older
/// than `max_age_hours`.
async fn reap(state: &AppState, max_age_hours: u64) -> Result<(), AppError> {
    let cutoff = chrono::Utc::now().fixed_offset()
        - chrono::Duration::hours(max_age_hours.min(i64::MAX as u64) as i64);
    let db = &state.db;
    let mut total = 0u64;

    // Tables on the offload-job framework.
    total += offload_jobs::fail_stale_jobs::<entities::img_utils_jobs::Entity>(db, cutoff, REASON)
        .await?;
    total +=
        offload_jobs::fail_stale_jobs::<entities::image_analysis_jobs::Entity>(db, cutoff, REASON)
            .await?;
    total +=
        offload_jobs::fail_stale_jobs::<entities::tts_jobs::Entity>(db, cutoff, REASON).await?;
    total +=
        offload_jobs::fail_stale_jobs::<entities::nude_detect_jobs::Entity>(db, cutoff, REASON)
            .await?;
    total += offload_jobs::fail_stale_jobs::<entities::music_generation_jobs::Entity>(
        db, cutoff, REASON,
    )
    .await?;

    // Bespoke tables — same lifecycle columns, no framework trait impl.
    total += offload_jobs::fail_stale_rows::<entities::image_generation_jobs::Entity>(
        db,
        entities::image_generation_jobs::Column::Status,
        entities::image_generation_jobs::Column::UpdatedAt,
        entities::image_generation_jobs::Column::Error,
        cutoff,
        REASON,
    )
    .await?;
    total += offload_jobs::fail_stale_rows::<entities::movie_jobs::Entity>(
        db,
        entities::movie_jobs::Column::Status,
        entities::movie_jobs::Column::UpdatedAt,
        entities::movie_jobs::Column::Error,
        cutoff,
        REASON,
    )
    .await?;
    total += offload_jobs::fail_stale_rows::<entities::llm_compare_jobs::Entity>(
        db,
        entities::llm_compare_jobs::Column::Status,
        entities::llm_compare_jobs::Column::UpdatedAt,
        entities::llm_compare_jobs::Column::Error,
        cutoff,
        REASON,
    )
    .await?;
    total += offload_jobs::fail_stale_rows::<entities::llm_debate_jobs::Entity>(
        db,
        entities::llm_debate_jobs::Column::Status,
        entities::llm_debate_jobs::Column::UpdatedAt,
        entities::llm_debate_jobs::Column::Error,
        cutoff,
        REASON,
    )
    .await?;

    if total > 0 {
        tracing::info!("stale_job_reaper: failed {total} job(s) older than {max_age_hours}h");
    }
    Ok(())
}
