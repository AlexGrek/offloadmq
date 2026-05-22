use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{chats, user_system_prompts},
    error::AppError,
    middleware::AuthenticatedUser,
    state::AppState,
};

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub title: String,
    pub system_prompt: String,
    pub last_model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreateChatRequest {
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub last_model: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateLastModelRequest {
    pub capability: String,
}

#[derive(Deserialize)]
pub struct UpdateSystemPromptRequest {
    pub content: String,
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
        system_prompt: c.system_prompt,
        last_model: c.last_model,
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
    body: Option<Json<CreateChatRequest>>,
) -> Result<impl IntoResponse, AppError> {
    let content = body
        .as_ref()
        .and_then(|b| b.system_prompt.as_deref())
        .unwrap_or("");
    let system_prompt = if content.trim().is_empty() {
        "You are a helpful AI assistant.".to_string()
    } else {
        user_system_prompts::normalize_content(content)?
    };
    let _ = user_system_prompts::record_use(&state.db, || state.next_id(), user_id, &system_prompt).await?;
    let id = state.next_id();
    let chat = chats::create_chat(&state.db, id, user_id, &system_prompt).await?;
    let chat = if let Some(ref model) = body.as_ref().and_then(|b| b.last_model.as_ref()) {
        let cap = model.trim();
        if cap.is_empty() {
            chat
        } else {
            chats::set_last_model(&state.db, id, user_id, cap).await?
        }
    } else {
        chat
    };
    Ok((StatusCode::CREATED, Json(chat_to_response(chat))))
}

pub async fn update_last_model(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(chat_id): Path<String>,
    Json(req): Json<UpdateLastModelRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    let id: i64 = chat_id.parse().map_err(|_| AppError::BadRequest("invalid chat id".into()))?;
    let cap = req.capability.trim();
    if cap.is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }
    let chat = chats::set_last_model(&state.db, id, user_id, cap).await?;
    Ok(Json(chat_to_response(chat)))
}

pub async fn update_system_prompt(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(chat_id): Path<String>,
    Json(req): Json<UpdateSystemPromptRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    let id: i64 = chat_id.parse().map_err(|_| AppError::BadRequest("invalid chat id".into()))?;
    let system_prompt = user_system_prompts::normalize_content(&req.content)?;
    let _ = user_system_prompts::record_use(&state.db, || state.next_id(), user_id, &system_prompt).await?;
    let chat = chats::set_system_prompt(&state.db, id, user_id, &system_prompt).await?;
    Ok(Json(chat_to_response(chat)))
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
