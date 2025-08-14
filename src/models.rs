
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{schema::*, utils::time_sortable_uid};

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
        AssignedTask {
            id: self.id.clone(),
            data: self.data.clone(),
            agent_id: agent_id.to_string(),
            created_at: self.created_at.clone(),
            assigned_at: Utc::now(),
            ..AssignedTask::default()
        }
    }

    pub fn into_assigned(self, agent_id: &str) -> AssignedTask {
        AssignedTask {
            id: self.id,
            data: self.data,
            agent_id: agent_id.to_string(),
            created_at: self.created_at,
            assigned_at: Utc::now(),
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub uid: String,
    pub uid_short: String,
    pub personal_login_token: String,
    pub registered_at: DateTime<Utc>,
    pub last_contact: Option<DateTime<Utc>>,
    pub capabilities: Vec<String>,
    pub tier: u8,
    pub capacity: u32,
    pub system_info: SystemInfo,
}

impl Agent {
    const ONLINE_TIMEOUT_SECS: i64 = 120;
    pub fn is_online(&self) -> bool {
        if let Some(last) = self.last_contact {
            let now = Utc::now();
            now.signed_duration_since(last) <= TimeDelta::seconds(Self::ONLINE_TIMEOUT_SECS)
        } else {
            false
        }
    }
}

impl From<AgentRegistrationRequest> for Agent {
    fn from(request: AgentRegistrationRequest) -> Self {
        let now = Utc::now();

        Agent {
            uid: time_sortable_uid(),
            uid_short: String::new(), // Default to empty string
            registered_at: now,       // Current timestamp
            personal_login_token: Uuid::new_v4().into(),
            last_contact: None,
            capabilities: request.capabilities,
            tier: request.tier,
            capacity: request.capacity,
            system_info: request.system_info,
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
