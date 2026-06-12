//! Prompt generator for image/video generation: send the user's rough idea
//! through an LLM query template (`{}` is replaced with the idea) and return
//! the rewritten prompt. Query templates are stored per generation mode in the
//! generic prompt library (`prompt_entries`) under `imggen-promptgen-{mode}`
//! buckets, the same way LLM system prompts and image prompts are stored.

use std::collections::HashSet;

use crate::{
    db::{llm_capabilities, prompts},
    error::AppError,
    offload::{
        base_capability,
        task_status::{extract_error_text, extract_llm_text, is_terminal},
        ChatMessage, LlmCapabilityInfo, TaskId,
    },
    services::offload_factory,
    state::AppState,
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
