//! src/schema.rs
//!
//! Contains all public-facing API data structures.
//! These structs define the JSON contracts for requests and responses
//! between clients, agents, and the message queue server.

use std::fmt::Display;

use chrono::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value; // Using Value for flexible payloads
use uuid::Uuid;

use crate::utils::time_sortable_uid;

//=============================================================================
//  Enums & Common Types
//=============================================================================

/// Represents the overall status of a task in the system.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    /// The task has been accepted but not yet queued.
    Pending,
    /// The task is in the queue, waiting for an available agent.
    Queued,
    /// The task is locked for a specific agent, but this agent did not picked it up yet
    Pinned(String),
    /// The task has been assigned to an agent and transferred to the agent
    Assigned,
    /// Agent is preparing the task for execution
    Starting,
    /// The task is in progress
    Running,
    /// The task was completed successfully by an agent.
    Completed,
    /// The task failed during execution.
    Failed,
    /// The task was cancelled by a client.
    Canceled,
    /// Task is restartable and is returned to the queue
    FailedRetryPending,
    /// Task is delayed after failure
    FailedRetryDelayed,
}

impl Default for TaskStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// Represents the final result status that an agent can report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TaskResultStatus {
    Success(Duration),
    Failure(String, Duration),
    NotExecuted(String)
}

/// Task retry on failure policy
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskRetryConfiguration {
    /// Can retry run on the same node, if true - it can, if false - another node is required
    pub retry_on_same_node: bool,
    /// Maximun retries count, setting it to 0 makes it actually non-restartable
    pub max_retries: u64,
    /// Retry delay: how much time should pass before another retry
    pub retry_delay: Duration
}


//=============================================================================
//  Agent Lifecycle API
//=============================================================================

/// Body of the request for an agent to register itself with the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistrationRequest {
    /// A list of capabilities this agent provides (e.g., "LLM::mistral").
    pub capabilities: Vec<String>,
    /// The performance tier of the agent (higher is better).
    pub tier: u8,
    /// The number of concurrent tasks this agent can handle. Defaults to 1.
    pub capacity: u32,
    /// Information about the agent's host system.
    pub system_info: SystemInfo,
    pub api_key: String,
}

/// Body of the request for an agent to update itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateRequest {
    /// A list of capabilities this agent provides (e.g., "LLM::mistral").
    pub capabilities: Vec<String>,
    /// The performance tier of the agent (higher is better).
    pub tier: u8,
    /// The number of concurrent tasks this agent can handle. Defaults to 1.
    pub capacity: u32,
    /// Information about the agent's host system.
    pub system_info: SystemInfo,
}

/// A simple confirmation response after a successful agent registration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistrationResponse {
    /// The unique ID assigned to this agent by the server.
    pub agent_id: String,
    pub key: String,
    /// A confirmation message.
    pub message: String,
}

/// Request body for an agent to log in and receive a JWT.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoginRequest {
    /// The ID of the agent wishing to log in.
    pub agent_id: String,
    pub key: String,
}

/// Response containing the session JWT for an authenticated agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoginResponse {
    /// The JSON Web Token for the agent to use in subsequent requests.
    pub token: String,
    /// The token's validity period in seconds.
    pub expires_in: usize,
}

/// Basic system information reported by an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub client: String,
    pub runtime: String,
    pub cpu_arch: String,
    pub total_memory_mb: u64,
    pub gpu: Option<GpuInfo>,
}

/// GPU details, if available on the agent's system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub model: String,
    pub vram_mb: u64,
}


//=============================================================================
//  Task Lifecycle API
//=============================================================================

/// Request body for a client to submit a new task.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmissionRequest {
    /// The specific capability required to execute this task.
    pub capability: String,
    /// If true, the task will be pushed to an agent immediately.
    /// If false, it will be queued persistently.
    #[serde(default)]
    pub urgent: bool,
    /// If true, the task can be re-assigned to another agent upon failure.
    #[serde(default)]
    pub restartable: bool,
    /// The task-specific data payload.
    /// Can be any valid JSON object.
    pub payload: Value,
    pub api_key: String,
}

/// Unique task identifier that contains queue id (capability) and task id within that queue
#[derive(Debug, Clone, Serialize, Deserialize, Default, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TaskId {
    /// Capability, also doubles as a queue id
    pub cap: String,
    /// Unique task identifier, incremental string
    pub id: String
}

impl TaskId {
    pub fn new_with_cap(cap: String) -> TaskId {
        Self {
            cap, id: time_sortable_uid()
        }
    }
}

impl Display for TaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}/{}", self.cap, self.id)
    }
}

/// Response sent to a client after a task is successfully submitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmissionResponse {
    task: TaskId
}

/// Response body for a client polling the status of a task (`GET /tasks/{cap}/{id}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusResponse {
    pub id: TaskId,
    pub status: TaskStatus,
    /// Optional field describing the current stage (e.g., "processing_data").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// The final output of the task, present only when status is 'completed'.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// The message pushed to an agent via WebSocket to assign a new task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAssignment {
    pub id: TaskId,
    pub payload: Value,
}

/// The request body an agent sends to report the result of a task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResultReport {
    pub id: TaskId,
    pub capability: String,
    pub status: TaskResultStatus,
    /// The output data if the task completed successfully, or an error
    /// object if it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}
