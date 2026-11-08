//! `/api/images/stash` — stashed image-generation requests (`services::image_stash`).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::Value;

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{parse_id, StartJobResponse},
    services::image_stash::{self, StashEntryView},
    state::AppState,
};

pub async fn list(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<StashEntryView>>, AppError> {
    Ok(Json(image_stash::list(&state, user_id).await?))
}

/// Body: the same JSON as `POST /api/images/jobs`.
pub async fn create(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(request): Json<Value>,
) -> Result<impl IntoResponse, AppError> {
    let entry = image_stash::stash(&state, user_id, request).await?;
    Ok((StatusCode::CREATED, Json(entry)))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    image_stash::delete(&state, user_id, parse_id(&id, "id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = image_stash::start(&state, user_id, parse_id(&id, "id")?).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(job_id)),
    ))
}
