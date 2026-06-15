use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::llm_debate,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "llm-debate",
            tick_env: "LLM_DEBATE_WORKER_TICK_SECS",
            batch_env: "LLM_DEBATE_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { llm_debate::run_background_reconcile_pass(&state, batch).await },
    );
}
