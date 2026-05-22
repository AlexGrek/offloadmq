//! Chat orchestration behind the WebSocket. The `ws::chat` module owns the
//! socket transport (framing, ping/idle, dispatch); this module owns the
//! domain flow: capability listing, message persistence, task submission and
//! the background poll loop that streams results back over the channel.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::db::chats as db_chats;
use crate::offload::{ChatMessage, OffloadClient, TaskId};
use crate::services::offload_factory;
use crate::state::AppState;
use crate::ws::events::ServerEvent;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_POLLS: u32 = 300; // 300 × 2s = 10 min hard deadline

pub async fn list_capabilities(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    let client = match offload_factory::chat_client(state).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
            return;
        }
    };
    match client.list_llm_capabilities().await {
        Ok(caps) => {
            let _ = tx.send(ServerEvent::Capabilities { req_id, capabilities: caps });
        }
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
        }
    }
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
    let chat_id: i64 = match chat_id_str.parse() {
        Ok(v) => v,
        Err(_) => {
            send_error(tx, &req_id, "invalid chat_id");
            return;
        }
    };

    // Verify ownership and load history.
    let chat = match db_chats::get_chat(&state.db, chat_id, user_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            send_error(tx, &req_id, "chat not found");
            return;
        }
        Err(e) => {
            send_error(tx, &req_id, &e.to_string());
            return;
        }
    };

    let history = match db_chats::get_messages(&state.db, chat_id).await {
        Ok(msgs) => msgs,
        Err(e) => {
            send_error(tx, &req_id, &e.to_string());
            return;
        }
    };

    // Persist user message now.
    let user_msg_id = state.next_id();
    if let Err(e) =
        db_chats::add_message(&state.db, user_msg_id, chat_id, "user", &content, "complete", None)
            .await
    {
        send_error(tx, &req_id, &e.to_string());
        return;
    }

    // Auto-title chat on first message.
    if chat.title.is_empty() {
        let title = content.chars().take(50).collect::<String>();
        let _ = db_chats::set_title(&state.db, chat_id, &title).await;
    } else {
        let _ = db_chats::touch_chat(&state.db, chat_id).await;
    }

    // Build Ollama-format messages from history + new user message.
    let mut messages: Vec<ChatMessage> = history
        .iter()
        .filter(|m| m.status == "complete")
        .map(|m| ChatMessage { role: m.role.clone(), content: m.content.clone() })
        .collect();
    messages.push(ChatMessage { role: "user".to_string(), content: content.clone() });

    let client = match offload_factory::chat_client(state).await {
        Ok(c) => c,
        Err(e) => {
            send_error(tx, &req_id, &e.to_string());
            return;
        }
    };

    match client.submit_chat(&capability, messages).await {
        Ok(task_id) => {
            // Allocate assistant message id now so poll_loop can fill it in.
            let assistant_msg_id = state.next_id();
            let _ = tx.send(ServerEvent::TaskQueued {
                req_id: req_id.clone(),
                cap: task_id.cap.clone(),
                id: task_id.id.clone(),
            });
            tokio::spawn(poll_loop(
                req_id,
                task_id,
                client,
                tx.clone(),
                state.clone(),
                chat_id,
                assistant_msg_id,
                capability,
            ));
        }
        Err(e) => {
            send_error(tx, &req_id, &e.to_string());
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn poll_loop(
    req_id: String,
    task_id: TaskId,
    client: OffloadClient,
    tx: UnboundedSender<ServerEvent>,
    state: Arc<AppState>,
    chat_id: i64,
    assistant_msg_id: i64,
    capability: String,
) {
    for _ in 0..MAX_POLLS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let resp = match client.poll_task(&task_id).await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(ServerEvent::Error {
                    req_id: Some(req_id),
                    message: e.to_string(),
                });
                return;
            }
        };

        match resp.status.as_str() {
            "completed" => {
                let text = extract_llm_text(&resp.output);
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    &text,
                    "complete",
                    Some(&capability),
                )
                .await;
                let _ = db_chats::touch_chat(&state.db, chat_id).await;
                let _ = tx.send(ServerEvent::TaskResult {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    text,
                    log: resp.log,
                });
                return;
            }
            "failed" => {
                let error = extract_error_text(&resp.output);
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    &error,
                    "failed",
                    Some(&capability),
                )
                .await;
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    error,
                    log: resp.log,
                });
                return;
            }
            "canceled" => {
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    "Task was canceled",
                    "failed",
                    Some(&capability),
                )
                .await;
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    error: "Task was canceled".to_string(),
                    log: resp.log,
                });
                return;
            }
            status => {
                if tx
                    .send(ServerEvent::TaskProgress {
                        req_id: req_id.clone(),
                        cap: task_id.cap.clone(),
                        id: task_id.id.clone(),
                        status: status.to_string(),
                        stage: resp.stage,
                        log: resp.log,
                    })
                    .is_err()
                {
                    return; // receiver dropped — WS is gone
                }
            }
        }
    }

    // Deadline exceeded.
    let _ = db_chats::add_message(
        &state.db,
        assistant_msg_id,
        chat_id,
        "assistant",
        "Task timed out waiting for result",
        "failed",
        Some(&capability),
    )
    .await;
    let _ = tx.send(ServerEvent::TaskFailed {
        req_id,
        cap: task_id.cap,
        id: task_id.id,
        error: "Task timed out waiting for result".to_string(),
        log: None,
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
