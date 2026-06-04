//! Chat orchestration behind the WebSocket. The `ws::chat` module owns the
//! socket transport (framing, ping/idle, dispatch); this module owns the
//! domain flow: capability listing, message persistence, task submission and
//! the background poll loop that streams results back over the channel.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::db;
use crate::db::chats as db_chats;
use crate::db::llm_capabilities;
use crate::error::AppError;
use crate::offload::{task_status, ChatMessage, LlmCapabilityInfo, OffloadClient, TaskId};
use crate::services::chat_attachments;
use crate::services::offload_factory;
use crate::state::AppState;
use crate::ws::events::ServerEvent;

/// Agent flushes streaming log to OffloadMQ about every 2s; poll slightly faster.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

const DEFAULT_MAX_WAIT_SECS_ONLINE: u32 = 5 * 60;       // 5 min — model is up, don't queue forever
const DEFAULT_MAX_WAIT_SECS_OFFLINE: u32 = 24 * 3600;   // 24 h — model offline, wait for it to come back
const DEFAULT_RUNTIME_SECS: u32 = 15 * 60;              // 15 min

/// Apply per-chat defaults when the user left a field unset, then derive a poll
/// deadline the loop will honour.  Returns `None` only when every value is still
/// unset after applying defaults (shouldn't happen given the constants above).
fn resolve_timeouts(
    model_online: bool,
    timeout_secs: Option<u32>,
    max_wait_secs: Option<u32>,
    runtime_secs: Option<u32>,
) -> (Option<u32>, Option<u32>, Option<u32>, Option<u64>) {
    let wait = Some(max_wait_secs.unwrap_or(if model_online {
        DEFAULT_MAX_WAIT_SECS_ONLINE
    } else {
        DEFAULT_MAX_WAIT_SECS_OFFLINE
    }));
    let runtime = Some(runtime_secs.unwrap_or(DEFAULT_RUNTIME_SECS));

    let deadline = if let Some(t) = timeout_secs {
        Some(t as u64)
    } else {
        Some(wait.unwrap() as u64 + runtime.unwrap() as u64)
    };

    (timeout_secs, wait, runtime, deadline)
}

/// Everything the poll loop needs to persist the assistant reply and address
/// events back to the originating request.
struct PollContext {
    req_id: String,
    cap: String,
    id: String,
    chat_id: i64,
    assistant_msg_id: i64,
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

#[allow(clippy::too_many_arguments)]
pub async fn chat(
    req_id: String,
    capability: String,
    chat_id_str: String,
    content: String,
    attachment_ids: Vec<String>,
    model_online: bool,
    timeout_secs: Option<u32>,
    max_wait_secs: Option<u32>,
    runtime_secs: Option<u32>,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    if let Err(message) = run_chat(&req_id, capability, chat_id_str, content, attachment_ids, model_online, timeout_secs, max_wait_secs, runtime_secs, tx, state, user_id).await
    {
        send_error(tx, &req_id, &message);
    }
}

/// Persists the user message, submits the chat task, and spawns the poll loop.
/// Returns a user-facing error string; the caller relays it as a `ServerEvent`.
#[allow(clippy::too_many_arguments)]
async fn run_chat(
    req_id: &str,
    capability: String,
    chat_id_str: String,
    content: String,
    attachment_ids: Vec<String>,
    model_online: bool,
    timeout_secs: Option<u32>,
    max_wait_secs: Option<u32>,
    runtime_secs: Option<u32>,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) -> Result<(), String> {
    let chat_id: i64 = chat_id_str.parse().map_err(|_| "invalid chat_id".to_string())?;

    let parsed_attachment_ids: Vec<i64> = attachment_ids
        .iter()
        .filter_map(|s| s.parse::<i64>().ok())
        .collect();
    if parsed_attachment_ids.len() > chat_attachments::MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(format!(
            "too many attachments (max {})",
            chat_attachments::MAX_ATTACHMENTS_PER_MESSAGE
        ));
    }

