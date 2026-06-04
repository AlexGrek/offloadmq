use serde::{Deserialize, Serialize};

use crate::offload::LlmCapabilityInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Hello {
        user_id: i64,
    },
    Pong,
    Capabilities {
        req_id: String,
        capabilities: Vec<LlmCapabilityInfo>,
    },
    #[serde(rename = "task:queued")]
    TaskQueued {
        req_id: String,
        cap: String,
        id: String,
    },
    #[serde(rename = "task:progress")]
    TaskProgress {
        req_id: String,
        cap: String,
        id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        log: Option<String>,
    },
    #[serde(rename = "task:result")]
    TaskResult {
        req_id: String,
        cap: String,
        id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        log: Option<String>,
    },
    #[serde(rename = "task:failed")]
    TaskFailed {
        req_id: String,
        cap: String,
        id: String,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        log: Option<String>,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientCommand {
    ListCapabilities { req_id: String },
    Chat {
        req_id: String,
        capability: String,
        chat_id: String,
        content: String,
        #[serde(default)]
        attachment_ids: Vec<String>,
        model_online: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_secs: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_wait_secs: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        runtime_secs: Option<u32>,
    },
    Ping,
}
