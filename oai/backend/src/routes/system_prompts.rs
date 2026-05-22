use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::user_system_prompts,
    error::AppError,
    middleware::AuthenticatedUser,
    state::AppState,
};

#[derive(Serialize)]
pub struct SystemPromptItem {
    pub id: String,
    pub content: String,
    pub starred: bool,
    pub last_used_at: String,
}

#[derive(Serialize)]
pub struct SystemPromptLibraryResponse {
    pub recent: Vec<SystemPromptItem>,
    pub starred: Vec<SystemPromptItem>,
}

#[derive(Deserialize)]
pub struct RecordUseRequest {
    pub content: String,
}

#[derive(Deserialize)]
pub struct SetStarredRequest {
    pub starred: bool,
}

fn to_item(m: user_system_prompts::UserSystemPrompt) -> SystemPromptItem {
    SystemPromptItem {
        id: m.id.to_string(),
        content: m.content,
        starred: m.starred,
        last_used_at: m.last_used_at.to_rfc3339(),
    }
}

pub async fn list_library(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<SystemPromptLibraryResponse>, AppError> {
    let (recent, starred) = user_system_prompts::list_library(&state.db, user_id).await?;
    Ok(Json(SystemPromptLibraryResponse {
        recent: recent.into_iter().map(to_item).collect(),
        starred: starred.into_iter().map(to_item).collect(),
    }))
}

pub async fn record_use(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<RecordUseRequest>,
) -> Result<Json<SystemPromptItem>, AppError> {
    let row = user_system_prompts::record_use(&state.db, || state.next_id(), user_id, &req.content)
        .await?;
    Ok(Json(to_item(row)))
}

pub async fn set_starred(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
    Json(req): Json<SetStarredRequest>,
) -> Result<Json<SystemPromptItem>, AppError> {
    let id: i64 = id.parse().map_err(|_| AppError::BadRequest("invalid id".into()))?;
    let row = user_system_prompts::set_starred(&state.db, user_id, id, req.starred).await?;
    Ok(Json(to_item(row)))
}

pub async fn delete_prompt(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id: i64 = id.parse().map_err(|_| AppError::BadRequest("invalid id".into()))?;
    user_system_prompts::delete_prompt(&state.db, user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
