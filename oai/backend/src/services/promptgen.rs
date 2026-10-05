//! Video prompt generator (img2video "Video prompt generator" button): sends the
//! input frame plus fixed system/user text to a vision LLM over the `/api/ws/promptgen`
//! socket. Inference uses one urgent, blocking OffloadMQ request.

use crate::error::ResultExt;
use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::{
    db::{image_generation, llm_capabilities},
    error::AppError,
    offload::{BlockingPromptResult, ChatMessage, LlmCapabilityInfo, base_capability},
    services::{image_processing, offload_factory, storage},
    state::AppState,
    ws::events::ServerEvent,
};

/// Video prompt generator (img2video "Video prompt generator" button): fixed
/// system + user text sent to a vision LLM with the input frame attached.
/// There is no user-editable query template — the button only needs to pick a model.
const VIDEO_PROMPT_SYSTEM: &str = r#"You are image analyzer. You are shown a frame of the video. You have to guess what happens next in the video. Respond with video description only, only the character and what they do, examples:

    The man takes his hat off and sits on the sofa.
    Woman screams and gets beaten.
    Children laugh and throw a ball up in the sky.

Omit "on this image" or "in this video", as well as any "I think" statements. You are not a person, you are the machine and have to give short structured answers. Only one single variant."#;

const VIDEO_PROMPT_USER: &str = "Write what happens next in this video, given this frame";

/// All online-tracked text LLM capabilities (no vision filter — any chat-capable
/// model can rewrite a prompt).
pub async fn list_llm_capabilities(state: &AppState) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    llm_capabilities::list_for_display(&state.db, &online_bases).await
}

// ── WebSocket control plane (mirrors chat WS flow) ───────────────────────────

pub async fn list_capabilities_ws(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    match list_llm_capabilities(state).await {
        Ok(capabilities) => {
            let _ = tx.send(ServerEvent::Capabilities {
                req_id,
                capabilities,
            });
        }
        Err(e) => send_error(tx, &req_id, &e.to_string()),
    }
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
    if !scope.is_open() {
        return Ok(());
    }
    tracing::debug!(user_id, %capability, %image_id, req_id, "video prompt generator: submitting urgent request");
    let result = submit_video_prompt_task(state, user_id, &capability, &image_id)
        .await
        .map_err(|e| e.to_string())?;
    if scope.is_open() {
        let _ = tx.send(ServerEvent::TaskResult {
            req_id: req_id.to_string(),
            cap: result.task_id.cap,
            id: result.task_id.id,
            text: result.text,
            log: result.log,
        });
    }
    Ok(())
}

/// Stage the input frame in a one-shot OffloadMQ bucket and submit a vision
/// task with the fixed [`VIDEO_PROMPT_SYSTEM`] / [`VIDEO_PROMPT_USER`] messages.
async fn submit_video_prompt_task(
    state: &AppState,
    user_id: i64,
    capability: &str,
    image_id: &str,
) -> Result<BlockingPromptResult, AppError> {
    let capability = capability.trim();
    if !base_capability(capability).starts_with("llm.") {
        return Err(AppError::BadRequest("an LLM capability is required".into()));
    }
    let capability = base_capability(capability).to_string();

    let image_id: i64 = image_id
        .parse()
        .map_err(|_| AppError::BadRequest("invalid image_id".into()))?;
    let input = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let op = storage::operator(state)?;
    let bytes = storage::read(op, &input.storage_path).await?;
    let processed =
        image_processing::process_image_async(bytes, Some(input.content_type.clone())).await?;
    let chat_client = offload_factory::chat_client(state).await?;
    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;

    let result = async {
        img_client
            .upload_bucket_file(
                &bucket.bucket_uid,
                processed.bytes,
                &input.filename,
                &processed.content_type,
            )
            .await?;
        chat_client
            .submit_vision_task_blocking(&capability, video_prompt_messages(), &bucket.bucket_uid)
            .await
    }
    .await;
    // Blocking submission has finished: release the frame on success and failure.
    img_client
        .delete_bucket(&bucket.bucket_uid)
        .await
        .log_warn("release video prompt frame bucket");
    result
}

fn video_prompt_messages() -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system".into(),
            content: VIDEO_PROMPT_SYSTEM.into(),
        },
        ChatMessage {
            role: "user".into(),
            content: VIDEO_PROMPT_USER.into(),
        },
    ]
}

fn send_error(tx: &UnboundedSender<ServerEvent>, req_id: &str, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: Some(req_id.to_string()),
        message: message.to_string(),
    });
}
