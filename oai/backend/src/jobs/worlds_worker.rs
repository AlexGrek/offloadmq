use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::worlds,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "worlds",
            tick_env: "WORLDS_WORKER_TICK_SECS",
            batch_env: "WORLDS_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { worlds::run_background_reconcile_pass(&state, batch).await },
    );
}
