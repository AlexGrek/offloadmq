//! Shared runtime for the simple "reconcile on a tick" background workers.
//!
//! Every offload-job feature runs the same loop: read tick/batch overrides from
//! env, then call its reconcile pass and log a warning on failure. This
//! collapses each `jobs/<feature>_worker.rs` down to a config + the pass
//! function. (The image-pipeline worker keeps its own loop because it also
//! records per-run logs.)
//!
//! A pass also runs whenever the shared [`crate::offload::watch::TaskWatch`]
//! reports a tracked task changed, so a job that finishes well inside the tick
//! interval doesn't sit there until the next one — the interval becomes a
//! floor/backstop (covering local-only state, e.g. a job stuck before it ever
//! got an offload task id) rather than the only trigger.

use std::{future::Future, sync::Arc, time::Duration};

use crate::{error::AppError, state::AppState};

/// Floor on how often a `TaskWatch` event alone can trigger a pass. A tracked
/// task can emit several updates a second (streaming log deltas on a task this
/// worker doesn't even own — events are process-wide, not per-feature) —
/// running the batch query for every one would cost more DB load than the
/// fixed interval it supplements.
const EVENT_DEBOUNCE: Duration = Duration::from_millis(500);

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

/// Spawn a background task that runs `pass(state, batch_size)` on every tick,
/// and also whenever the watch connection signals a tracked task changed
/// (debounced — see [`EVENT_DEBOUNCE`]).
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
        let mut events = state.watch.subscribe();
        let mut last_run = tokio::time::Instant::now();

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = events.recv() => {
                    if last_run.elapsed() < EVENT_DEBOUNCE {
                        continue;
                    }
                }
            }
            last_run = tokio::time::Instant::now();
            if let Err(e) = pass(state.clone(), batch_size).await {
                tracing::warn!("{} worker pass failed: {e}", config.label);
            }
        }
    });
}
