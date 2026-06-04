use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::image_analysis,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "image analysis",
            tick_env: "IMAGE_ANALYSIS_WORKER_TICK_SECS",
            batch_env: "IMAGE_ANALYSIS_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move {
            image_analysis::run_background_reconcile_pass(&state, batch).await
        },
    );
}
