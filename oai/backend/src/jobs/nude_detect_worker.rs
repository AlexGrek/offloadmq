use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::nude_detect,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "nude detect",
            tick_env: "NUDE_DETECT_WORKER_TICK_SECS",
            batch_env: "NUDE_DETECT_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move {
            nude_detect::run_background_reconcile_pass(&state, batch).await
        },
    );
}
