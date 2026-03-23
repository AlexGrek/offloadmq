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
use serde::{Deserialize, Serialize};

use crate::{
    models::Agent,
    schema::TaskId,
    utils::base_capability,
};

/// A record capturing execution characteristics for heuristic analysis of **non-urgent tasks only**
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Total memory available on runner (MB)
    pub runner_total_memory_mb: u64,
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
            runner_total_memory_mb: agent.system_info.total_memory_mb,
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

    /// Add free-form notes (for heuristic engine use)
    pub fn with_notes(mut self, notes: String) -> Self {
        self.notes = notes;
        self
    }
}
