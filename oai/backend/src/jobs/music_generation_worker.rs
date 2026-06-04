use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::music_generation,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "music_gen",
            tick_env: "MUSIC_GEN_WORKER_TICK_SECS",
            batch_env: "MUSIC_GEN_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move {
            music_generation::run_background_reconcile_pass(&state, batch).await
        },
    );
}
