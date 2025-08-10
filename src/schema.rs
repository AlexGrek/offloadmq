//! src/schema.rs
//!
//! Contains all public-facing API data structures.
//! These structs define the JSON contracts for requests and responses
//! between clients, agents, and the message queue server.

use serde::{Deserialize, Serialize};
use serde_json::Value; // Using Value for flexible payloads
use uuid::Uuid;

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
    /// The task has been assigned to an agent and is in progress.
    Running,
    /// The task was completed successfully by an agent.
    Completed,
    /// The task failed during execution.
    Failed,
    /// The task was cancelled by a client.
    Canceled,
}

/// Represents the final result status that an agent can report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TaskResultStatus {
    Completed,
    Failed,
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
/// The agent should send its permanent API key in an `X-API-Key` header.
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// Response sent to a client after a task is successfully submitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmissionResponse {
    /// The unique ID assigned to this task.
    pub task_id: Uuid,
}

/// Response body for a client polling the status of a task (`GET /tasks/{task_id}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusResponse {
    pub task_id: Uuid,
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
    pub task_id: Uuid,
    pub capability: String,
    pub payload: Value,
}

/// The request body an agent sends to report the result of a task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResultReport {
    pub task_id: Uuid,
    pub status: TaskResultStatus,
    /// The output data if the task completed successfully, or an error
    /// object if it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}
