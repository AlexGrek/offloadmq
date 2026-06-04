//! Shared runtime for the simple "reconcile on a tick" background workers.
//!
//! Every offload-job feature runs the same loop: read tick/batch overrides from
//! env, then on each interval call its reconcile pass and log a warning on
//! failure. This collapses each `jobs/<feature>_worker.rs` down to a config +
//! the pass function. (The image-pipeline worker keeps its own loop because it
//! also records per-run logs.)

use std::{future::Future, sync::Arc, time::Duration};

use crate::{error::AppError, state::AppState};

/// Per-feature knobs for [`spawn`].
pub struct WorkerConfig {
    /// Label used in log lines, e.g. `"tts"`.
    pub label: &'static str,
    /// Env var overriding the tick interval (seconds).
    pub tick_env: &'static str,
    /// Env var overriding the per-pass batch size.
    pub batch_env: &'static str,
    pub default_tick_secs: u64,
    pub default_batch_size: u64,
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// Spawn a background task that runs `pass(state, batch_size)` on every tick.
pub fn spawn<F, Fut>(state: Arc<AppState>, config: WorkerConfig, pass: F)
where
    F: Fn(Arc<AppState>, u64) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), AppError>> + Send,
{
    tokio::spawn(async move {
        let tick_secs = env_u64(config.tick_env, config.default_tick_secs);
        let batch_size = env_u64(config.batch_env, config.default_batch_size);

        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
        ticker.tick().await;

        loop {
            ticker.tick().await;
            if let Err(e) = pass(state.clone(), batch_size).await {
                tracing::warn!("{} worker pass failed: {e}", config.label);
            }
        }
    });
}
