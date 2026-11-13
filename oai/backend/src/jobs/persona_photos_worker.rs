use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::persona_photos,
    state::AppState,
};
use std::sync::Arc;

/// Advances persona photo chains from their children's persisted state (the
/// children themselves are driven by the image pipeline / img-utils workers).
pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "persona photos",
            tick_env: "PERSONA_PHOTOS_WORKER_TICK_SECS",
            batch_env: "PERSONA_PHOTOS_WORKER_BATCH_SIZE",
            default_tick_secs: 3,
            default_batch_size: 20,
        },
        |state, batch| async move { persona_photos::reconcile(&state, batch).await },
    );
}
