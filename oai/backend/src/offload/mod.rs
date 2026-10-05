use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub mod image_tasks;
pub mod task_status;
pub mod watch;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCapabilityInfo {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
    /// True when OffloadMQ reported this model online on the latest sync.
    pub online: bool,
    /// RFC3339 timestamp of the last time this model was seen online.
    pub last_available_at: String,
    /// Times this capability was used in the requesting user's last 20 runs.
    /// Only populated for imggen capabilities today; 0 elsewhere.
    #[serde(default)]
    pub usage_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityInfo {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone)]
pub struct TaskId {
    pub cap: String,
    pub id: String,
}

pub struct BlockingPromptResult {
    pub task_id: TaskId,
    pub text: String,
    pub log: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct PollResponse {
    pub status: String,
    pub stage: Option<String>,
    pub output: Option<serde_json::Value>,
    pub log: Option<String>,
    /// Execution-time estimate computed by the OffloadMQ server from past runs
    /// of this capability. Serialized as `{ secs, nanos }`. Absent when no
    /// history exists.
    #[serde(default, rename = "typicalRuntimeSeconds")]
    pub typical_runtime_seconds: Option<std::time::Duration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelTaskResponse {
    pub id: CancelTaskId,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelTaskId {
    pub cap: String,
    pub id: String,
}

pub struct OffloadClient {
    http: Client,
    base_url: String,
    api_key: String,
    watch: std::sync::Arc<watch::TaskWatch>,
}

impl OffloadClient {
    pub fn new(
        http: Client,
        base_url: String,
        api_key: String,
        watch: std::sync::Arc<watch::TaskWatch>,
    ) -> Self {
        Self { http, base_url: base_url.trim_end_matches('/').to_string(), api_key, watch }
    }

    pub async fn list_llm_capabilities(&self) -> Result<Vec<LlmCapabilityInfo>, AppError> {
        Ok(self
            .list_capabilities_with_prefix("llm.")
            .await?
            .into_iter()
            .map(|c| LlmCapabilityInfo {
                base: c.base,
                tags: c.tags,
                raw: c.raw,
                online: true,
                last_available_at: chrono::Utc::now().to_rfc3339(),
                usage_count: 0,
            })
            .collect())
    }

    pub async fn list_capabilities_with_prefix(
        &self,
        prefix: &str,
    ) -> Result<Vec<CapabilityInfo>, AppError> {
        let raw = self.list_capabilities_raw().await?;
        Ok(parse_capabilities_with_prefix(&raw, prefix))
    }

    /// Every online capability string, extended attributes included. Callers that
    /// need more than one prefix should use this and [`parse_capabilities_with_prefix`]
    /// rather than paying for a round trip per prefix.
    pub async fn list_capabilities_raw(&self) -> Result<Vec<String>, AppError> {
        let url = format!("{}/api/capabilities/list/online_ext", self.base_url);
        let body = serde_json::json!({ "apiKey": self.api_key });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AppError::ExternalService(format!(
                "capabilities endpoint returned {}",
                resp.status()
            )));
        }
        resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))
    }

    pub async fn submit_chat(
        &self,
        capability: &str,
        messages: Vec<ChatMessage>,
        timeout_secs: Option<u32>,
        max_wait_secs: Option<u32>,
        runtime_secs: Option<u32>,
        file_bucket: Option<&str>,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
        // When a bucket is attached the agent extracts text from documents and
        // base64-attaches images onto the last user message (offload-agent
        // `exec/llm.py`). Streaming stays on so the reply still streams back.
        let buckets: Vec<&str> = file_bucket.into_iter().collect();
        let mut body = serde_json::json!({
            "apiKey": self.api_key,
            "capability": capability,
            "urgent": false,
            "restartable": false,
            "payload": {
                "stream": true,
                "messages": messages
            },
            "fetchFiles": [],
            "file_bucket": buckets,
            "artifacts": []
        });
        if let Some(v) = timeout_secs {
            body["timeoutSecs"] = serde_json::Value::Number(v.into());
        }
        if let Some(v) = max_wait_secs {
            body["maxWaitSecs"] = serde_json::Value::Number(v.into());
        }
        if let Some(v) = runtime_secs {
            body["runtimeSecs"] = serde_json::Value::Number(v.into());
        }
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("submit failed: {text}")));
        }
        let val: serde_json::Value =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        let cap = val["id"]["cap"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap in submit response".into()))?
            .to_string();
        let id = val["id"]["id"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id in submit response".into()))?
            .to_string();
        Ok(TaskId { cap, id })
    }

    /// Same messages contract as chat, with one urgent blocking request and no polling.
    pub async fn submit_chat_blocking(
        &self,
        capability: &str,
        messages: Vec<ChatMessage>,
    ) -> Result<String, AppError> {
        blocking_chat_text(self.submit_llm_blocking(capability, messages, None).await?)
    }

    pub async fn submit_vision_task_blocking(
        &self,
        capability: &str,
        messages: Vec<ChatMessage>,
        bucket_uid: &str,
    ) -> Result<BlockingPromptResult, AppError> {
        let result = self.submit_llm_blocking(capability, messages, Some(bucket_uid)).await?;
        let text = blocking_chat_text(result.clone())?;
        let cap = result["id"]["cap"].as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap in blocking response".into()))?;
        let id = result["id"]["id"].as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id in blocking response".into()))?;
        Ok(BlockingPromptResult {
            task_id: TaskId { cap: cap.to_string(), id: id.to_string() },
            text,
            log: result["log"].as_str().map(str::to_string),
        })
    }

    async fn submit_llm_blocking(
        &self,
        capability: &str,
        messages: Vec<ChatMessage>,
        file_bucket: Option<&str>,
    ) -> Result<serde_json::Value, AppError> {
        let buckets: Vec<&str> = file_bucket.into_iter().collect();
        let resp = self
            .http
            .post(format!("{}/api/task/submit_blocking", self.base_url))
            .timeout(std::time::Duration::from_secs(190))
            .json(&serde_json::json!({
                "apiKey": self.api_key,
                "capability": base_capability(capability),
                "urgent": true,
                "restartable": false,
                "payload": { "stream": false, "messages": messages },
                "fetchFiles": [],
                "file_bucket": buckets,
                "artifacts": [],
                "timeoutSecs": 180,
                "maxWaitSecs": 60,
                "runtimeSecs": 120
            }))
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("blocking chat failed (HTTP {status}): {text}")));
        }
        resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))
    }

    pub async fn submit_vision_task(
        &self,
        capability: &str,
        messages: Vec<serde_json::Value>,
        bucket_uid: &str,
        data_preparation: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
        let mut body = serde_json::json!({
            "apiKey": self.api_key,
            "capability": capability,
            "urgent": false,
            "restartable": false,
            "payload": {
                "stream": false,
                "messages": messages
            },
            "fetchFiles": [],
            "file_bucket": [bucket_uid],
            "artifacts": [],
            "timeoutSecs": 24 * 3600u64,
            "maxWaitSecs": 24 * 3600u64,
            "runtimeSecs": 15 * 60u64
        });
        if let Some(prep) = data_preparation.filter(|m| !m.is_empty()) {
            body["dataPreparation"] = serde_json::Value::Object(prep.clone());
        }
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("submit failed: {text}")));
        }
        let val: serde_json::Value =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        let cap = val["id"]["cap"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap in submit response".into()))?
            .to_string();
        let id = val["id"]["id"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id in submit response".into()))?
            .to_string();
        Ok(TaskId { cap, id })
    }

    pub async fn submit_nudenet_task(
        &self,
        threshold: f64,
        bucket_uid: &str,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
        let body = serde_json::json!({
            "apiKey": self.api_key,
            "capability": "onnx.nudenet",
            "urgent": false,
            "restartable": false,
            "payload": { "threshold": threshold },
            "fetchFiles": [],
            "file_bucket": [bucket_uid],
            "artifacts": [],
            "timeoutSecs": 24 * 3600u64,
            "maxWaitSecs": 24 * 3600u64,
            "runtimeSecs": 10 * 60u64
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("submit failed: {text}")));
        }
        let val: serde_json::Value =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        let cap = val["id"]["cap"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap in submit response".into()))?
            .to_string();
        let id = val["id"]["id"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id in submit response".into()))?
            .to_string();
        Ok(TaskId { cap, id })
    }

    /// Submit a non-urgent `tts.*` task. Payload follows the kokoro contract:
    /// `{ model, voice, input }` → response contains `audio_data_base64` +
    /// `content_type`.
    pub async fn submit_tts_task(
        &self,
        capability: &str,
        model: &str,
        voice: &str,
        text: &str,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
        let body = serde_json::json!({
            "apiKey": self.api_key,
            "capability": capability,
            "urgent": false,
            "restartable": false,
            "payload": {
                "model": model,
                "voice": voice,
                "input": text,
            },
            "fetchFiles": [],
            "file_bucket": [],
            "artifacts": [],
            "timeoutSecs": 24 * 3600u64,
            "maxWaitSecs": 24 * 3600u64,
            "runtimeSecs": 10 * 60u64
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("submit failed: {text}")));
        }
        let val: serde_json::Value =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        let cap = val["id"]["cap"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap in submit response".into()))?
            .to_string();
        let id = val["id"]["id"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id in submit response".into()))?
            .to_string();
        Ok(TaskId { cap, id })
    }

    /// Reads the shared [`watch::TaskWatch`] cache instead of hitting
    /// `POST /api/task/poll/{cap}/{id}` — see `offload::watch` for why. The
    /// error convention (`POLL_HTTP_404:` prefix, `offload_task_missing_message`)
    /// is preserved so every existing caller keeps working unmodified.
    pub async fn poll_task(&self, task_id: &TaskId) -> Result<PollResponse, AppError> {
        let f = watch::poll_via_watch(
            &self.watch,
            &self.http,
            &self.base_url,
            &self.api_key,
            &task_id.cap,
            &task_id.id,
        )
        .await?;
        Ok(PollResponse {
            status: f.status,
            stage: f.stage,
            output: f.output,
            log: f.log,
            typical_runtime_seconds: f.typical_runtime_seconds,
        })
    }

    /// Full OffloadMQ poll JSON — used by OAI debug mode.
    pub async fn poll_task_raw(&self, task_id: &TaskId) -> Result<serde_json::Value, AppError> {
        post_poll_raw(&self.http, &self.base_url, &self.api_key, &task_id.cap, &task_id.id).await
    }

    pub async fn cancel_task(&self, task_id: &TaskId) -> Result<CancelTaskResponse, AppError> {
        post_cancel(&self.http, &self.base_url, &self.api_key, &task_id.cap, &task_id.id).await
    }

    pub async fn delete_bucket(&self, bucket_uid: &str) -> Result<(), AppError> {
        delete_bucket(&self.http, &self.base_url, &self.api_key, bucket_uid).await
    }
}

fn blocking_chat_text(result: serde_json::Value) -> Result<String, AppError> {
    // Blocking submission returns the full AssignedTask (`result`); poll
    // responses use `output`. Accept both response shapes.
    let output = result.get("result").or_else(|| result.get("output")).cloned();
    if result["status"].as_str() != Some("completed") {
        let fallback = result["message"].as_str().unwrap_or("Prompt rewrite failed");
        return Err(AppError::ExternalService(task_status::extract_error_text(&output, fallback)));
    }
    let text = task_status::extract_llm_text(&output).trim().to_string();
    if text.is_empty() {
        return Err(AppError::ExternalService("Model returned an empty response".into()));
    }
    Ok(text)
}

/// Delete a bucket through the client storage API.
///
/// Shared by both clients: they carry the same base URL and key, and bucket
/// cleanup must not depend on which one a feature happens to poll with. A
/// bucket that is already gone (its `rm_after_task` reap, the server's TTL
/// sweep, or an earlier release) is the outcome we wanted, so 404 is success.
pub(crate) async fn delete_bucket(
    http: &Client,
    base_url: &str,
    api_key: &str,
    bucket_uid: &str,
) -> Result<(), AppError> {
    let url = format!("{base_url}/api/storage/bucket/{bucket_uid}");
    let resp = http
        .delete(&url)
        .header("X-API-Key", api_key)
        .send()
        .await
        .map_err(|e| AppError::ExternalService(e.to_string()))?;
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::ExternalService(format!(
            "delete bucket failed (HTTP {status}): {text}"
        )));
    }
    Ok(())
}

