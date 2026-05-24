use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub mod image_tasks;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCapabilityInfo {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
    /// True when OffloadMQ reported this model online on the latest sync.
    pub online: bool,
    /// RFC3339 timestamp of the last time this model was seen online.
    pub last_available_at: String,
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
}

impl OffloadClient {
    pub fn new(http: Client, base_url: String, api_key: String) -> Self {
        Self { http, base_url: base_url.trim_end_matches('/').to_string(), api_key }
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
            })
            .collect())
    }

    pub async fn list_capabilities_with_prefix(
        &self,
        prefix: &str,
    ) -> Result<Vec<CapabilityInfo>, AppError> {
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
        let raw: Vec<String> =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        Ok(parse_capabilities_with_prefix(&raw, prefix))
    }

    pub async fn submit_chat(
        &self,
        capability: &str,
        messages: Vec<ChatMessage>,
        timeout_secs: Option<u32>,
        max_wait_secs: Option<u32>,
        runtime_secs: Option<u32>,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
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
            "file_bucket": [],
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

    pub async fn submit_vision_task(
        &self,
        capability: &str,
        messages: Vec<serde_json::Value>,
        bucket_uid: &str,
    ) -> Result<TaskId, AppError> {
        let url = format!("{}/api/task/submit", self.base_url);
        let body = serde_json::json!({
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
            "artifacts": []
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

    pub async fn poll_task(&self, task_id: &TaskId) -> Result<PollResponse, AppError> {
        let raw = self.poll_task_raw(task_id).await?;
        serde_json::from_value(raw).map_err(|e| AppError::ExternalService(e.to_string()))
    }

    /// Full OffloadMQ poll JSON — used by OAI debug mode.
    pub async fn poll_task_raw(&self, task_id: &TaskId) -> Result<serde_json::Value, AppError> {
        let cap_encoded = urlencoding::encode(&task_id.cap);
        let url = format!("{}/api/task/poll/{}/{}", self.base_url, cap_encoded, task_id.id);
        let body = serde_json::json!({ "apiKey": self.api_key });
        let resp = self
            .http
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

    pub async fn cancel_task(&self, task_id: &TaskId) -> Result<CancelTaskResponse, AppError> {
        post_cancel(&self.http, &self.base_url, &self.api_key, &task_id.cap, &task_id.id).await
    }
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

fn parse_capabilities_with_prefix(raw: &[String], prefix: &str) -> Vec<CapabilityInfo> {
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
