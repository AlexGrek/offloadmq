//! src/schema.rs
//!
//! Contains all public-facing API data structures.
//! These structs define the JSON contracts for requests and responses
//! between clients, agents, and the message queue server.

use std::{collections::HashMap, fmt::Display};

use chrono::Duration;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value; // Using Value for flexible payloads

use crate::{
    error::AppError,
    utils::{time_sortable_uid, url_decode},
};

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
    /// The client has requested cancellation; the agent should stop work.
    CancelRequested,
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
    Success(f64),
    Failure(String, f64),
    NotExecuted(String),
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
    pub retry_delay: Duration,
}

//=============================================================================
//  Agent Lifecycle API
//=============================================================================

/// Body of the request for an agent to register itself with the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistrationRequest {
    /// A list of capabilities this agent provides (e.g., "llm.mistral").
    pub capabilities: Vec<String>,
    /// The performance tier of the agent (higher is better).
    pub tier: u8,
    /// The number of concurrent tasks this agent can handle. Defaults to 1.
    pub capacity: u32,
    /// Information about the agent's host system.
    pub system_info: SystemInfo,
    pub api_key: String,
    /// Optional application version string (e.g. commit count).
    #[serde(default)]
    pub app_version: Option<String>,
    /// Optional human-readable display name (max 50 chars).
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Body of the request for an agent to update itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateRequest {
    /// A list of capabilities this agent provides (e.g., "llm.mistral").
    pub capabilities: Vec<String>,
    /// The performance tier of the agent (higher is better).
    pub tier: u8,
    /// The number of concurrent tasks this agent can handle. Defaults to 1.
    pub capacity: u32,
    /// Information about the agent's host system.
    pub system_info: SystemInfo,
    /// Optional application version string (e.g. commit count).
    #[serde(default)]
    pub app_version: Option<String>,
    /// Optional human-readable display name (max 50 chars).
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Body of management request to create API key
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyRequest {
    pub key: String,
    pub capabilities: Vec<String>,
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

/// Convert legacy megabyte counts to whole gigabytes (same rounding as the agent).
pub(crate) fn mb_to_gb_rounded(mb: u64) -> u64 {
    if mb == 0 {
        0
    } else {
        std::cmp::max(1, (mb.saturating_add(512)) / 1024)
    }
}

/// Basic system information reported by an agent (RAM and VRAM in whole gigabytes).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub client: String,
    pub runtime: String,
    pub cpu_arch: String,
    pub cpu_model: Option<String>,
    pub total_memory_gb: u64,
    pub gpu: Option<GpuInfo>,
    pub machine_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfoDe {
    os: String,
    client: String,
    runtime: String,
    cpu_arch: String,
    cpu_model: Option<String>,
    #[serde(default)]
    total_memory_gb: Option<u64>,
    #[serde(default)]
    total_memory_mb: Option<u64>,
    #[serde(default)]
    gpu: Option<GpuInfoDe>,
    #[serde(default)]
    machine_id: Option<String>,
}

impl From<SystemInfoDe> for SystemInfo {
    fn from(d: SystemInfoDe) -> Self {
        let total_memory_gb = d
            .total_memory_gb
            .or_else(|| d.total_memory_mb.map(mb_to_gb_rounded))
            .unwrap_or(0);
        let gpu = d.gpu.map(GpuInfo::from);
        Self {
            os: d.os,
            client: d.client,
            runtime: d.runtime,
            cpu_arch: d.cpu_arch,
            cpu_model: d.cpu_model,
            total_memory_gb,
            gpu,
            machine_id: d.machine_id,
        }
    }
}

impl<'de> Deserialize<'de> for SystemInfo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        SystemInfoDe::deserialize(deserializer).map(Into::into)
    }
}

/// GPU details, if available on the agent's system (VRAM in whole gigabytes).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub model: String,
    pub vram_gb: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuInfoDe {
    vendor: String,
    model: String,
    #[serde(default)]
    vram_gb: Option<u64>,
    #[serde(default)]
    vram_mb: Option<u64>,
}

