use std::sync::Arc;

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    offload::TaskId,
    services::offload_factory,
    state::AppState,
};

#[derive(Serialize)]
pub struct CancelTaskApiResponse {
    pub cap: String,
    pub id: String,
    pub status: String,
    pub message: String,
}

/// Proxies `POST /api/task/cancel/{cap}/{id}` on the configured OffloadMQ server.
pub async fn cancel_offload_task(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_user_id): AuthenticatedUser,
    Path((cap, id)): Path<(String, String)>,
) -> Result<Json<CancelTaskApiResponse>, AppError> {
    let client = offload_factory::chat_client(&state).await?;
    let resp = client.cancel_task(&TaskId { cap, id }).await?;
    Ok(Json(CancelTaskApiResponse {
        cap: resp.id.cap,
        id: resp.id.id,
        status: resp.status,
        message: resp.message,
    }))
}
