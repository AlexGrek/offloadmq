use std::{sync::Arc, time::Duration};

use crate::{services::image_analysis, state::AppState};

const DEFAULT_TICK_SECS: u64 = 10;
const DEFAULT_BATCH_SIZE: u64 = 20;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let tick_secs = std::env::var("IMAGE_ANALYSIS_WORKER_TICK_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TICK_SECS);
        let batch_size = std::env::var("IMAGE_ANALYSIS_WORKER_BATCH_SIZE")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_BATCH_SIZE);

        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
        ticker.tick().await;

        loop {
            ticker.tick().await;
            if let Err(e) =
                image_analysis::run_background_reconcile_pass(&state, batch_size).await
            {
                tracing::warn!("image analysis worker pass failed: {e}");
            }
        }
    });
}
