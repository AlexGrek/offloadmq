use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use crate::{
    db::{chat_attachments, chats, prompts},
    error::AppError,
    middleware::AuthenticatedUser,
    services::chat_attachments as attachment_service,
    state::AppState,
};

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub title: String,
    pub system_prompt: String,
    pub last_model: Option<String>,
    /// `chat`, `prompt_studio` or `persona`.
    pub kind: String,
    /// Set for `persona` chats.
    pub persona_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreateChatRequest {
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub last_model: Option<String>,
    /// `chat` (default) or `prompt_studio`.
    #[serde(default)]
    pub kind: Option<String>,
    /// Optional session title. Without one the title is taken from the first message.
    #[serde(default)]
    pub title: Option<String>,
    /// Required for (and only valid with) `kind: "persona"`.
    #[serde(default)]
    pub persona_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ListChatsQuery {
    /// `chat` (default), `prompt_studio` or `persona`.
    #[serde(default)]
    pub kind: Option<String>,
    /// Narrows `kind=persona` to one persona's chats.
    #[serde(default)]
    pub persona_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    /// Model; defaults to the chat's last model, then (persona chats) the persona's LLM.
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// Queue wait before giving up (seconds); default 5 min.
    #[serde(default)]
    pub max_wait_secs: Option<u32>,
}

#[derive(Serialize)]
pub struct SendMessageResponse {
    pub chat_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub capability: String,
    pub cap: String,
    pub id: String,
}

fn parse_opt_id(value: Option<&str>, field: &str) -> Result<Option<i64>, AppError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Ok(Some(crate::routes::job_common::parse_id(v, field)?)),
        None => Ok(None),
    }
}

/// Persona chats show their persona's rendered prompt (the chat row stores none).
async fn chats_to_responses(
    state: &AppState,
    rows: Vec<chats::Chat>,
) -> Result<Vec<ChatResponse>, AppError> {
    let mut rendered: HashMap<i64, String> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for mut c in rows {
        if let Some(pid) = c.persona_id {
            if !rendered.contains_key(&pid) {
                let text = match crate::db::personas::get(&state.db, pid, c.user_id).await {
                    Ok(p) => crate::services::personas::rendered_system_prompt(&p),
                    Err(_) => String::new(),
                };
                rendered.insert(pid, text);
            }
            c.system_prompt = rendered[&pid].clone();
        }
        out.push(chat_to_response(c));
    }
    Ok(out)
}

/// Longest stored session title (chars).
const MAX_TITLE_CHARS: usize = 200;

fn parse_kind(kind: Option<&str>) -> Result<chats::ChatKind, AppError> {
    match kind.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => chats::ChatKind::parse(k),
        None => Ok(chats::ChatKind::Chat),
    }
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
    pub attachments: Vec<attachment_service::AttachmentDto>,
}

fn chat_to_response(c: chats::Chat) -> ChatResponse {
    ChatResponse {
        id: c.id.to_string(),
        title: c.title,
        system_prompt: c.system_prompt,
        last_model: c.last_model,
        kind: c.kind,
        persona_id: c.persona_id.map(|p| p.to_string()),
        created_at: c.created_at.to_rfc3339(),
        updated_at: c.updated_at.to_rfc3339(),
    }
}

