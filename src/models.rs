use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    schema::*,
    utils::{get_last_six_chars, time_sortable_uid},
};

/// A task that has been received but not yet assigned to any agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnassignedTask {
    /// The unique ID assigned to this task by the MQ.
    pub id: TaskId,
    /// Request data
    pub data: TaskSubmissionRequest,
    /// When the task was created.
    pub created_at: DateTime<Utc>,
}

impl UnassignedTask {
    pub fn assign_to(&self, agent_id: &str) -> AssignedTask {
        let now = Utc::now();
        AssignedTask {
            id: self.id.clone(),
            data: self.data.clone(),
            agent_id: agent_id.to_string(),
            created_at: self.created_at.clone(),
            assigned_at: now,
            status: TaskStatus::Assigned,
            last_update_at: Some(now),
            history: vec![TaskEvent {
                timestamp: now,
                description: format!("Assigned to {agent_id}"),
            }],
            ..AssignedTask::default()
        }
    }

    pub fn into_status_report(self) -> TaskStatusResponse {
        TaskStatusResponse {
            id: self.id,
            status: TaskStatus::Queued,
            created_at: self.created_at,
            stage: None,
            output: None,
            log: None,
            typical_runtime_seconds: None,
            typical_runtime_parameters: None,
        }
    }

    pub fn into_assigned(self, agent_id: &str) -> AssignedTask {
        let now = Utc::now();
        AssignedTask {
            id: self.id,
            data: self.data,
            agent_id: agent_id.to_string(),
            created_at: self.created_at,
            assigned_at: now,
            status: TaskStatus::Assigned,
            log: None,
            last_update_at: Some(now),
            history: vec![TaskEvent {
                timestamp: now,
                description: format!("Assigned to {agent_id}"),
            }],
            ..AssignedTask::default()
        }
    }
}

/// Represents a single historical event in a task's lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    /// When the event occurred.
    pub timestamp: DateTime<Utc>,
    /// Human-readable description or machine-parseable type.
    pub description: String,
}

/// A task that has been assigned to an agent and is being processed.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssignedTask {
    /// The unique ID assigned to this task by the MQ.
    pub id: TaskId,
    /// The data provided by client required for this task.
    pub data: TaskSubmissionRequest,
    /// Agent assigned to this task
    pub agent_id: String,
    /// The current status of the task.
    pub status: TaskStatus,
    /// A history of events for this task.
    pub history: Vec<TaskEvent>,
    /// When the task was created.
    pub created_at: DateTime<Utc>,
    /// When the task was assigned to this agent.
    pub assigned_at: DateTime<Utc>,
    // task execution result (populated on success with data or on failure with logs, depends on specific task, may be empty)
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub log: Option<String>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub typical_runtime_seconds: Option<std::time::Duration>,
    #[serde(default)]
    pub typical_runtime_parameters: Option<TypicalRuntimeParameters>,
    /// When the task entered `CancelRequested`. Drives escalation to `Failed`
    /// if the agent never acknowledges the cancel signal.
    #[serde(default)]
    pub cancel_requested_at: Option<DateTime<Utc>>,
    /// When the task reached a terminal status. Used as the archive retention
    /// clock so results are kept for the full window after completion.
    #[serde(default)]
    pub finished_at: Option<DateTime<Utc>>,
    /// Last time the agent touched this task (assignment, progress, or report).
    /// Drives orphan recovery when the assigned agent goes silent and offline.
    #[serde(default)]
    pub last_update_at: Option<DateTime<Utc>>,
}

impl AssignedTask {
    pub fn change_status(&mut self, new_status: TaskStatus) {
        if self.status == new_status {
            return;
        }
        let now = Utc::now();
        match &new_status {
            TaskStatus::CancelRequested => self.cancel_requested_at = Some(now),
            s if s.is_terminal() => self.finished_at = Some(now),
            _ => {}
        }
        self.history.push(TaskEvent {
            timestamp: now,
            description: format!("Status set to {:?}", new_status),
        });
        self.status = new_status;
    }

    pub fn append_log(&mut self, log: Option<String>) {
        if log.is_none() {
            return;
        }
        let logstr = log.unwrap();
        self.log = match &self.log {
            Some(s) => Some(s.to_string() + &logstr),
            None => Some(logstr),
        };
    }

    pub fn change_stage(&mut self, stage: &str) {
        self.stage = Some(stage.to_owned())
    }

    pub fn into_status_report(self) -> TaskStatusResponse {
        TaskStatusResponse {
            id: self.id,
            status: self.status,
            created_at: self.created_at,
            stage: self.stage,
            output: self.result,
            log: self.log,
            typical_runtime_seconds: self.typical_runtime_seconds,
            typical_runtime_parameters: self.typical_runtime_parameters,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommunicationMethod {
    #[default]
    Http,
    #[serde(rename = "ws")]
    WebSocket,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub uid: String,
    pub uid_short: String,
    pub personal_login_token: String,
    pub registered_at: DateTime<Utc>,
    pub last_contact: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_comm_method: CommunicationMethod,
    pub capabilities: Vec<String>,
    pub tier: u8,
    pub capacity: u32,
    pub system_info: SystemInfo,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

impl Agent {
    const ONLINE_TIMEOUT_SECS: i64 = 120;

    /// Last activity timestamp for stale-agent cleanup. Falls back to
    /// `registered_at` for legacy records that predate `last_contact` on register.
    pub fn last_activity_at(&self) -> DateTime<Utc> {
        self.last_contact.unwrap_or(self.registered_at)
    }

    pub fn is_online(&self) -> bool {
        let now = Utc::now();
        now.signed_duration_since(self.last_activity_at())
            <= TimeDelta::seconds(Self::ONLINE_TIMEOUT_SECS)
    }
}

impl From<AgentRegistrationRequest> for Agent {
    fn from(request: AgentRegistrationRequest) -> Self {
        let now = Utc::now();
        let uid = time_sortable_uid();
        let short = get_last_six_chars(&uid);

        Agent {
            uid: uid,
            uid_short: short,   // Default to empty string
            registered_at: now, // Current timestamp
            personal_login_token: Uuid::new_v4().into(),
            last_contact: Some(now),
            last_comm_method: CommunicationMethod::Http,
            capabilities: request.capabilities,
            tier: request.tier,
            capacity: request.capacity,
            system_info: request.system_info,
            app_version: request.app_version,
            display_name: request.display_name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientApiKey {
    pub key: String,
    pub capabilities: Vec<String>,
    pub is_predefined: bool,
    pub created: DateTime<Utc>,
    pub is_revoked: bool,
}

impl From<CreateApiKeyRequest> for ClientApiKey {
    fn from(value: CreateApiKeyRequest) -> Self {
        Self {
            key: value.key,
            capabilities: value.capabilities,
            is_predefined: false,
            created: Utc::now(),
            is_revoked: false,
        }
    }
}
