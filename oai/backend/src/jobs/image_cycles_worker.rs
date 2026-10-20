use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::image_cycles,
    state::AppState,
};
use std::sync::Arc;
pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "image cycles",
            tick_env: "IMAGE_CYCLES_WORKER_TICK_SECS",
            batch_env: "IMAGE_CYCLES_WORKER_BATCH_SIZE",
            default_tick_secs: 3,
            default_batch_size: 20,
        },
        |state, batch| async move { image_cycles::reconcile(&state, batch).await },
    );
}
