use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::llm_compare,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "llm-compare",
            tick_env: "LLM_COMPARE_WORKER_TICK_SECS",
            batch_env: "LLM_COMPARE_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { llm_compare::run_background_reconcile_pass(&state, batch).await },
    );
}