/// `POST /api/task/poll/{cap}/{id}` — one HTTP poll, returning the raw JSON.
/// Non-2xx responses become `ExternalService("POLL_HTTP_{status}:{body}")`,
/// the convention `task_status::offload_task_missing_message` parses.
pub(crate) async fn post_poll_raw(
    http: &Client,
    base_url: &str,
    api_key: &str,
    cap: &str,
    id: &str,
) -> Result<serde_json::Value, AppError> {
    let cap_encoded = urlencoding::encode(cap);
    let url = format!("{base_url}/api/task/poll/{cap_encoded}/{id}");
    let body = serde_json::json!({ "apiKey": api_key });
    let resp = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::ExternalService(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::ExternalService(format!("POLL_HTTP_{status}:{text}")));
    }
    resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))
}

pub(crate) async fn post_cancel(
    http: &Client,
    base_url: &str,
    api_key: &str,
    cap: &str,
    id: &str,
) -> Result<CancelTaskResponse, AppError> {
    let cap_encoded = urlencoding::encode(cap);
    let url = format!("{base_url}/api/task/cancel/{cap_encoded}/{id}");
    let body = serde_json::json!({ "apiKey": api_key });
    let resp = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::ExternalService(e.to_string()))?;
    if resp.status().as_u16() == 409 {
        let text = resp.text().await.unwrap_or_default();
        return Ok(CancelTaskResponse {
            id: CancelTaskId {
                cap: cap.to_string(),
                id: id.to_string(),
            },
            status: "cancelRequested".to_string(),
            message: if text.is_empty() {
                "Cancellation already requested".to_string()
            } else {
                text
            },
        });
    }
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::ExternalService(format!("CANCEL_HTTP_{status}:{text}")));
    }
    resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))
}

