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
    db::{image_generation, llm_capabilities, prompts},
    error::AppError,
    offload::{
        base_capability,
        task_status::{extract_error_text, extract_llm_text, is_terminal},
        ChatMessage, LlmCapabilityInfo, OffloadClient, TaskId,
    },
    services::{image_processing, offload_factory, storage},
    state::AppState,
    ws::events::ServerEvent,
};

/// Generation modes the prompt generator stores queries for. Must stay in sync
/// with `ImgGenMode` on the frontend.
const MODES: [&str; 4] = ["txt2img", "img2img", "txt2video", "img2video"];

/// Placeholder in the query template replaced with the user's prompt.
pub const PLACEHOLDER: &str = "{}";

/// Video prompt generator (img2video "Video prompt generator" button): fixed
/// system + user text sent to a vision LLM with the input frame attached.
/// Unlike [`generate`], there is no user-editable query template — the button
/// only needs to pick a model.
const VIDEO_PROMPT_SYSTEM: &str = r#"You are image analyzer. You are shown a frame of the video. You have to guess what happens next in the video. Respond with video description only, only the character and what they do, examples:

    The man takes his hat off and sits on the sofa.
    Woman screams and gets beaten.
    Children laugh and throw a ball up in the sky.

Omit "on this image" or "in this video", as well as any "I think" statements. You are not a person, you are the machine and have to give short structured answers. Only one single variant."#;

const VIDEO_PROMPT_USER: &str = "Write what happens next in this video, given this frame";

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

    queue_and_poll(req_id, task_id, tx, state, scope).await
}

pub async fn generate_video_prompt_ws(
    req_id: String,
    capability: String,
    image_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
    scope: &Arc<crate::ws::promptgen::ConnectionScope>,
) {
    if let Err(message) =
        run_generate_video_ws(&req_id, capability, image_id, tx, state, user_id, scope).await
    {
        send_error(tx, &req_id, &message);
    }
}

async fn run_generate_video_ws(
    req_id: &str,
    capability: String,
    image_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
    scope: &Arc<crate::ws::promptgen::ConnectionScope>,
) -> Result<(), String> {
    tracing::debug!(user_id, %capability, %image_id, req_id, "video prompt generator: submitting");
    let task_id = submit_video_prompt_task(state, user_id, &capability, &image_id)
        .await
        .map_err(|e| {
            tracing::warn!(user_id, %capability, %image_id, req_id, error = %e, "video prompt generator: submit failed");
            e.to_string()
        })?;
    tracing::debug!(user_id, cap = %task_id.cap, id = %task_id.id, req_id, "video prompt generator: task queued");

    queue_and_poll(req_id, task_id, tx, state, scope).await
}

/// Stage the input frame in a one-shot OffloadMQ bucket and submit a vision
/// task with the fixed [`VIDEO_PROMPT_SYSTEM`] / [`VIDEO_PROMPT_USER`] messages.
async fn submit_video_prompt_task(
    state: &AppState,
    user_id: i64,
    capability: &str,
    image_id: &str,
) -> Result<TaskId, AppError> {
    let capability = capability.trim();
    if capability.is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }
    let capability = base_capability(capability).to_string();

    let image_id: i64 = image_id
        .parse()
        .map_err(|_| AppError::BadRequest("invalid image_id".into()))?;
    let input = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    let processed = image_processing::process_image(bytes, Some(input.content_type.clone()))?;
    img_client
        .upload_bucket_file(&bucket.bucket_uid, processed.bytes, &input.filename, &processed.content_type)
        .await?;

    let chat_client = offload_factory::chat_client(state).await?;
    let messages = vec![
        serde_json::json!({ "role": "system", "content": VIDEO_PROMPT_SYSTEM }),
        serde_json::json!({ "role": "user", "content": VIDEO_PROMPT_USER }),
    ];
    chat_client
        .submit_vision_task(&capability, messages, &bucket.bucket_uid, None)
        .await
}

/// Shared tail of the WS generate flows: announce `task:queued`, track the task
/// on the connection scope (canceled if the client already closed), and spawn
/// the poll loop that streams progress/result back over the socket.
async fn queue_and_poll(
    req_id: &str,
    task_id: TaskId,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    scope: &Arc<crate::ws::promptgen::ConnectionScope>,
) -> Result<(), String> {
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
                tracing::warn!(req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id, limit, "promptgen: task timed out");
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
                tracing::warn!(req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id, error = %e, "promptgen: poll request failed");
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
                    tracing::warn!(
                        req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id,
                        "promptgen: model returned an empty response"
                    );
                    let _ = tx.send(ServerEvent::TaskFailed {
                        req_id: ctx.req_id.clone(),
                        cap: ctx.cap.clone(),
                        id: ctx.id.clone(),
                        error: "model returned an empty response".to_string(),
                        log: resp.log,
                    });
                } else {
                    tracing::debug!(
                        req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id, chars = text.trim().len(),
                        "promptgen: completed"
                    );
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
                let error = extract_error_text(&resp.output, "Unknown error");
                tracing::warn!(req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id, %error, "promptgen: task failed");
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id: ctx.req_id.clone(),
                    cap: ctx.cap.clone(),
                    id: ctx.id.clone(),
                    error,
                    log: resp.log,
                });
                scope.untrack(&task_id);
                return;
            }
            "canceled" => {
                tracing::debug!(req_id = %ctx.req_id, cap = %ctx.cap, id = %ctx.id, "promptgen: task canceled");
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
