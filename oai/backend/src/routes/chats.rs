use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Serialize;

use crate::{db::chats, error::AppError, middleware::AuthenticatedUser, state::AppState};

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub role: String,
    pub content: String,
    pub status: String,
    pub model: Option<String>,
    pub created_at: String,
}

fn chat_to_response(c: chats::Chat) -> ChatResponse {
    ChatResponse {
        id: c.id.to_string(),
        title: c.title,
        created_at: c.created_at.to_rfc3339(),
        updated_at: c.updated_at.to_rfc3339(),
    }
}

fn message_to_response(m: chats::ChatMessage) -> MessageResponse {
    MessageResponse {
        id: m.id.to_string(),
        role: m.role,
        content: m.content,
        status: m.status,
        model: m.model,
        created_at: m.created_at.to_rfc3339(),
    }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn list_chats(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<ChatResponse>>, AppError> {
    let chats = chats::list_chats(&state.db, user_id).await?;
    Ok(Json(chats.into_iter().map(chat_to_response).collect()))
}

pub async fn create_chat(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<impl IntoResponse, AppError> {
    let id = state.next_id();
    let chat = chats::create_chat(&state.db, id, user_id).await?;
    Ok((StatusCode::CREATED, Json(chat_to_response(chat))))
}

pub async fn delete_chat(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(chat_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id: i64 = chat_id.parse().map_err(|_| AppError::BadRequest("invalid chat id".into()))?;
    chats::delete_chat(&state.db, id, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_messages(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(chat_id): Path<String>,
) -> Result<Json<Vec<MessageResponse>>, AppError> {
    let id: i64 = chat_id.parse().map_err(|_| AppError::BadRequest("invalid chat id".into()))?;
    // Verify ownership
    chats::get_chat(&state.db, id, user_id).await?.ok_or(AppError::NotFound)?;
    let msgs = chats::get_messages(&state.db, id).await?;
    Ok(Json(msgs.into_iter().map(message_to_response).collect()))
}