/// Strip extended attributes from a capability string: `llm.gemma4[vision;tools]`
/// → `llm.gemma4`. OffloadMQ requires tasks to be submitted with the **base**
/// capability only — its scheduler matches agents by base, so a bracketed task
/// cap would never be assigned. Always normalize before submitting a task.
pub fn base_capability(cap: &str) -> &str {
    cap.split_once('[').map(|(base, _)| base).unwrap_or(cap)
}

pub fn parse_capabilities_with_prefix(raw: &[String], prefix: &str) -> Vec<CapabilityInfo> {
    raw.iter()
        .filter(|s| s.starts_with(prefix))
        .map(|s| {
            if let Some(open) = s.find('[') {
                let base = s[..open].to_string();
                let inner = s[open + 1..].trim_end_matches(']');
                let tags = inner.split(';').map(|t| t.to_string()).collect();
                CapabilityInfo { base, tags, raw: s.clone() }
            } else {
                CapabilityInfo { base: s.clone(), tags: vec![], raw: s.clone() }
            }
        })
        .collect()
}

#[cfg(test)]
mod blocking_chat_tests {
    use super::*;

    #[tokio::test]
    async fn submits_urgent_blocking_chat_with_base_capability_and_messages() {
        use axum::{Json, Router, routing::post};
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route("/api/task/submit_blocking", post(
            move |Json(body): Json<serde_json::Value>| async move {
                tx.send(body).unwrap();
                Json(serde_json::json!({
                    "status": "completed", "result": {"message": {"content": "  Rewritten bird  "}}
                }))
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OffloadClient::new(Client::new(), format!("http://{address}"), "test-key".into(),
            watch::TaskWatch::for_test());
        let text = client.submit_chat_blocking("llm.test[tools]", vec![
            ChatMessage { role: "system".into(), content: "Modify prompts".into() },
            ChatMessage { role: "user".into(), content: "Rewrite a bird".into() },
        ]).await.unwrap();
        assert_eq!(text, "Rewritten bird");
        let body = rx.recv().await.unwrap();
        assert_eq!(body["apiKey"], "test-key");
        assert_eq!(body["capability"], "llm.test");
        assert_eq!(body["urgent"], true);
        assert_eq!(body["payload"]["stream"], false);
        assert_eq!(body["payload"]["messages"][0]["role"], "system");
        assert_eq!(body["payload"]["messages"][1]["content"], "Rewrite a bird");
        server.abort();
    }

    #[test]
    fn rejects_failed_canceled_partial_and_empty_responses() {
        for result in [
            serde_json::json!({"status": "failed", "result": {"error": "Agent failed"}}),
            serde_json::json!({"status": "canceled", "message": "Canceled"}),
            serde_json::json!({"status": "completed", "message": "Missing assignment"}),
            serde_json::json!({"status": "completed", "result": {"message": {"content": " "}}}),
        ] {
            assert!(blocking_chat_text(result).is_err());
        }
        let error = blocking_chat_text(serde_json::json!({
            "status": "failed", "result": {"error": "Agent failed"}
        })).unwrap_err();
        assert!(error.to_string().contains("Agent failed"));
    }

    #[tokio::test]
    async fn submits_urgent_blocking_vision_with_frame_bucket_and_returns_task_result() {
        use axum::{Json, Router, routing::post};
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route("/api/task/submit_blocking", post(
            move |Json(body): Json<serde_json::Value>| async move {
                tx.send(body).unwrap();
                Json(serde_json::json!({
                    "id": { "cap": "llm.vision", "id": "video-prompt-task" },
                    "status": "completed",
                    "result": { "message": { "content": "  The bird takes flight.  " } },
                    "log": "vision inference finished"
                }))
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OffloadClient::new(Client::new(), format!("http://{address}"), "test-key".into(),
            watch::TaskWatch::for_test());
        let result = client.submit_vision_task_blocking("llm.vision[vision]", vec![
            ChatMessage { role: "system".into(), content: "Predict what happens next".into() },
            ChatMessage { role: "user".into(), content: "Describe the next action from this frame".into() },
        ], "frame-bucket").await.unwrap();
        assert_eq!(result.text, "The bird takes flight.");
        assert_eq!(result.task_id.cap, "llm.vision");
        assert_eq!(result.task_id.id, "video-prompt-task");
        assert_eq!(result.log.as_deref(), Some("vision inference finished"));
        let body = rx.recv().await.unwrap();
        assert_eq!(body["capability"], "llm.vision");
        assert_eq!(body["urgent"], true);
        assert_eq!(body["file_bucket"], serde_json::json!(["frame-bucket"]));
        assert_eq!(body["payload"]["stream"], false);
        assert_eq!(body["payload"]["messages"][0]["role"], "system");
        assert_eq!(body["payload"]["messages"][1]["role"], "user");
        assert_eq!(body["timeoutSecs"], 180);
        server.abort();
    }
}
