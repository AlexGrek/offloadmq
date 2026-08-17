//! Shared OffloadMQ task-status plumbing used by every "submit → poll → persist"
//! job feature (tts, image analysis, nude detect, music generation, …).
//!
//! Two things live here:
//!   1. Pure helpers that were copy-pasted into every service: terminal-status
//!      checks, the "task missing" (404/410) detector, and output extractors.
//!   2. [`OffloadPoller`] — a thin normalization over the two concrete OffloadMQ
//!      clients (`OffloadClient` for chat/vision, `OffloadImageClient` for the
//!      image pipeline) so the generic job driver can poll/cancel either one
//!      without caring which it holds. Both clients hit the same upstream
//!      endpoints; only their Rust types differ.

use async_trait::async_trait;

use crate::{
    error::AppError,
    offload::{
        image_tasks::{OffloadImageClient, OffloadTaskId},
        OffloadClient, TaskId,
    },
};

/// Statuses from which a job never transitions again.
pub fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

/// Statuses a background worker must still pick up. Covers the movie/debate-owned
/// `running` plus every non-terminal upstream OffloadMQ status, so a job whose
/// status was ever written straight from a poll response is never orphaned.
pub const WORKER_PICKUP_STATUSES: [&str; 7] =
    ["running", "submitted", "pending", "queued", "assigned", "starting", "cancelRequested"];

pub const OFFLOAD_TASK_MISSING: &str =
    "OffloadMQ task not found (likely deleted or archived on the server)";

/// If `err` indicates the upstream task no longer exists (404/410, or a
/// not-found message), returns a user-facing reason string; otherwise `None`.
/// The caller marks the local job failed when this is `Some`.
pub fn offload_task_missing_message(err: &AppError) -> Option<String> {
    let AppError::ExternalService(msg) = err else {
        return None;
    };
    if let Some(rest) = msg.strip_prefix("POLL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    if let Some(rest) = msg.strip_prefix("CANCEL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not found") || lower.contains("not_found") {
        return Some(OFFLOAD_TASK_MISSING.to_string());
    }
    None
}

fn offload_http_is_task_missing(rest: &str) -> bool {
    matches!(
        rest.split_once(':').map(|(code, _)| code),
        Some("404") | Some("410")
    )
}

/// Extract an error string from a task output, falling back to `fallback`.
pub fn extract_error_text(output: &Option<serde_json::Value>, fallback: &str) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or(fallback)
        .to_string()
}

/// Extract the assistant text from an LLM/vision task output. Handles the Ollama
/// (`message.content`), OpenAI (`choices[0].message.content`), and bare
/// (`response` / `content`) shapes. Returns an empty string when none match.
pub fn extract_llm_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(extract_llm_text_from_value)
        .unwrap_or_default()
        .to_string()
}

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
        .or_else(|| v.get("content").and_then(|c| c.as_str()).filter(|s| !s.is_empty()))
}

/// Client-agnostic poll result.
pub struct NormalizedPoll {
    pub status: String,
    pub stage: Option<String>,
    pub output: Option<serde_json::Value>,
    /// Execution-time estimate from the OffloadMQ server, in seconds. `None` when
    /// the server has no history for the capability. Drives progress bars.
    pub typical_runtime_seconds: Option<f64>,
}

/// Statuses that mean the task is executing on an agent rather than waiting in
/// the queue — the point from which a run-time progress bar should measure.
pub fn is_executing(status: &str) -> bool {
    matches!(status, "starting" | "running")
}

/// Client-agnostic cancel result.
pub struct NormalizedCancel {
    pub status: String,
    pub message: String,
}

/// Poll/cancel an OffloadMQ task without knowing which concrete client backs it.
/// Implemented for both [`OffloadClient`] and [`OffloadImageClient`].
#[async_trait]
pub trait OffloadPoller: Send + Sync {
    async fn poll(&self, cap: &str, id: &str) -> Result<NormalizedPoll, AppError>;
    async fn cancel(&self, cap: &str, id: &str) -> Result<NormalizedCancel, AppError>;
    /// Release a bucket the finished job owned. Both clients speak the same
    /// storage API with the same key, so this is here rather than on the
    /// concrete client: bucket cleanup must work for chat-polled features
    /// (image analysis, nude detect) exactly as it does for image-polled ones.
    async fn delete_bucket(&self, bucket_uid: &str) -> Result<(), AppError>;
}

#[async_trait]
impl OffloadPoller for OffloadClient {
    async fn poll(&self, cap: &str, id: &str) -> Result<NormalizedPoll, AppError> {
        let resp = self
            .poll_task(&TaskId { cap: cap.to_string(), id: id.to_string() })
            .await?;
        Ok(NormalizedPoll {
            status: resp.status,
            stage: resp.stage,
            output: resp.output,
            typical_runtime_seconds: resp.typical_runtime_seconds.map(|d| d.as_secs_f64()),
        })
    }

    async fn cancel(&self, cap: &str, id: &str) -> Result<NormalizedCancel, AppError> {
        let resp = self
            .cancel_task(&TaskId { cap: cap.to_string(), id: id.to_string() })
            .await?;
        Ok(NormalizedCancel { status: resp.status, message: resp.message })
    }

    async fn delete_bucket(&self, bucket_uid: &str) -> Result<(), AppError> {
        OffloadClient::delete_bucket(self, bucket_uid).await
    }
}

#[async_trait]
impl OffloadPoller for OffloadImageClient {
    async fn poll(&self, cap: &str, id: &str) -> Result<NormalizedPoll, AppError> {
        let resp = self
            .poll_task(&OffloadTaskId { cap: cap.to_string(), id: id.to_string() })
            .await?;
        Ok(NormalizedPoll {
            status: resp.status,
            stage: resp.stage,
            output: resp.output,
            typical_runtime_seconds: resp.typical_runtime_seconds.map(|d| d.as_secs_f64()),
        })
    }

    async fn cancel(&self, cap: &str, id: &str) -> Result<NormalizedCancel, AppError> {
        let resp = self
            .cancel_task(&OffloadTaskId { cap: cap.to_string(), id: id.to_string() })
            .await?;
        Ok(NormalizedCancel { status: resp.status, message: resp.message })
    }

    async fn delete_bucket(&self, bucket_uid: &str) -> Result<(), AppError> {
        OffloadImageClient::delete_bucket(self, bucket_uid).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_llm_text_ollama_message_content() {
        let output = Some(serde_json::json!({ "message": { "content": "hello" } }));
        assert_eq!(extract_llm_text(&output), "hello");
    }

    #[test]
    fn extract_llm_text_openai_choices() {
        let output = Some(serde_json::json!({
            "choices": [{ "message": { "content": "hi there" } }]
        }));
        assert_eq!(extract_llm_text(&output), "hi there");
    }

    #[test]
    fn extract_llm_text_legacy_response_field() {
        let output = Some(serde_json::json!({ "response": "legacy" }));
        assert_eq!(extract_llm_text(&output), "legacy");
    }

    #[test]
    fn extract_llm_text_missing_returns_empty() {
        let output = Some(serde_json::json!({ "nope": true }));
        assert_eq!(extract_llm_text(&output), "");
    }

    #[test]
    fn extract_error_text_uses_fallback() {
        assert_eq!(extract_error_text(&None, "boom"), "boom");
        let output = Some(serde_json::json!({ "error": "explicit" }));
        assert_eq!(extract_error_text(&output, "boom"), "explicit");
    }
}
