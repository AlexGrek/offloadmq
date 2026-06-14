//! Prompt generator for image/video generation: send the user's rough idea
//! through an LLM query template (`{}` is replaced with the idea) and return
//! the rewritten prompt. Query templates are stored per generation mode in the
//! generic prompt library (`prompt_entries`) under `imggen-promptgen-{mode}`
//! buckets, the same way LLM system prompts and image prompts are stored.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::{
    db::{llm_capabilities, prompts},
    error::AppError,
    offload::{
        base_capability,
        task_status::{extract_error_text, extract_llm_text, is_terminal},
        ChatMessage, LlmCapabilityInfo, OffloadClient, TaskId,
    },
    services::offload_factory,
    state::AppState,
    ws::events::ServerEvent,
};

/// Generation modes the prompt generator stores queries for. Must stay in sync
/// with `ImgGenMode` on the frontend.
const MODES: [&str; 4] = ["txt2img", "img2img", "txt2video", "img2video"];

/// Placeholder in the query template replaced with the user's prompt.
pub const PLACEHOLDER: &str = "{}";

/// OffloadMQ task limits: fail fast when no agent picks the task up (modal UX),
/// cap a single inference well under the chat defaults.
const TIMEOUT_SECS: u32 = 900;
const MAX_WAIT_SECS: u32 = 120;
const RUNTIME_SECS: u32 = 600;

/// Agent flushes streaming log to OffloadMQ about every 2s; poll slightly faster.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

struct PollContext {
    req_id: String,
    cap: String,
    id: String,
}

pub fn bucket_for_mode(mode: &str) -> Result<String, AppError> {
    if !MODES.contains(&mode) {
        return Err(AppError::BadRequest(format!(
            "unknown mode '{mode}' (expected one of {MODES:?})"
        )));
    }
    Ok(format!("imggen-promptgen-{mode}"))
}

/// All online-tracked text LLM capabilities (no vision filter — any chat-capable
/// model can rewrite a prompt).
pub async fn list_llm_capabilities(
    state: &AppState,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    llm_capabilities::list_for_display(&state.db, &online_bases).await
}

pub struct GenerateParams {
    pub mode: String,
    pub capability: String,
    pub query: String,
    pub prompt: String,
}

/// Validate, record the query template in the mode's bucket, and submit a
/// non-urgent LLM task. The caller polls via [`poll`].
pub async fn generate(
    state: &AppState,
    user_id: i64,
    params: GenerateParams,
) -> Result<TaskId, AppError> {
    let bucket = bucket_for_mode(&params.mode)?;
    let query = params.query.trim().to_string();
    let prompt = params.prompt.trim().to_string();
    if query.is_empty() {
        return Err(AppError::BadRequest("query is required".into()));
    }
    if !query.contains(PLACEHOLDER) {
        return Err(AppError::BadRequest(format!(
            "query must contain the {PLACEHOLDER} placeholder"
        )));
    }
    if prompt.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    if params.capability.trim().is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }
    let capability = base_capability(params.capability.trim()).to_string();

    // Best-effort: keep the per-mode recents list current without a second
    // request from the frontend (same pattern as describe job submission).
    let _ = prompts::record_use(&state.db, || state.next_id(), user_id, &bucket, &query).await;

    let content = query.replace(PLACEHOLDER, &prompt);
    let client = offload_factory::chat_client(state).await?;
    client
        .submit_chat(
            &capability,
            vec![ChatMessage { role: "user".into(), content }],
            Some(TIMEOUT_SECS),
            Some(MAX_WAIT_SECS),
            Some(RUNTIME_SECS),
            None,
        )
        .await
}

pub struct PollResult {
    pub status: String,
    pub stage: Option<String>,
    /// Generated prompt text — set only when the task completed.
    pub text: Option<String>,
    /// Failure reason — set only on failed/canceled.
    pub error: Option<String>,
}

pub async fn poll(state: &AppState, cap: &str, id: &str) -> Result<PollResult, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let resp = client
        .poll_task(&TaskId { cap: cap.to_string(), id: id.to_string() })
        .await?;

    let mut result = PollResult { status: resp.status, stage: resp.stage, text: None, error: None };
    if !is_terminal(&result.status) {
        return Ok(result);
    }
    if result.status == "completed" {
        let text = extract_llm_text(&resp.output);
        if text.trim().is_empty() {
            result.status = "failed".into();
            result.error = Some("model returned an empty response".into());
        } else {
            result.text = Some(text.trim().to_string());
        }
    } else {
        result.error = Some(extract_error_text(&resp.output, "task did not complete"));
    }
    Ok(result)
}

