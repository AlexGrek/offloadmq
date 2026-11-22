use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::bg_remover,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "bg_remover",
            tick_env: "BG_REMOVER_WORKER_TICK_SECS",
            batch_env: "BG_REMOVER_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { bg_remover::run_background_reconcile_pass(&state, batch).await },
    );
}
