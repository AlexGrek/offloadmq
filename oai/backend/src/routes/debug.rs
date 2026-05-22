use std::sync::Arc;

use axum::{
    extract::State,
    Json,
};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::debug_offload::{self, OffloadPollRequest},
    state::AppState,
};

pub async fn offload_poll(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<OffloadPollRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let body = debug_offload::poll_offload_task_raw(&state, req.cap, req.id).await?;
    Ok(Json(body))
}
