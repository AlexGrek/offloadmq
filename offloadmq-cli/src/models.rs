use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

/// Online threshold used by the server (`Agent::ONLINE_TIMEOUT_SECS`).
pub const ONLINE_TIMEOUT_SECS: i64 = 120;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub model: String,
    #[serde(default)]
    pub vram_gb: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub client: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub cpu_arch: String,
    #[serde(default)]
    pub cpu_model: Option<String>,
    #[serde(default)]
    pub total_memory_gb: u64,
    #[serde(default)]
    pub gpu: Option<GpuInfo>,
    #[serde(default)]
    pub machine_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub uid: String,
    #[serde(default)]
    pub uid_short: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub registered_at: DateTime<Utc>,
    #[serde(default)]
    pub last_contact: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_comm_method: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub tier: u8,
    #[serde(default)]
    pub capacity: u32,
    #[serde(default)]
    pub system_info: Option<SystemInfo>,
    #[serde(default)]
    pub app_version: Option<String>,
    /// Whether the agent currently holds an open WebSocket connection.
    #[serde(default)]
    pub connected: Option<bool>,
    /// Number of tasks currently in flight on this agent.
    #[serde(default)]
    pub in_flight: Option<u64>,
}

impl Agent {
    /// Mirrors the server's `Agent::is_online` (last activity within 120s).
    pub fn is_online(&self) -> bool {
        match self.last_contact.or(Some(self.registered_at)) {
            Some(t) => Utc::now().signed_duration_since(t) <= chrono::Duration::seconds(ONLINE_TIMEOUT_SECS),
            None => false,
        }
    }

    /// Matches this agent against a user-supplied identifier: full uid, uid_short,
    /// a case-insensitive suffix/substring of the uid, or the display name.
    pub fn matches(&self, needle: &str) -> bool {
        let needle_lower = needle.to_lowercase();
        if self.uid == needle || self.uid_short == needle {
            return true;
        }
        if self.uid.to_lowercase().ends_with(&needle_lower) {
            return true;
        }
        if self
            .display_name
            .as_deref()
            .is_some_and(|n| n.to_lowercase() == needle_lower)
        {
            return true;
        }
        if let Some(info) = &self.system_info {
            if info
                .machine_id
                .as_deref()
                .is_some_and(|id| id.to_lowercase() == needle_lower)
            {
                return true;
            }
        }
        false
    }
}

//=============================================================================
// `omqcli status`
//=============================================================================

/// One row of `GET /management/heuristics/stats/runners` — per (capability,
/// runner) execution stats. `status` aggregates these across capabilities to
/// get one success rate per agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStat {
    #[serde(default)]
    pub runner_id: String,
    #[serde(default)]
    pub total_runs: u64,
    #[serde(default)]
    pub success_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunnerStatsResponse {
    #[serde(default)]
    pub items: Vec<RunnerStat>,
}

/// Minimal task identifier, mirrors the server's `TaskId { cap, id }`.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskId {
    pub cap: String,
    pub id: String,
}

/// A single historical event in a task's lifecycle (`AssignedTask.history`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub timestamp: DateTime<Utc>,
    pub description: String,
}

/// The client-submitted request data embedded in a task (`AssignedTask.data`
/// / `UnassignedTask.data`), i.e. `TaskSubmissionRequest` on the server.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskData {
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub urgent: bool,
    #[serde(default)]
    pub restartable: bool,
}

/// A row from `GET /management/tasks/list`. One struct covers both
/// `UnassignedTask` (only `id`/`data`/`createdAt`) and `AssignedTask` (adds
/// `agentId`/`status`/`stage`/`result`/`log`/`history`/`assignedAt`) —
/// fields absent for the unassigned shape just deserialize to their default.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: TaskId,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub data: Option<TaskData>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub assigned_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub log: Option<String>,
    #[serde(default)]
    pub history: Vec<TaskEvent>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TaskGroup {
    #[serde(default)]
    pub assigned: Vec<TaskSummary>,
    #[serde(default)]
    pub unassigned: Vec<TaskSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TasksOverview {
    pub urgent: TaskGroup,
    pub regular: TaskGroup,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaLimits {
    #[serde(default)]
    pub max_buckets_per_key: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaUsage {
    #[serde(default)]
    pub bucket_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageQuotas {
    pub limits: QuotaLimits,
    #[serde(default)]
    pub usage: HashMap<String, QuotaUsage>,
}
