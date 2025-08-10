use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::schema::*;

/// A task that has been received but not yet assigned to any agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnassignedTask {
    /// The unique ID assigned to this task by the MQ.
    pub id: uuid::Uuid,
    /// The capability required for this task.
    pub capability: String,
    /// Whether the task is urgent.
    pub urgent: bool,
    /// Whether the task can be retried on another agent after failure.
    pub restartable: bool,
    /// The task payload.
    pub payload: Value,
    /// When the task was created.
    pub created_at: DateTime<Utc>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedTask {
    /// The unique ID assigned to this task by the MQ.
    pub id: uuid::Uuid,
    /// The capability required for this task.
    pub capability: String,
    /// Whether the task is urgent.
    pub urgent: bool,
    /// Whether the task can be retried on another agent after failure.
    pub restartable: bool,
    /// The task payload.
    pub payload: Value,
    /// The ID of the agent currently processing this task.
    pub agent_id: String,
    /// The current status of the task.
    pub status: TaskStatus,
    /// A history of events for this task.
    pub history: Vec<TaskEvent>,
    /// When the task was created.
    pub created_at: DateTime<Utc>,
    /// When the task was assigned to this agent.
    pub assigned_at: DateTime<Utc>,
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

impl From<AgentRegistrationRequest> for Agent {
    fn from(request: AgentRegistrationRequest) -> Self {
        let now = Utc::now();

        Agent {
            uid: String::new(),
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
