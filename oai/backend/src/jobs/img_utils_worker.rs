use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::img_utils,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "img_utils",
            tick_env: "IMG_UTILS_WORKER_TICK_SECS",
            batch_env: "IMG_UTILS_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { img_utils::run_background_reconcile_pass(&state, batch).await },
    );
}
