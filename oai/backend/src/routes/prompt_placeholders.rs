use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{db::prompt_placeholders, error::AppError, middleware::AuthenticatedUser, state::AppState};

#[derive(Serialize)]
pub struct PromptPlaceholderItem {
    pub id: String,
    pub name: String,
    pub variants: Vec<String>,
}

#[derive(Deserialize)]
pub struct PlaceholderRequest {
    pub name: String,
    pub variants: Vec<String>,
}

fn to_item(m: prompt_placeholders::Placeholder) -> Result<PromptPlaceholderItem, AppError> {
    let variants = prompt_placeholders::decode_variants(&m)?;
    Ok(PromptPlaceholderItem {
        id: m.id.to_string(),
        name: m.name,
        variants,
    })
}

fn parse_id(id: &str) -> Result<i64, AppError> {
    id.parse().map_err(|_| AppError::BadRequest("invalid id".into()))
}

/// `GET /api/prompt-placeholders` — the caller's custom placeholders.
pub async fn list_placeholders(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<PromptPlaceholderItem>>, AppError> {
    let rows = prompt_placeholders::list_for_user(&state.db, user_id).await?;
    let items: Result<Vec<_>, _> = rows.into_iter().map(to_item).collect();
    Ok(Json(items?))
}

/// `POST /api/prompt-placeholders` — create a new custom placeholder.
pub async fn create_placeholder(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<PlaceholderRequest>,
) -> Result<Json<PromptPlaceholderItem>, AppError> {
    let row = prompt_placeholders::create(
        &state.db,
        || state.next_id(),
        user_id,
        &req.name,
        req.variants,
    )
    .await?;
    Ok(Json(to_item(row)?))
}

/// `PATCH /api/prompt-placeholders/{id}` — edit an owned custom placeholder.
pub async fn update_placeholder(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
    Json(req): Json<PlaceholderRequest>,
) -> Result<Json<PromptPlaceholderItem>, AppError> {
    let id = parse_id(&id)?;
    let row = prompt_placeholders::update(&state.db, user_id, id, &req.name, req.variants).await?;
    Ok(Json(to_item(row)?))
}

/// `DELETE /api/prompt-placeholders/{id}` — remove an owned custom placeholder.
pub async fn delete_placeholder(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id = parse_id(&id)?;
    prompt_placeholders::delete(&state.db, user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
