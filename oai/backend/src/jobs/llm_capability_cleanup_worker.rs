use std::{sync::Arc, time::Duration};

use crate::{db::llm_capabilities, state::AppState};

const DEFAULT_TICK_SECS: u64 = 3600;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let tick_secs = std::env::var("LLM_CAPABILITY_CLEANUP_TICK_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TICK_SECS);

        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
        ticker.tick().await;

        loop {
            ticker.tick().await;
            match llm_capabilities::delete_stale(&state.db).await {
                Ok(n) if n > 0 => {
                    tracing::info!("llm capability cleanup removed {n} stale model(s)");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("llm capability cleanup failed: {e}"),
            }
        }
    });
}
