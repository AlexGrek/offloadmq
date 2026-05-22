//! Single-task OffloadMQ poll for per-tool debug panels (client API only).

use serde::Deserialize;

use crate::{
    error::AppError,
    offload::TaskId,
    services::offload_factory,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct OffloadPollRequest {
    pub cap: String,
    pub id: String,
}

pub async fn poll_offload_task_raw(
    state: &AppState,
    cap: String,
    id: String,
) -> Result<serde_json::Value, AppError> {
    let client = offload_factory::chat_client(state).await?;
    client
        .poll_task_raw(&TaskId { cap, id })
        .await
}