    let chat = db_chats::get_chat(&state.db, chat_id, user_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat not found".to_string())?;

    // A turn with only attachments still needs non-empty user content so it
    // survives `build_offload_chat_messages` (and the agent has a turn to attach
    // the extracted text / images onto).
    let trimmed = content.trim();
    let stored_content = if trimmed.is_empty() && !parsed_attachment_ids.is_empty() {
        "Please review the attached file(s).".to_string()
    } else {
        content.clone()
    };

    let user_msg_id = state.next_id();
    db_chats::add_message(
        &state.db,
        user_msg_id,
        chat_id,
        "user",
        &stored_content,
        "complete",
        Some(&capability),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Link pre-uploaded attachments to this message and stage them into a
    // one-shot bucket for the agent (document text extraction + image attach).
    let attachments = db::chat_attachments::link_to_message(
        &state.db,
        &parsed_attachment_ids,
        user_id,
        user_msg_id,
        chat_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let file_bucket = chat_attachments::stage_into_bucket(state, &attachments)
        .await
        .map_err(|e| e.to_string())?;

    let _ = db_chats::set_last_model(&state.db, chat_id, user_id, &capability)
        .await
        .map_err(|e| e.to_string())?;

    if chat.title.is_empty() {
        let title = stored_content.chars().take(50).collect::<String>();
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
        attachment_count = attachments.len(),
        "submitting chat task with full history"
    );

    let (eff_timeout, eff_wait, eff_runtime, deadline) =
        resolve_timeouts(model_online, timeout_secs, max_wait_secs, runtime_secs);
    let client = offload_factory::chat_client(state).await.map_err(|e| e.to_string())?;
    let task_id = client.submit_chat(&capability, messages, eff_timeout, eff_wait, eff_runtime, file_bucket.as_deref()).await.map_err(|e| e.to_string())?;

    // Persist the assistant reply as `pending` up front, carrying the offload
    // task id. This is the authoritative record: the live poll loop below
    // finalizes it for connected clients, and the background chat worker
    // reconciles it if the WS drops or the pod restarts.
    let assistant_msg_id = state.next_id();
    db_chats::add_pending_assistant_message(
        &state.db,
        assistant_msg_id,
        chat_id,
        &capability,
        &task_id.cap,
        &task_id.id,
    )
    .await
    .map_err(|e| e.to_string())?;

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
    };
    tokio::spawn(poll_loop(ctx, task_id, client, tx.clone(), state.clone(), deadline));
    Ok(())
}

async fn poll_loop(
    ctx: PollContext,
    task_id: TaskId,
    client: OffloadClient,
    tx: UnboundedSender<ServerEvent>,
    state: Arc<AppState>,
    deadline_secs: Option<u64>,
) {
    let started_at = tokio::time::Instant::now();
    let mut first = true;
    loop {
        if !first {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        first = false;

        if let Some(limit) = deadline_secs {
            if started_at.elapsed().as_secs() >= limit {
                let _ = client.cancel_task(&task_id).await;
                finish_failure(&state, &tx, &ctx, "Task timed out waiting for result".to_string(), None).await;
                return;
            }
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
                finish_success(&state, &tx, &ctx, task_status::extract_llm_text(&resp.output), resp.log).await;
                return;
            }
            "failed" => {
                finish_failure(&state, &tx, &ctx, task_status::extract_error_text(&resp.output, "Unknown error"), resp.log).await;
                return;
            }
            "canceled" => {
                finish_failure(&state, &tx, &ctx, "Task was canceled".to_string(), resp.log).await;
                return;
            }
            "cancelRequested" => {
                let _ = client.cancel_task(&task_id).await;
                let stream_log = progress_stream_text(&resp);
                // Ignore send errors: if the WS is gone we keep polling so the
                // reply is still persisted (the background worker is the backstop
                // only for a pod restart, not a mere disconnect).
                let _ = tx.send(ServerEvent::TaskProgress {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    status: "cancelRequested".to_string(),
                    stage: resp.stage.clone(),
                    log: stream_log,
                });
            }
            status => {
                let stream_log = progress_stream_text(&resp);
                let _ = tx.send(ServerEvent::TaskProgress {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    status: status.to_string(),
                    stage: resp.stage,
                    log: stream_log,
                });
            }
        }
    }
}

/// Finalizes the pending assistant reply (idempotent) and notifies the client.
async fn finish_success(
    state: &AppState,
    tx: &UnboundedSender<ServerEvent>,
    ctx: &PollContext,
    text: String,
    log: Option<String>,
) {
    let _ = db_chats::finalize_message(&state.db, ctx.assistant_msg_id, &text, "complete").await;
    let _ = db_chats::touch_chat(&state.db, ctx.chat_id).await;
    let _ = tx.send(ServerEvent::TaskResult {
        req_id: ctx.req_id.clone(),
        cap: ctx.cap.clone(),
        id: ctx.id.clone(),
        text,
        log,
    });
}

/// Finalizes a failed/canceled/timed-out assistant turn (idempotent) and notifies
/// the client.
async fn finish_failure(
    state: &AppState,
    tx: &UnboundedSender<ServerEvent>,
    ctx: &PollContext,
    error: String,
    log: Option<String>,
) {
    let _ = db_chats::finalize_message(&state.db, ctx.assistant_msg_id, &error, "failed").await;
    let _ = tx.send(ServerEvent::TaskFailed {
        req_id: ctx.req_id.clone(),
        cap: ctx.cap.clone(),
        id: ctx.id.clone(),
        error,
        log,
    });
}

// ── Background reconciliation (stateless / restart-safe) ─────────────────────

/// Pending assistant replies older than this with no terminal offload result are
/// failed as timed out. Generous vs. the live loop so a slow task still lands.
const RECONCILE_DEADLINE_SECS: i64 = 900; // 15 min

/// Worker pass: reconcile every in-flight (`status="pending"`) assistant reply by
/// polling its offload task and persisting the result. Runs regardless of any WS,
/// so chats finish when the user leaves or the pod restarts.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    let pending = db_chats::list_pending_assistant_messages(&state.db, batch_size).await?;
    if pending.is_empty() {
        return Ok(());
    }
    let client = offload_factory::chat_client(state).await?;
    for msg in pending {
        if let Err(e) = reconcile_pending_message(state, &client, &msg).await {
            tracing::warn!(message_id = msg.id, "chat reconcile pass: {e}");
        }
    }
    Ok(())
}

async fn reconcile_pending_message(
    state: &AppState,
    client: &OffloadClient,
    msg: &db_chats::ChatMessage,
) -> Result<(), AppError> {
    let (cap, id) = match (msg.offload_cap.clone(), msg.offload_task_id.clone()) {
        (Some(cap), Some(id)) => (cap, id),
        _ => return Ok(()),
    };
    let task_id = TaskId { cap, id };
    let aged_out =
        chrono::Utc::now().fixed_offset() - msg.created_at > chrono::Duration::seconds(RECONCILE_DEADLINE_SECS);

    let resp = match client.poll_task(&task_id).await {
        Ok(r) => r,
        Err(e) => {
            // Task likely gone (e.g. urgent TTL expired) — fail it once it's old.
            if aged_out {
                let _ = db_chats::finalize_message(
                    &state.db,
                    msg.id,
                    "Task timed out waiting for result",
                    "failed",
                )
                .await;
            }
            return Err(e);
        }
    };

    match resp.status.as_str() {
        "completed" => {
            db_chats::finalize_message(&state.db, msg.id, &task_status::extract_llm_text(&resp.output), "complete")
                .await?;
            let _ = db_chats::touch_chat(&state.db, msg.chat_id).await;
        }
        "failed" => {
            db_chats::finalize_message(&state.db, msg.id, &task_status::extract_error_text(&resp.output, "Unknown error"), "failed")
                .await?;
        }
        "canceled" => {
            db_chats::finalize_message(&state.db, msg.id, "Task was canceled", "failed").await?;
        }
        "cancelRequested" => {
            let _ = client.cancel_task(&task_id).await;
        }
        _ if aged_out => {
            let _ = client.cancel_task(&task_id).await;
            db_chats::finalize_message(
                &state.db,
                msg.id,
                "Task timed out waiting for result",
                "failed",
            )
            .await?;
        }
        _ => {}
    }
    Ok(())
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
    let partial = task_status::extract_llm_text(&resp.output);
    if partial.is_empty() {
        None
    } else {
        Some(partial)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "assistant".to_string(),
                content: "hello".to_string(),
                status: "complete".to_string(),
                model: Some("llm.qwen".to_string()),
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "again".to_string(),
                status: "complete".to_string(),
                model: None,
                offload_cap: None,
                offload_task_id: None,
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
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "assistant".to_string(),
                content: "⚠ timeout".to_string(),
                status: "failed".to_string(),
                model: Some("llm.qwen".to_string()),
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "retry".to_string(),
                status: "complete".to_string(),
                model: None,
                offload_cap: None,
                offload_task_id: None,
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
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 2,
                chat_id: 1,
                role: "user".to_string(),
                content: "   ".to_string(),
                status: "complete".to_string(),
                model: None,
                offload_cap: None,
                offload_task_id: None,
                created_at: chrono::Utc::now().fixed_offset(),
            },
            db_chats::ChatMessage {
                id: 3,
                chat_id: 1,
                role: "user".to_string(),
                content: "ok".to_string(),
                status: "complete".to_string(),
                model: None,
                offload_cap: None,
                offload_task_id: None,
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
