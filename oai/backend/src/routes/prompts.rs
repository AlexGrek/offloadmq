use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{db::prompts, error::AppError, middleware::AuthenticatedUser, state::AppState};

#[derive(Serialize)]
pub struct PromptItem {
    pub id: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct PromptLibraryResponse {
    pub recent: Vec<PromptItem>,
    pub starred: Vec<PromptItem>,
}

#[derive(Deserialize)]
pub struct ContentRequest {
    pub content: String,
}

fn to_item(m: prompts::PromptEntry) -> PromptItem {
    PromptItem {
        id: m.id.to_string(),
        content: m.content,
    }
}

fn parse_id(id: &str) -> Result<i64, AppError> {
    id.parse().map_err(|_| AppError::BadRequest("invalid id".into()))
}

/// `GET /api/prompts/{bucket}` — recent + starred for one bucket.
pub async fn list_library(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
) -> Result<Json<PromptLibraryResponse>, AppError> {
    let (recent, starred) = prompts::list_library(&state.db, user_id, &bucket).await?;
    Ok(Json(PromptLibraryResponse {
        recent: recent.into_iter().map(to_item).collect(),
        starred: starred.into_iter().map(to_item).collect(),
    }))
}

/// `POST /api/prompts/{bucket}/star` — add the given content to favorites.
pub async fn star(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
    Json(req): Json<ContentRequest>,
) -> Result<Json<PromptItem>, AppError> {
    let row = prompts::add_starred(&state.db, || state.next_id(), user_id, &bucket, &req.content)
        .await?;
    Ok(Json(to_item(row)))
}

/// `PATCH /api/prompt-entries/{id}` — edit an owned entry (favorite).
pub async fn update_entry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
    Json(req): Json<ContentRequest>,
) -> Result<Json<PromptItem>, AppError> {
    let id = parse_id(&id)?;
    let row = prompts::update_content(&state.db, user_id, id, &req.content).await?;
    Ok(Json(to_item(row)))
}

/// `DELETE /api/prompt-entries/{id}` — remove an owned entry.
pub async fn delete_entry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id = parse_id(&id)?;
    prompts::delete_entry(&state.db, user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
