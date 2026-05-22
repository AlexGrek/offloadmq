//! Chat orchestration behind the WebSocket. The `ws::chat` module owns the
//! socket transport (framing, ping/idle, dispatch); this module owns the
//! domain flow: capability listing, message persistence, task submission and
//! the background poll loop that streams results back over the channel.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::db::chats as db_chats;
use crate::db::llm_capabilities;
use crate::error::AppError;
use crate::offload::{ChatMessage, LlmCapabilityInfo, OffloadClient, TaskId};
use crate::services::offload_factory;
use crate::state::AppState;
use crate::ws::events::ServerEvent;

/// Agent flushes streaming log to OffloadMQ about every 2s; poll slightly faster.
const POLL_INTERVAL: Duration = Duration::from_secs(1);
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
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    llm_capabilities::list_for_display(&state.db, &online_bases).await
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
    let user_msg_id = state.next_id();
    db_chats::add_message(
        &state.db,
        user_msg_id,
        chat_id,
        "user",
        &content,
        "complete",
        Some(&capability),
    )
    .await
    .map_err(|e| e.to_string())?;
    let _ = db_chats::set_last_model(&state.db, chat_id, user_id, &capability)
        .await
        .map_err(|e| e.to_string())?;

    if chat.title.is_empty() {
        let title = content.chars().take(50).collect::<String>();
        let _ = db_chats::set_title(&state.db, chat_id, &title).await;
    } else {
        let _ = db_chats::touch_chat(&state.db, chat_id).await;
    }

    // Full persisted thread (including the message we just saved), chronological.
    let stored = db_chats::get_messages(&state.db, chat_id).await.map_err(|e| e.to_string())?;
    let messages = build_offload_chat_messages(&chat.system_prompt, &stored);
    if messages.is_empty() {
        return Err("no messages to send".to_string());
    }
    tracing::debug!(
        chat_id,
        offload_message_count = messages.len(),
        "submitting chat task with full history"
    );

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
    for i in 0..MAX_POLLS {
        if i > 0 {
            tokio::time::sleep(POLL_INTERVAL).await;
        }

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
            "cancelRequested" => {
                let stream_log = progress_stream_text(&resp);
                let sent = tx.send(ServerEvent::TaskProgress {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    status: "cancelRequested".to_string(),
                    stage: resp.stage.clone(),
                    log: stream_log,
                });
                if sent.is_err() {
                    return;
                }
            }
            status => {
                let stream_log = progress_stream_text(&resp);
                let sent = tx.send(ServerEvent::TaskProgress {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    status: status.to_string(),
                    stage: resp.stage,
                    log: stream_log,
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

/// Ollama-style message list: optional system prompt, then user + assistant turns.
fn build_offload_chat_messages(
    system_prompt: &str,
    records: &[db_chats::ChatMessage],
) -> Vec<ChatMessage> {
    let mut out = Vec::new();
    let sys = system_prompt.trim();
    if !sys.is_empty() {
        out.push(ChatMessage {
            role: "system".to_string(),
            content: sys.to_string(),
        });
    }
    out.extend(
        records
        .iter()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant"))
        .filter(|m| !m.content.trim().is_empty())
        .filter(|m| match m.role.as_str() {
            "user" => m.status == "complete",
            // Include failed replies so the model still sees the full thread.
            "assistant" => matches!(m.status.as_str(), "complete" | "failed"),
            _ => false,
        })
        .map(|m| ChatMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        }),
    );
    out
}

/// Text to show while the task is still running: accumulated agent log, else partial output.
fn progress_stream_text(resp: &crate::offload::PollResponse) -> Option<String> {
    if let Some(log) = resp.log.as_ref() {
        if !log.is_empty() {
            return Some(log.clone());
        }
    }
    let partial = extract_llm_text(&resp.output);
    if partial.is_empty() {
        None
    } else {
        Some(partial)
    }
}

fn extract_llm_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(extract_llm_text_from_value)
        .unwrap_or_default()
        .to_string()
}

/// Matches offload-agent Ollama output and management-frontend `extractSandboxModelText`.
fn extract_llm_text_from_value(v: &serde_json::Value) -> Option<&str> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            v.get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c0| c0.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| v.get("response").and_then(|r| r.as_str()).filter(|s| !s.is_empty()))
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("Unknown error")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_llm_text_ollama_message_content() {
        let output = serde_json::json!({
            "model": "qwen3:8b",
            "message": { "role": "assistant", "content": "Hello from Ollama" },
            "done": true
        });
        assert_eq!(extract_llm_text(&Some(output)), "Hello from Ollama");
    }

    #[test]
    fn extract_llm_text_legacy_response_field() {
        let output = serde_json::json!({ "response": "legacy text", "done": true });
        assert_eq!(extract_llm_text(&Some(output)), "legacy text");
    }

    #[test]
    fn extract_llm_text_missing_returns_empty() {
        assert_eq!(extract_llm_text(&None), "");
        assert_eq!(extract_llm_text(&Some(serde_json::json!({ "done": true }))), "");
    }

    #[test]
    fn build_offload_chat_messages_full_thread() {
        let records = vec![
            db_chats::ChatMessage {
                id: 1,
                chat_id: 1,
                role: "user".to_string(),
                content: "hi".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "assistant".to_string(),
                content: "hello".to_string(),
                status: "complete".to_string(),
                model: Some("llm.qwen".to_string()),
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "again".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
        ];
        let msgs = build_offload_chat_messages("Be concise.", &records);
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].content, "hi");
        assert_eq!(msgs[2].content, "hello");
        assert_eq!(msgs[3].content, "again");
    }

    #[test]
    fn build_offload_chat_messages_includes_failed_assistant() {
        let records = vec![
            db_chats::ChatMessage {
                id: 1,
                chat_id: 1,
                role: "user".to_string(),
                content: "q".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "assistant".to_string(),
                content: "⚠ timeout".to_string(),
                status: "failed".to_string(),
                model: Some("llm.qwen".to_string()),
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "retry".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
        ];
        let msgs = build_offload_chat_messages("", &records);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "⚠ timeout");
    }

    #[test]
    fn build_offload_chat_messages_skips_empty_and_non_dialog_roles() {
        let records = vec![
            db_chats::ChatMessage {
                id: 1,
                chat_id: 1,
                role: "system".to_string(),
                content: "you are helpful".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "user".to_string(),
                content: "   ".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "ok".to_string(),
                status: "complete".to_string(),
                model: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
        ];
        let msgs = build_offload_chat_messages("From chat column.", &records);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[0].content, "From chat column.");
        assert_eq!(msgs[1].content, "ok");
    }

    #[test]
    fn progress_stream_text_prefers_log() {
        let resp = crate::offload::PollResponse {
            status: "running".to_string(),
            stage: Some("running".to_string()),
            output: None,
            log: Some("partial tokens".to_string()),
        };
        assert_eq!(progress_stream_text(&resp).as_deref(), Some("partial tokens"));
    }

    #[test]
    fn progress_stream_text_falls_back_to_output() {
        let resp = crate::offload::PollResponse {
            status: "running".to_string(),
            stage: None,
            output: Some(serde_json::json!({
                "message": { "role": "assistant", "content": "hi" }
            })),
            log: None,
        };
        assert_eq!(progress_stream_text(&resp).as_deref(), Some("hi"));
    }
}
