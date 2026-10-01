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
            Some(t) => {
                Utc::now().signed_duration_since(t)
                    <= chrono::Duration::seconds(ONLINE_TIMEOUT_SECS)
            }
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
        if let Some(info) = &self.system_info
            && info
                .machine_id
                .as_deref()
                .is_some_and(|id| id.to_lowercase() == needle_lower)
        {
            return true;
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

/// Real list sizes behind a (possibly truncated) `tasks/list` response.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TaskTotals {
    #[serde(default)]
    pub urgent_assigned: usize,
    #[serde(default)]
    pub urgent_unassigned: usize,
    #[serde(default)]
    pub regular_assigned: usize,
    #[serde(default)]
    pub regular_unassigned: usize,
}

/// `meta` block of `tasks/list`; absent on servers that predate the bounded listing.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TasksMeta {
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub totals: TaskTotals,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TasksOverview {
    pub urgent: TaskGroup,
    pub regular: TaskGroup,
    #[serde(default)]
    pub meta: TasksMeta,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaLimits {
    #[serde(default)]
    pub max_buckets_per_key: u64,
    #[serde(default)]
    pub bucket_size_bytes: u64,
    #[serde(default)]
    pub bucket_ttl_minutes: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaUsage {
    #[serde(default)]
    pub bucket_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub total_files: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageQuotas {
    pub limits: QuotaLimits,
    #[serde(default)]
    pub usage: HashMap<String, QuotaUsage>,
}

//=============================================================================
// Management logs, heuristics, and storage
//=============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogRecord {
    pub record_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub machine_fingerprint: Option<String>,
    pub severity: String,
    pub text: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentLogsResponse {
    #[serde(default)]
    pub items: Vec<AgentLogRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ContainerState {
    pub phase: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PodContainerStatus {
    pub name: String,
    pub ready: bool,
    pub restart_count: i32,
    #[serde(default)]
    pub current_state: Option<ContainerState>,
    #[serde(default)]
    pub last_state: Option<ContainerState>,
    #[serde(default)]
    pub has_previous_instance: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PodStatus {
    pub component: String,
    pub name: String,
    pub namespace: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub pod_ip: Option<String>,
    #[serde(default)]
    pub host_ip: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub containers: Vec<PodContainerStatus>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PodLogs {
    pub component: String,
    pub pod: String,
    pub namespace: String,
    pub container: String,
    pub tail_lines: u32,
    pub previous: bool,
    pub content: String,
    #[serde(default)]
    pub previous_exit: Option<ContainerState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeuristicRecord {
    pub capability: String,
    pub runner_id: String,
    #[serde(default)]
    pub machine_id: Option<String>,
    pub execution_time_ms: f64,
    pub success: bool,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HeuristicRecordsResponse {
    #[serde(default)]
    pub items: Vec<HeuristicRecord>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeuristicStats {
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub runner_id: Option<String>,
    #[serde(default)]
    pub machine_id: Option<String>,
    pub total_runs: u64,
    pub success_count: u64,
    pub fail_count: u64,
    pub success_pct: f64,
    #[serde(default)]
    pub success_avg_ms: Option<f64>,
    #[serde(default)]
    pub success_min_ms: Option<f64>,
    #[serde(default)]
    pub success_max_ms: Option<f64>,
    #[serde(default)]
    pub fail_avg_ms: Option<f64>,
    #[serde(default)]
    pub fail_min_ms: Option<f64>,
    #[serde(default)]
    pub fail_max_ms: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HeuristicStatsResponse {
    #[serde(default)]
    pub items: Vec<HeuristicStats>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StorageBucket {
    #[serde(default)]
    pub bucket_uid: String,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub used_bytes: u64,
    #[serde(default)]
    pub tasks: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StorageBucketGroup {
    #[serde(default)]
    pub bucket_count: u64,
    #[serde(default)]
    pub total_files: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub buckets: Vec<StorageBucket>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StorageBucketsResponse {
    #[serde(default)]
    pub buckets_by_key: HashMap<String, StorageBucketGroup>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_log_response_from_management_api() {
        let response: AgentLogsResponse = serde_json::from_value(serde_json::json!({
            "count": 1,
            "items": [{
                "recordId": "01JLOG",
                "agentId": "agent-1",
                "agentName": "gpu-worker",
                "machineFingerprint": "host-a",
                "severity": "ERROR",
                "text": "model failed",
                "timestamp": "2026-10-01T12:00:00Z"
            }]
        }))
        .unwrap();

        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].severity, "ERROR");
        assert_eq!(response.items[0].agent_name.as_deref(), Some("gpu-worker"));
    }

    #[test]
    fn parses_pod_and_log_diagnostics_from_management_api() {
        let status: PodStatus = serde_json::from_value(serde_json::json!({
            "component": "server",
            "name": "offloadmq-0",
            "namespace": "default",
            "phase": "Running",
            "ready": true,
            "containers": [{
                "name": "offloadmq",
                "ready": true,
                "restart_count": 1,
                "current_state": { "phase": "running" },
                "last_state": { "phase": "terminated", "exit_code": 137 },
                "has_previous_instance": true
            }]
        }))
        .unwrap();
        let logs: PodLogs = serde_json::from_value(serde_json::json!({
            "component": "server",
            "pod": "offloadmq-0",
            "namespace": "default",
            "container": "offloadmq",
            "tail_lines": 500,
            "previous": true,
            "content": "restarted",
            "previous_exit": { "phase": "terminated", "exit_code": 137 }
        }))
        .unwrap();

        assert!(status.ready);
        assert!(status.containers[0].has_previous_instance);
        assert_eq!(logs.previous_exit.unwrap().exit_code, Some(137));
    }

    #[test]
    fn parses_heuristics_and_storage_responses_from_management_api() {
        let records: HeuristicRecordsResponse = serde_json::from_value(serde_json::json!({
            "items": [{
                "capability": "llm.test",
                "runnerId": "agent-1",
                "machineId": "host-a",
                "executionTimeMs": 1250.0,
                "success": true,
                "completedAt": "2026-10-01T12:00:00Z"
            }],
            "next_cursor": "next"
        }))
        .unwrap();
        let buckets: StorageBucketsResponse = serde_json::from_value(serde_json::json!({
            "buckets_by_key": {
                "client-key": {
                    "bucket_count": 1,
                    "total_files": 2,
                    "total_bytes": 42,
                    "buckets": [{
                        "bucket_uid": "bucket-1",
                        "created_at": "2026-10-01T12:00:00Z",
                        "file_count": 2,
                        "used_bytes": 42,
                        "tasks": ["task-1"]
                    }]
                }
            }
        }))
        .unwrap();

        assert_eq!(records.items[0].machine_id.as_deref(), Some("host-a"));
        assert_eq!(records.next_cursor.as_deref(), Some("next"));
        assert_eq!(
            buckets.buckets_by_key["client-key"].buckets[0].tasks,
            ["task-1"]
        );
    }
}