fn message_to_response(
    m: chats::ChatMessage,
    attachments: Vec<attachment_service::AttachmentDto>,
) -> MessageResponse {
    MessageResponse {
        id: m.id.to_string(),
        role: m.role,
        content: m.content,
        status: m.status,
        model: m.model,
        created_at: m.created_at.to_rfc3339(),
        attachments,
    }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn list_chats(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Query(query): Query<ListChatsQuery>,
) -> Result<Json<Vec<ChatResponse>>, AppError> {
    let kind = parse_kind(query.kind.as_deref())?;
    let persona_id = parse_opt_id(query.persona_id.as_deref(), "persona_id")?;
    let chats = chats::list_chats(&state.db, user_id, kind, persona_id).await?;
    Ok(Json(chats_to_responses(&state, chats).await?))
}

pub async fn create_chat(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    body: Option<Json<CreateChatRequest>>,
) -> Result<impl IntoResponse, AppError> {
    let kind = parse_kind(body.as_ref().and_then(|b| b.kind.as_deref()))?;
    let persona_id = parse_opt_id(body.as_ref().and_then(|b| b.persona_id.as_deref()), "persona_id")?;
    if kind == chats::ChatKind::Persona {
        let Some(pid) = persona_id else {
            return Err(AppError::BadRequest("persona chats need persona_id".into()));
        };
        let persona = crate::db::personas::get(&state.db, pid, user_id).await?;
        let mut chat = chats::create_chat(&state.db, state.next_id(), user_id, "", kind, Some(pid)).await?;
        if let Some(title) = body.as_ref().and_then(|b| b.title.as_deref()).map(str::trim).filter(|t| !t.is_empty()) {
            let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
            chats::set_title(&state.db, chat.id, &title).await?;
            chat.title = title;
        }
        if let Some(cap) = body.as_ref().and_then(|b| b.last_model.as_deref()).map(str::trim).filter(|c| !c.is_empty()) {
            chat = chats::set_last_model(&state.db, chat.id, user_id, cap).await?;
        }
        chat.system_prompt = crate::services::personas::rendered_system_prompt(&persona);
        return Ok((StatusCode::CREATED, Json(chat_to_response(chat))));
    }
    if persona_id.is_some() {
        return Err(AppError::BadRequest("persona_id is only valid with kind=persona".into()));
    }
    let content = body
        .as_ref()
        .and_then(|b| b.system_prompt.as_deref())
        .unwrap_or("");
    let system_prompt = if content.trim().is_empty() {
        crate::db::prompt_defaults::get(&state.db, user_id)
            .await?
            .resolve(kind.default_prompt_app())
    } else {
        prompts::normalize_content(content)?
    };
    crate::services::prompt_usage::note_use(
        &state,
        user_id,
        kind.system_prompt_bucket(),
        &system_prompt,
    )
    .await;
    let id = state.next_id();
    let mut chat = chats::create_chat(&state.db, id, user_id, &system_prompt, kind, None).await?;
    let title: String = body
        .as_ref()
        .and_then(|b| b.title.as_deref())
        .map(str::trim)
        .unwrap_or("")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    if !title.is_empty() {
        chats::set_title(&state.db, id, &title).await?;
        chat.title = title;
    }
    let chat = if let Some(model) = body.as_ref().and_then(|b| b.last_model.as_ref()) {
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
    let system_prompt = prompts::normalize_content(&req.content)?;
    if chats::get_chat(&state.db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?
        .persona_id
        .is_some()
    {
        return Err(AppError::BadRequest(
            "a persona chat uses its persona's system prompt; edit the persona instead".into(),
        ));
    }
    let chat = chats::set_system_prompt(&state.db, id, user_id, &system_prompt).await?;
    let bucket = chats::ChatKind::from_stored(&chat.kind).system_prompt_bucket();
    crate::services::prompt_usage::note_use(&state, user_id, bucket, &system_prompt).await;
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

    let message_ids: Vec<i64> = msgs.iter().map(|m| m.id).collect();
    let attachments = chat_attachments::list_for_messages(&state.db, &message_ids).await?;
    let mut by_message: HashMap<i64, Vec<attachment_service::AttachmentDto>> = HashMap::new();
    for att in &attachments {
        if let Some(mid) = att.message_id {
            by_message
                .entry(mid)
                .or_default()
                .push(attachment_service::to_dto(att));
        }
    }

    let out = msgs
        .into_iter()
        .map(|m| {
            let atts = by_message.remove(&m.id).unwrap_or_default();
            message_to_response(m, atts)
        })
        .collect();
    Ok(Json(out))
}

/// REST chat turn (CLI, MCP, scripts): submits like the WebSocket `chat` command
/// and returns at once; poll `GET /api/chats/{id}/messages/{assistant_message_id}`.
pub async fn send_message(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(chat_id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, AppError> {
    let chat_id = crate::routes::job_common::parse_id(&chat_id, "chat_id")?;
    let attachment_ids = req
        .attachment_ids
        .iter()
        .map(|a| crate::routes::job_common::parse_id(a, "attachment_ids"))
        .collect::<Result<Vec<_>, _>>()?;
    let turn = crate::services::chat::submit_turn(
        &state,
        user_id,
        crate::services::chat::TurnRequest {
            capability: req.capability,
            chat_id,
            content: req.content,
            attachment_ids,
            model_online: true,
            timeout_secs: None,
            max_wait_secs: req.max_wait_secs,
            runtime_secs: None,
        },
    )
    .await?;
    let resp = SendMessageResponse {
        chat_id: turn.chat_id.to_string(),
        user_message_id: turn.user_message_id.to_string(),
        assistant_message_id: turn.assistant_message_id.to_string(),
        capability: turn.capability.clone(),
        cap: turn.task_id.cap.clone(),
        id: turn.task_id.id.clone(),
    };
    // No socket to stream to: the loop still finalizes the row promptly.
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    crate::services::chat::spawn_poll_loop(&state, turn, String::new(), tx);
    Ok((StatusCode::CREATED, Json(resp)))
}

/// One message; a pending assistant reply is reconciled upstream first.
pub async fn get_message(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path((chat_id, message_id)): Path<(String, String)>,
) -> Result<Json<MessageResponse>, AppError> {
    let chat_id = crate::routes::job_common::parse_id(&chat_id, "chat_id")?;
    let message_id = crate::routes::job_common::parse_id(&message_id, "message_id")?;
    let msg =
        crate::services::chat::get_message_reconciled(&state, user_id, chat_id, message_id).await?;
    let attachments = chat_attachments::list_for_messages(&state.db, &[msg.id])
        .await?
        .iter()
        .map(attachment_service::to_dto)
        .collect();
    Ok(Json(message_to_response(msg, attachments)))
}