// ── WebSocket control plane (mirrors chat WS flow) ───────────────────────────

pub async fn list_capabilities_ws(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    match list_llm_capabilities(state).await {
        Ok(capabilities) => {
            let _ = tx.send(ServerEvent::Capabilities { req_id, capabilities });
        }
        Err(e) => send_error(tx, &req_id, &e.to_string()),
    }
}

pub async fn generate_prompt_ws(
    req_id: String,
    mode: String,
    capability: String,
    query: String,
    prompt: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
    scope: &Arc<crate::ws::promptgen::ConnectionScope>,
) {
    if let Err(message) = run_generate_ws(
        &req_id,
        mode,
        capability,
        query,
        prompt,
        tx,
        state,
        user_id,
        scope,
    )
    .await
    {
        send_error(tx, &req_id, &message);
    }
}

async fn run_generate_ws(
    req_id: &str,
    mode: String,
    capability: String,
    query: String,
    prompt: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
    scope: &Arc<crate::ws::promptgen::ConnectionScope>,
) -> Result<(), String> {
    let task_id = generate(
        state,
        user_id,
        GenerateParams {
            mode,
            capability,
            query,
            prompt,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    if !scope.is_open() {
        let client = offload_factory::chat_client(state).await.map_err(|e| e.to_string())?;
        let _ = client.cancel_task(&task_id).await;
        return Ok(());
    }

    let _ = tx.send(ServerEvent::TaskQueued {
        req_id: req_id.to_string(),
        cap: task_id.cap.clone(),
        id: task_id.id.clone(),
    });

    scope.track(task_id.clone());
    let client = offload_factory::chat_client(state).await.map_err(|e| e.to_string())?;
    let deadline_secs = Some(TIMEOUT_SECS as u64);
    let ctx = PollContext {
        req_id: req_id.to_string(),
        cap: task_id.cap.clone(),
        id: task_id.id.clone(),
    };
    let scope = scope.clone();
    tokio::spawn(poll_loop_ws(ctx, task_id, client, tx.clone(), deadline_secs, scope));
    Ok(())
}

async fn poll_loop_ws(
    ctx: PollContext,
    task_id: TaskId,
    client: OffloadClient,
    tx: UnboundedSender<ServerEvent>,
    deadline_secs: Option<u64>,
    scope: Arc<crate::ws::promptgen::ConnectionScope>,
) {
    let started_at = tokio::time::Instant::now();
    let mut first = true;
    loop {
        if !scope.is_open() {
            let _ = client.cancel_task(&task_id).await;
            scope.untrack(&task_id);
            return;
        }

        if !first {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        first = false;

        if let Some(limit) = deadline_secs {
            if started_at.elapsed().as_secs() >= limit {
                let _ = client.cancel_task(&task_id).await;
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    error: "Task timed out waiting for result".to_string(),
                    log: None,
                });
                scope.untrack(&task_id);
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
                scope.untrack(&task_id);
                return;
            }
        };

        match resp.status.as_str() {
            "completed" => {
                let text = extract_llm_text(&resp.output);
                if text.trim().is_empty() {
                    let _ = tx.send(ServerEvent::TaskFailed {
                        req_id: ctx.req_id.clone(),
                        cap: ctx.cap.clone(),
                        id: ctx.id.clone(),
                        error: "model returned an empty response".to_string(),
                        log: resp.log,
                    });
                } else {
                    let _ = tx.send(ServerEvent::TaskResult {
                        req_id: ctx.req_id.clone(),
                        cap: ctx.cap.clone(),
                        id: ctx.id.clone(),
                        text: text.trim().to_string(),
                        log: resp.log,
                    });
                }
                scope.untrack(&task_id);
                return;
            }
            "failed" => {
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    error: extract_error_text(&resp.output, "Unknown error"),
                    log: resp.log,
                });
                scope.untrack(&task_id);
                return;
            }
            "canceled" => {
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    error: "Task was canceled".to_string(),
                    log: resp.log,
                });
                scope.untrack(&task_id);
                return;
            }
            "cancelRequested" => {
                let _ = client.cancel_task(&task_id).await;
                let stream_log = progress_stream_text(&resp);
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

fn send_error(tx: &UnboundedSender<ServerEvent>, req_id: &str, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: Some(req_id.to_string()),
        message: message.to_string(),
    });
}

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
