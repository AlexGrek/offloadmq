use std::{sync::Arc, time::Duration};

use crate::{db::image_worker_logs, state::AppState};

const DEFAULT_TICK_SECS: u64 = 20;
const DEFAULT_BATCH_SIZE: u64 = 20;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let tick_secs = std::env::var("IMAGE_PIPELINE_WORKER_TICK_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TICK_SECS);
        let batch_size = std::env::var("IMAGE_PIPELINE_WORKER_BATCH_SIZE")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_BATCH_SIZE);

        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let run_id = format!("run_{}", state.next_id());
            let started = chrono::Utc::now();
            let started_s = started.to_rfc3339();
            let mut status = "ok".to_string();
            let mut error: Option<String> = None;
            if let Err(e) = crate::routes::images::run_background_reconcile_pass(&state, batch_size).await {
                tracing::warn!("image pipeline worker pass failed: {e}");
                status = "error".to_string();
                error = Some(e.to_string());
            }
            let finished = chrono::Utc::now();
            let payload = serde_json::json!({
                "component": "image_pipeline_worker",
                "tick_secs": tick_secs,
                "batch_size": batch_size,
                "started_at": started_s,
                "finished_at": finished.to_rfc3339(),
                "duration_ms": (finished - started).num_milliseconds(),
                "status": status,
                "error": error,
            });
            let _ = image_worker_logs::create(
                &state.db,
                state.next_id(),
                &run_id,
                if status == "ok" { "info" } else { "error" },
                "image pipeline worker pass",
                &payload.to_string(),
            )
            .await;
        }
    });
}
