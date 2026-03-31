//! Heuristic tracking for non-urgent task execution
//!
//! Records execution characteristics of non-urgent tasks to enable performance analysis:
//! - Execution time and success/failure status
//! - Runner (agent) tier, OS, CPU architecture, memory
//! - File bucket usage and file dependencies
//! - Timestamp and time-sortable composite key for queries
//!
//! Data is persisted forever in Sled for historical analysis.
//! Key format: "capability|runner_id|record_id" enables efficient queries by capability and runner.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    models::Agent,
    schema::{mb_to_gb_rounded, TaskId},
    utils::base_capability,
};

/// A record capturing execution characteristics for heuristic analysis of **non-urgent tasks only**
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeuristicRecord {
    /// Base capability (without extended attributes)
    pub capability: String,
    /// Agent that executed the task
    pub runner_id: String,
    /// Agent tier at execution time
    pub runner_tier: u8,
    /// Agent OS
    pub runner_os: String,
    /// CPU architecture
    pub runner_cpu_arch: String,
    /// Total system RAM on runner (whole gigabytes)
    pub runner_total_memory_gb: u64,
    /// Machine ID of the runner host (shared across agents on the same machine)
    /// Used for machine-level heuristics — similar machines share performance characteristics
    pub machine_id: Option<String>,
    /// Execution time in milliseconds
    pub execution_time_ms: f64,
    /// Whether the task succeeded
    pub success: bool,
    /// Buckets used for task input/output
    pub buckets_used: Vec<String>,
    /// Total number of buckets referenced
    pub bucket_count: usize,
    /// Whether task referenced any files
    pub has_files: bool,
    /// Free-form field for heuristic engine notes
    pub notes: String,
    /// Timestamp when task completed
    pub completed_at: DateTime<Utc>,
    /// Time-sortable unique ID for this record (date-indexable part of composite key)
    pub record_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeuristicRecordDe {
    capability: String,
    runner_id: String,
    runner_tier: u8,
    runner_os: String,
    runner_cpu_arch: String,
    #[serde(default)]
    runner_total_memory_gb: Option<u64>,
    #[serde(default)]
    runner_total_memory_mb: Option<u64>,
    #[serde(default)]
    machine_id: Option<String>,
    execution_time_ms: f64,
    success: bool,
    buckets_used: Vec<String>,
    bucket_count: usize,
    has_files: bool,
    notes: String,
    completed_at: DateTime<Utc>,
    record_id: String,
}

impl From<HeuristicRecordDe> for HeuristicRecord {
    fn from(d: HeuristicRecordDe) -> Self {
        let runner_total_memory_gb = d
            .runner_total_memory_gb
            .or_else(|| d.runner_total_memory_mb.map(mb_to_gb_rounded))
            .unwrap_or(0);
        Self {
            capability: d.capability,
            runner_id: d.runner_id,
            runner_tier: d.runner_tier,
            runner_os: d.runner_os,
            runner_cpu_arch: d.runner_cpu_arch,
            runner_total_memory_gb,
            machine_id: d.machine_id,
            execution_time_ms: d.execution_time_ms,
            success: d.success,
            buckets_used: d.buckets_used,
            bucket_count: d.bucket_count,
            has_files: d.has_files,
            notes: d.notes,
            completed_at: d.completed_at,
            record_id: d.record_id,
        }
    }
}

impl<'de> Deserialize<'de> for HeuristicRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        HeuristicRecordDe::deserialize(deserializer).map(Into::into)
    }
}

impl HeuristicRecord {
    /// Create a new heuristic record from non-urgent task execution data
    pub fn new(
        task_id: &TaskId,
        agent: &Agent,
        execution_time_ms: f64,
        success: bool,
        buckets_used: Vec<String>,
        has_files: bool,
    ) -> Self {
        Self {
            capability: base_capability(&task_id.cap).to_string(),
            runner_id: agent.uid.clone(),
            runner_tier: agent.tier,
            runner_os: agent.system_info.os.clone(),
            runner_cpu_arch: agent.system_info.cpu_arch.clone(),
            runner_total_memory_gb: agent.system_info.total_memory_gb,
            machine_id: agent.system_info.machine_id.clone(),
            execution_time_ms,
            success,
            buckets_used: buckets_used.clone(),
            bucket_count: buckets_used.len(),
            has_files,
            notes: String::new(),
            completed_at: Utc::now(),
            record_id: crate::utils::time_sortable_uid(),
        }
    }

    /// Create composite key for storage: "capability|runner_id|record_id"
    pub fn make_key(&self) -> String {
        format!("{}|{}|{}", self.capability, self.runner_id, self.record_id)
    }

    /// Create machine-indexed composite key: "machine_id|capability|record_id"
    /// Returns None if this record has no machine_id
    pub fn make_machine_key(&self) -> Option<String> {
        self.machine_id
            .as_ref()
            .map(|mid| format!("{}|{}|{}", mid, self.capability, self.record_id))
    }

    /// Add free-form notes (for heuristic engine use)
    pub fn with_notes(mut self, notes: String) -> Self {
        self.notes = notes;
        self
    }
}

/// Estimate the typical successful execution time for a capability on a given machine.
///
/// Strategy (requires at least 2 successful runs at each level):
/// 1. Average of successful runs for `(machine_id, capability)` — machine-specific estimate.
/// 2. Falls back to average of all successful runs for `(capability)` across all machines.
/// 3. Returns `None` if neither level has at least 2 successful runs.
pub fn estimate_duration(
    machine_records: &[HeuristicRecord],
    all_records: &[HeuristicRecord],
) -> Option<std::time::Duration> {
    const MIN_RUNS: usize = 2;

    let machine_success_ms: Vec<f64> = machine_records
        .iter()
        .filter(|r| r.success)
        .map(|r| r.execution_time_ms)
        .collect();

    if machine_success_ms.len() >= MIN_RUNS {
        let avg_ms = machine_success_ms.iter().sum::<f64>() / machine_success_ms.len() as f64;
        return Some(std::time::Duration::from_millis(avg_ms as u64));
    }

    let global_success_ms: Vec<f64> = all_records
        .iter()
        .filter(|r| r.success)
        .map(|r| r.execution_time_ms)
        .collect();

    if global_success_ms.len() >= MIN_RUNS {
        let avg_ms = global_success_ms.iter().sum::<f64>() / global_success_ms.len() as f64;
        return Some(std::time::Duration::from_millis(avg_ms as u64));
    }

    None
}