impl From<GpuInfoDe> for GpuInfo {
    fn from(d: GpuInfoDe) -> Self {
        let vram_gb = d
            .vram_gb
            .or_else(|| d.vram_mb.map(mb_to_gb_rounded))
            .unwrap_or(0);
        Self {
            vendor: d.vendor,
            model: d.model,
            vram_gb,
        }
    }
}

impl<'de> Deserialize<'de> for GpuInfo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        GpuInfoDe::deserialize(deserializer).map(Into::into)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileReference {
    path: String,
    /// Bucket UID to fetch this file from. Required when the task references
    /// more than one bucket; may be omitted when exactly one bucket is present
    /// (the single bucket is used implicitly) or when no buckets are used.
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    git_clone: Option<String>,
    #[serde(default)]
    get: Option<String>,
    #[serde(default)]
    post: Option<String>,
    #[serde(default)]
    request: Option<String>,
    #[serde(default)]
    http_login: Option<String>,
    #[serde(default)]
    http_password: Option<String>,
    #[serde(default)]
    http_auth_header: Option<String>,
    #[serde(default)]
    custom_header: Option<HashMap<String, String>>,
    #[serde(default)]
    s3_file: Option<String>,
    #[serde(default)]
    custom_auth: Option<String>,
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
    #[serde(default)]
    pub fetch_files: Vec<FileReference>,
    #[serde(default, rename = "file_bucket")]
    pub file_bucket: Vec<String>,
    /// Optional bucket UID where the agent should upload output files.
    /// The client must create this bucket before submitting the task and own it.
    #[serde(default, rename = "output_bucket")]
    pub output_bucket: Option<String>,
    /// Maximum seconds the agent should spend executing this task.
    /// Defaults to 600 (10 minutes) if not provided.
    #[serde(default, rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub artifacts: Vec<FileReference>,
    #[serde(default)]
    pub data_preparation: HashMap<String, String>,
    pub api_key: String,
}

/// Request body for a client with api_key field.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRequest {
    pub api_key: String,
}

/// Unique task identifier that contains queue id (capability) and task id within that queue
#[derive(Debug, Clone, Serialize, Deserialize, Default, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TaskId {
    /// Capability, also doubles as a queue id
    pub cap: String,
    /// Unique task identifier, incremental string
    pub id: String,
}

impl TaskId {
    pub fn new_with_cap(cap: String) -> TaskId {
        Self {
            cap,
            id: time_sortable_uid(),
        }
    }

    pub fn from_url(id: String, cap: String) -> Result<TaskId, AppError> {
        Ok(Self {
            cap: url_decode(&cap)?,
            id,
        })
    }
}

impl Display for TaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}[{}]", self.cap, self.id)
    }
}

/// Response sent to a client after a task is successfully submitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmissionResponse {
    task: TaskId,
}

/// Response body for a client polling the status of a task (`GET /tasks/{cap}/{id}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusResponse {
    pub id: TaskId,
    pub status: TaskStatus,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Optional field describing the current stage (e.g., "processing_data").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// The final output of the task, present only when status is 'completed'.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,

    pub log: Option<String>,

    #[serde(default)]
    pub typical_runtime_seconds: Option<std::time::Duration>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub id: TaskId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// The output data if the task completed successfully, or an error
    /// object if it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_update: Option<String>,
    /// Optional status transition (e.g. Starting, Running).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
}

/// Metadata for a single file within a bucket, returned by `bucket_stat`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatEntry {
    pub file_uid: String,
    pub original_name: String,
    pub size: u64,
    pub sha256: String,
}

/// Response body for the agent bucket-stat endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BucketStatResponse {
    pub bucket_uid: String,
    pub file_count: usize,
    pub files: Vec<FileStatEntry>,
}

/// Raw file data returned by the agent download-bucket-file operation.
/// Not serialised to JSON; transported as raw bytes over any transport.
pub struct DownloadedFile {
    pub data: Vec<u8>,
    pub original_name: String,
}
