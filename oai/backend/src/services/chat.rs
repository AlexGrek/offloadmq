//! Chat orchestration behind the WebSocket. The `ws::chat` module owns the
//! socket transport (framing, ping/idle, dispatch); this module owns the
//! domain flow: capability listing, message persistence, task submission and
//! the background poll loop that streams results back over the channel.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::db::chats as db_chats;
use crate::error::AppError;
use crate::offload::{ChatMessage, LlmCapabilityInfo, OffloadClient, TaskId};
use crate::services::offload_factory;
use crate::state::AppState;
use crate::ws::events::ServerEvent;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_POLLS: u32 = 300; // 300 × 2s = 10 min hard deadline

/// Everything the poll loop needs to persist the assistant reply and address
/// events back to the originating request.
struct PollContext {
    req_id: String,
    cap: String,
    id: String,
    chat_id: i64,
    assistant_msg_id: i64,
    capability: String,
}

pub async fn list_capabilities(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    match load_capabilities(state).await {
        Ok(capabilities) => {
            let _ = tx.send(ServerEvent::Capabilities { req_id, capabilities });
        }
        Err(e) => send_error(tx, &req_id, &e.to_string()),
    }
}

async fn load_capabilities(state: &AppState) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    client.list_llm_capabilities().await
}

pub async fn chat(
    req_id: String,
    capability: String,
    chat_id_str: String,
    content: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    if let Err(message) = run_chat(&req_id, capability, chat_id_str, content, tx, state, user_id).await
    {
        send_error(tx, &req_id, &message);
    }
}

/// Persists the user message, submits the chat task, and spawns the poll loop.
/// Returns a user-facing error string; the caller relays it as a `ServerEvent`.
async fn run_chat(
    req_id: &str,
    capability: String,
    chat_id_str: String,
    content: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) -> Result<(), String> {
    let chat_id: i64 = chat_id_str.parse().map_err(|_| "invalid chat_id".to_string())?;

    let chat = db_chats::get_chat(&state.db, chat_id, user_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat not found".to_string())?;
    let history = db_chats::get_messages(&state.db, chat_id).await.map_err(|e| e.to_string())?;

    let user_msg_id = state.next_id();
    db_chats::add_message(&state.db, user_msg_id, chat_id, "user", &content, "complete", None)
        .await
        .map_err(|e| e.to_string())?;

    if chat.title.is_empty() {
        let title = content.chars().take(50).collect::<String>();
        let _ = db_chats::set_title(&state.db, chat_id, &title).await;
    } else {
        let _ = db_chats::touch_chat(&state.db, chat_id).await;
    }

    // Ollama-format history (completed turns only) + the new user message.
    let mut messages: Vec<ChatMessage> = history
        .iter()
        .filter(|m| m.status == "complete")
        .map(|m| ChatMessage { role: m.role.clone(), content: m.content.clone() })
        .collect();
    messages.push(ChatMessage { role: "user".to_string(), content });

    let client = offload_factory::chat_client(state).await.map_err(|e| e.to_string())?;
    let task_id = client.submit_chat(&capability, messages).await.map_err(|e| e.to_string())?;

    let assistant_msg_id = state.next_id();
    let _ = tx.send(ServerEvent::TaskQueued {
        req_id: req_id.to_string(),
        cap: task_id.cap.clone(),
        id: task_id.id.clone(),
    });
    let ctx = PollContext {
        req_id: req_id.to_string(),
        cap: task_id.cap.clone(),
        id: task_id.id.clone(),
        chat_id,
        assistant_msg_id,
        capability,
    };
    tokio::spawn(poll_loop(ctx, task_id, client, tx.clone(), state.clone()));
    Ok(())
}

async fn poll_loop(
    ctx: PollContext,
    task_id: TaskId,
    client: OffloadClient,
    tx: UnboundedSender<ServerEvent>,
    state: Arc<AppState>,
) {
    for _ in 0..MAX_POLLS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let resp = match client.poll_task(&task_id).await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(ServerEvent::Error {
                    req_id: Some(ctx.req_id.clone()),
                    message: e.to_string(),
                });
                return;
            }
        };

        match resp.status.as_str() {
            "completed" => {
                finish_success(&state, &tx, &ctx, extract_llm_text(&resp.output), resp.log).await;
                return;
            }
            "failed" => {
                finish_failure(&state, &tx, &ctx, extract_error_text(&resp.output), resp.log).await;
                return;
            }
            "canceled" => {
                finish_failure(&state, &tx, &ctx, "Task was canceled".to_string(), resp.log).await;
                return;
            }
            status => {
                let sent = tx.send(ServerEvent::TaskProgress {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    status: status.to_string(),
                    stage: resp.stage,
                    log: resp.log,
                });
                if sent.is_err() {
                    return; // receiver dropped — WS is gone
                }
            }
        }
    }

    finish_failure(&state, &tx, &ctx, "Task timed out waiting for result".to_string(), None).await;
}

/// Persists a successful assistant reply and notifies the client.
async fn finish_success(
    state: &AppState,
    tx: &UnboundedSender<ServerEvent>,
    ctx: &PollContext,
    text: String,
    log: Option<String>,
) {
    let _ = db_chats::add_message(
        &state.db,
        ctx.assistant_msg_id,
        ctx.chat_id,
        "assistant",
        &text,
        "complete",
        Some(&ctx.capability),
    )
    .await;
    let _ = db_chats::touch_chat(&state.db, ctx.chat_id).await;
    let _ = tx.send(ServerEvent::TaskResult {
        req_id: ctx.req_id.clone(),
        cap: ctx.cap.clone(),
        id: ctx.id.clone(),
        text,
        log,
    });
}

/// Persists a failed/canceled/timed-out assistant turn and notifies the client.
async fn finish_failure(
    state: &AppState,
    tx: &UnboundedSender<ServerEvent>,
    ctx: &PollContext,
    error: String,
    log: Option<String>,
) {
    let _ = db_chats::add_message(
        &state.db,
        ctx.assistant_msg_id,
        ctx.chat_id,
        "assistant",
        &error,
        "failed",
        Some(&ctx.capability),
    )
    .await;
    let _ = tx.send(ServerEvent::TaskFailed {
        req_id: ctx.req_id.clone(),
        cap: ctx.cap.clone(),
        id: ctx.id.clone(),
        error,
        log,
    });
}

fn send_error(tx: &UnboundedSender<ServerEvent>, req_id: &str, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: Some(req_id.to_string()),
        message: message.to_string(),
    });
}

fn extract_llm_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("response").and_then(|r| r.as_str()))
        .unwrap_or("")
        .to_string()
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("Unknown error")
        .to_string()
}
