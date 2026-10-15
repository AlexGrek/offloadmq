//! OpenRouter-compatible API surface (`/api/v1`) — see docs/openrouter-api.md.
//!
//! Lets OpenAI / OpenRouter clients use OffloadMQ by changing only the base
//! URL and key: a chat completion becomes an urgent `llm.<model>` task, and
//! the agent's streamed progress log becomes SSE `chat.completion.chunk`s.

pub mod error;
pub mod models;
pub mod stream;
pub mod translate;

use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use serde_json::json;

use crate::{
    middleware::{ClientKey, OptionalMgmtOverride},
    models::UnassignedTask,
    mq::{scheduler::enqueue_urgent_task, types::UrgentSubmitOutcome},
    schema::{TaskId, TaskStatus, TaskSubmissionRequest},
    state::AppState,
};

use error::{OrError, OrResult};
use translate::{ChatCompletionRequest, Completion, ResponseMeta};

/// Response header carrying the OffloadMQ task behind a completion.
pub const TASK_ID_HEADER: &str = "X-OffloadMQ-Task-Id";

/// `POST /api/v1/chat/completions`
pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    ClientKey(api_key): ClientKey,
    body: Bytes,
) -> OrResult<Response> {
    let req: ChatCompletionRequest = serde_json::from_slice(&body)
        .map_err(|e| OrError::bad_request(format!("Invalid request body: {e}")))?;
    let model = models::resolve(&state, &req.model_candidates(), &api_key, mgmt.is_active())?;
    let payload = translate::build_task_payload(&req, &model.local)?;
    let prompt_chars = translate::prompt_chars(&payload);

    let cfg = &state.config.openrouter;
    let id = TaskId::new_with_cap(model.capability.clone());
    let task = UnassignedTask {
        id: id.clone(),
        data: TaskSubmissionRequest {
            capability: model.capability.clone(),
            urgent: true,
            payload,
            max_wait_secs: Some(cfg.max_wait_secs),
            timeout_secs: Some(cfg.timeout_secs),
            runtime_secs: Some(cfg.timeout_secs),
            api_key,
            ..Default::default()
        },
        created_at: Utc::now(),
    };
    log::info!(
        "/api/v1 chat completion: task {} (model {}, stream {})",
        id,
        model.requested,
        req.stream
    );
    // Cancel the task if the client goes away before it finishes.
    let handle = enqueue_urgent_task(&state, task).await?.cancel_on_drop();

    let meta = ResponseMeta {
        id: format!("gen-{}", id.id),
        model: model.requested,
        created: Utc::now().timestamp(),
    };
    let mut response = if req.stream {
        stream::sse_response(state, handle, meta, prompt_chars, req.exclude_reasoning())
    } else {
        let outcome = handle.wait_terminal().await;
        let completion = completion_from_outcome(outcome)?;
        Json(meta.completion(&completion, prompt_chars, req.exclude_reasoning())).into_response()
    };
    if let Ok(v) = HeaderValue::from_str(&id.id) {
        response.headers_mut().insert(TASK_ID_HEADER, v);
    }
    Ok(response)
}

/// Turn a finished urgent task into the agent's completion, or the error to
/// report. Falls back to the streamed log when the output carries no text.
pub(crate) fn completion_from_outcome(outcome: UrgentSubmitOutcome) -> OrResult<Completion> {
    match outcome {
        UrgentSubmitOutcome::Completed(task) => {
            let output = task.result.as_ref();
            match task.status {
                TaskStatus::Completed => {
                    let mut c = Completion::from_output(output);
                    if c.content.is_empty() && c.tool_calls.is_empty() {
                        c.content = task.log.unwrap_or_default();
                    }
                    Ok(c)
                }
                TaskStatus::Canceled | TaskStatus::CancelRequested => {
                    Err(OrError::new(client_closed(), "Request was cancelled"))
                }
                _ => {
                    let message = output
                        .and_then(|o| o.get("error"))
                        .and_then(|e| e.as_str())
                        .unwrap_or("The agent failed to run the model");
                    Err(OrError::new(StatusCode::BAD_GATEWAY, message)
                        .with_metadata(json!({ "provider_name": "OffloadMQ" })))
                }
            }
        }
        // The entry was gone when collected: `expire_tasks` dropped it because
        // no agent picked it up in time, the agent went silent, or the global
        // deadline passed.
        UrgentSubmitOutcome::CompletedPartial { status, .. } => match status {
            TaskStatus::Canceled => Err(OrError::new(client_closed(), "Request was cancelled")),
            _ => Err(OrError::new(
                StatusCode::REQUEST_TIMEOUT,
                "Timed out waiting for an agent to finish the request",
            )),
        },
    }
}

fn client_closed() -> StatusCode {
    StatusCode::from_u16(499).unwrap_or(StatusCode::BAD_REQUEST)
}

/// `GET /api/v1/models`
pub async fn list_models(
    State(state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    ClientKey(api_key): ClientKey,
) -> OrResult<Json<serde_json::Value>> {
    let data = models::list(&state, &api_key, mgmt.is_active())?;
    Ok(Json(json!({ "data": data })))
}

/// `GET /api/v1/key` — OpenRouter's key-info endpoint. Self-hosted inference
/// has no credits or rate limit, so usage is 0 and the limit unlimited.
pub async fn key_info(
    mgmt: OptionalMgmtOverride,
    ClientKey(api_key): ClientKey,
) -> Json<serde_json::Value> {
    let label = if mgmt.is_active() {
        "management".to_string()
    } else {
        let prefix: String = api_key.chars().take(6).collect();
        format!("{prefix}...")
    };
    Json(json!({
        "data": {
            "label": label,
            "usage": 0,
            "limit": null,
            "limit_remaining": null,
            "is_free_tier": false,
            "is_provisioning_key": false,
            "rate_limit": { "requests": -1, "interval": "10s" },
        }
    }))
}
