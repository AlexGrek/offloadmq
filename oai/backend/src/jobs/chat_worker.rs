//! Background reconciler for in-flight chat replies. On each tick it advances
//! every `status="pending"` assistant message by polling its offload task and
//! persisting the result — this is what makes chat stateless: replies finish even
//! if the user disconnects or the pod restarts.

use std::sync::Arc;

use crate::{
    jobs::worker_runtime::{self, WorkerConfig},
    services::chat,
    state::AppState,
};

pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "chat",
            tick_env: "CHAT_WORKER_TICK_SECS",
            batch_env: "CHAT_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { chat::run_background_reconcile_pass(&state, batch).await },
    );
}
