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
    schema::{TaskId, mb_to_gb_rounded, TypicalRuntimeParameters},
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
    /// Total image generation size (width * height) in pixels
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_size: Option<u64>,
    /// Video generation length in frames/seconds/etc
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
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
    #[serde(default)]
    total_size: Option<u64>,
    #[serde(default)]
    length: Option<u64>,
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
            total_size: d.total_size,
            length: d.length,
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
        payload: &serde_json::Value,
    ) -> Self {
        let params = TypicalRuntimeParameters::from_payload(&task_id.cap, payload);
        let (total_size, length) = match params {
            Some(p) => (p.total_size, p.length),
            None => (None, None),
        };
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
            total_size,
            length,
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

/// Shape of the effort parameters present on a record or task — used to avoid
/// mixing rates computed in different units (e.g. ms/pixel vs ms/(pixel*frame)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParamShape {
    has_total_size: bool,
    has_length: bool,
}

impl ParamShape {
    fn of(total_size: Option<u64>, length: Option<u64>) -> Self {
        Self {
            has_total_size: total_size.is_some(),
            has_length: length.is_some(),
        }
    }
}

/// Effort units for a task: total pixel count times frame count. Missing
/// dimensions default to 1 so a plain image (no `length`) has effort == total_size.
fn effort_of(total_size: Option<u64>, length: Option<u64>) -> u64 {
    total_size.unwrap_or(1) * length.unwrap_or(1)
}

/// Mean of successful `execution_time_ms` values, `None` if empty.
fn plain_average(records: &[HeuristicRecord]) -> Option<std::time::Duration> {
    let success_ms: Vec<f64> = records
        .iter()
        .filter(|r| r.success)
        .map(|r| r.execution_time_ms)
        .collect();

    const MIN_RUNS: usize = 2;
    if success_ms.len() < MIN_RUNS {
        return None;
    }
    let avg_ms = success_ms.iter().sum::<f64>() / success_ms.len() as f64;
    Some(std::time::Duration::from_millis(avg_ms as u64))
}

/// Median of `execution_time_ms / effort` over successful records whose param
/// shape matches `shape` and whose effort is nonzero, scaled by `current_effort`.
/// `None` if fewer than `MIN_RUNS` records qualify.
fn effort_normalized(
    records: &[HeuristicRecord],
    shape: ParamShape,
    current_effort: u64,
) -> Option<std::time::Duration> {
    const MIN_RUNS: usize = 2;

    let mut rates: Vec<f64> = records
        .iter()
        .filter(|r| r.success)
        .filter(|r| ParamShape::of(r.total_size, r.length) == shape)
        .filter_map(|r| {
            let effort = effort_of(r.total_size, r.length);
            (effort > 0).then(|| r.execution_time_ms / effort as f64)
        })
        .collect();

    if rates.len() < MIN_RUNS {
        return None;
    }

    rates.sort_by(f64::total_cmp);
    let mid = rates.len() / 2;
    let median_rate = if rates.len() % 2 == 0 {
        (rates[mid - 1] + rates[mid]) / 2.0
    } else {
        rates[mid]
    };

    let estimated_ms = median_rate * current_effort as f64;
    Some(std::time::Duration::from_millis(estimated_ms as u64))
}

/// Estimate the expected execution time for a task on a given machine, scaled
/// by the task's effort (image resolution, video length) when available.
///
/// Fallback ladder (each tier requires at least 2 qualifying successful runs):
/// 1. Machine-specific rate (ms per effort unit), scaled by this task's effort —
///    only when the current task has params and matching machine records exist.
/// 2. Plain average of successful runs for `(machine_id, capability)`.
/// 3. Global rate (across all machines), scaled by this task's effort.
/// 4. Plain average of all successful runs for `(capability)` across all machines.
/// 5. `None` if nothing qualifies.
///
/// Machine-specific data is preferred over rate-normalized global data because
/// hardware speed variance typically exceeds effort-driven variance within a
/// capability; rate tiers only compare records whose param *shape* — which of
/// total_size/length are present — matches the current task's, so an image-only
/// rate is never mixed with a video rate.
pub fn estimate_duration(
    machine_records: &[HeuristicRecord],
    all_records: &[HeuristicRecord],
    current_params: Option<&TypicalRuntimeParameters>,
) -> Option<std::time::Duration> {
    let current = current_params.and_then(|p| {
        let effort = effort_of(p.total_size, p.length);
        let has_params = p.total_size.is_some() || p.length.is_some();
        (has_params && effort > 0).then(|| (ParamShape::of(p.total_size, p.length), effort))
    });

    if let Some((shape, effort)) = current {
        if let Some(d) = effort_normalized(machine_records, shape, effort) {
            return Some(d);
        }
    }

    if let Some(d) = plain_average(machine_records) {
        return Some(d);
    }

    if let Some((shape, effort)) = current {
        if let Some(d) = effort_normalized(all_records, shape, effort) {
            return Some(d);
        }
    }

    plain_average(all_records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_typical_runtime_parameters_from_payload() {
        // Test non-imggen capability
        let payload = json!({
            "resolution": { "width": 1024, "height": 1024 },
            "length": 16
        });
        assert_eq!(
            TypicalRuntimeParameters::from_payload("llm.qwen3", &payload),
            None
        );

        // Test imggen capability with resolution object
        let payload = json!({
            "resolution": { "width": 512, "height": 512 },
            "length": 30
        });
        let params = TypicalRuntimeParameters::from_payload("imggen.flux", &payload).unwrap();
        assert_eq!(params.total_size, Some(262144));
        assert_eq!(params.length, Some(30));

        // Test imggen capability with direct width/height strings
        let payload = json!({
            "width": "1000",
            "height": "1000"
        });
        let params = TypicalRuntimeParameters::from_payload("imggen.flux[vision]", &payload).unwrap();
        assert_eq!(params.total_size, Some(1000000));
        assert_eq!(params.length, None);
    }

    fn rec(ms: f64, success: bool, total_size: Option<u64>, length: Option<u64>) -> HeuristicRecord {
        HeuristicRecord {
            capability: "imggen.flux".to_string(),
            runner_id: "runner-1".to_string(),
            runner_tier: 1,
            runner_os: "linux".to_string(),
            runner_cpu_arch: "x86_64".to_string(),
            runner_total_memory_gb: 16,
            machine_id: Some("machine-1".to_string()),
            execution_time_ms: ms,
            success,
            buckets_used: vec![],
            bucket_count: 0,
            has_files: false,
            notes: String::new(),
            completed_at: Utc::now(),
            record_id: crate::utils::time_sortable_uid(),
            total_size,
            length,
        }
    }

    fn params(total_size: Option<u64>, length: Option<u64>) -> TypicalRuntimeParameters {
        TypicalRuntimeParameters { total_size, length }
    }

    #[test]
    fn scales_up_by_resolution() {
        // Two records at 512x512 (262144px) took 10_000ms each -> rate 10_000/262144.
        let records = vec![
            rec(10_000.0, true, Some(262_144), None),
            rec(10_000.0, true, Some(262_144), None),
        ];
        let current = params(Some(1_048_576), None); // 1024x1024 = 4x the pixels
        let estimate = estimate_duration(&records, &records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 40_000);
    }

    #[test]
    fn scales_down_by_resolution() {
        let records = vec![
            rec(40_000.0, true, Some(1_048_576), None),
            rec(40_000.0, true, Some(1_048_576), None),
        ];
        let current = params(Some(262_144), None);
        let estimate = estimate_duration(&records, &records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 10_000);
    }

    #[test]
    fn scales_by_frame_count() {
        let records = vec![
            rec(8_000.0, true, Some(262_144), Some(16)),
            rec(8_000.0, true, Some(262_144), Some(16)),
        ];
        let current = params(Some(262_144), Some(32));
        let estimate = estimate_duration(&records, &records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 16_000);
    }

    #[test]
    fn shape_mismatch_excluded_falls_back_to_plain_average() {
        // One size-only record and one size+length record on the machine — neither
        // shape has 2 matches, so the rate tier can't fire; falls to plain average.
        let machine_records = vec![
            rec(10_000.0, true, Some(262_144), None),
            rec(20_000.0, true, Some(262_144), Some(16)),
        ];
        let current = params(Some(262_144), Some(16));
        let estimate = estimate_duration(&machine_records, &machine_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 15_000);
    }

    #[test]
    fn machine_records_without_params_use_plain_average() {
        let machine_records = vec![rec(10_000.0, true, None, None), rec(20_000.0, true, None, None)];
        let current = params(Some(262_144), None);
        let estimate = estimate_duration(&machine_records, &machine_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 15_000);
    }

    #[test]
    fn falls_back_to_global_rate_when_machine_data_insufficient() {
        // Only 1 machine record (below MIN_RUNS for both tiers), but 2 global
        // shape-matched records exist elsewhere.
        let machine_records = vec![rec(999_999.0, true, Some(262_144), None)];
        let all_records = vec![
            machine_records[0].clone(),
            rec(10_000.0, true, Some(262_144), None),
            rec(10_000.0, true, Some(262_144), None),
        ];
        let current = params(Some(1_048_576), None);
        let estimate = estimate_duration(&machine_records, &all_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 40_000);
    }

    #[test]
    fn no_params_anywhere_uses_existing_global_mean_behavior() {
        let all_records = vec![rec(10_000.0, true, None, None), rec(20_000.0, true, None, None)];
        let estimate = estimate_duration(&[], &all_records, None).unwrap();
        assert_eq!(estimate.as_millis(), 15_000);
    }

    #[test]
    fn zero_effort_record_is_skipped() {
        // length=Some(0) makes effort 0 for this record; only 1 valid record remains,
        // below MIN_RUNS, so the rate tier can't fire and it falls to plain average.
        let machine_records = vec![
            rec(10_000.0, true, Some(262_144), Some(0)),
            rec(20_000.0, true, Some(262_144), Some(16)),
        ];
        let current = params(Some(262_144), Some(16));
        let estimate = estimate_duration(&machine_records, &machine_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 15_000);
    }

    #[test]
    fn current_task_zero_effort_uses_plain_average() {
        let machine_records = vec![
            rec(10_000.0, true, Some(262_144), None),
            rec(20_000.0, true, Some(262_144), None),
        ];
        let current = params(Some(0), None);
        let estimate = estimate_duration(&machine_records, &machine_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 15_000);
    }

    #[test]
    fn median_is_robust_to_outliers() {
        // Rates: 10, 10, 1000 ms/px — median is 10, not the mean (~340).
        let records = vec![
            rec(10.0, true, Some(1), None),
            rec(10.0, true, Some(1), None),
            rec(1000.0, true, Some(1), None),
        ];
        let current = params(Some(1), None);
        let estimate = estimate_duration(&records, &records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 10);
    }

    #[test]
    fn failed_records_ignored_in_rate_tier() {
        let machine_records = vec![
            rec(10_000.0, true, Some(262_144), None),
            rec(10_000.0, true, Some(262_144), None),
            rec(1.0, false, Some(262_144), None),
        ];
        let current = params(Some(262_144), None);
        let estimate = estimate_duration(&machine_records, &machine_records, Some(&current)).unwrap();
        assert_eq!(estimate.as_millis(), 10_000);
    }

    #[test]
    fn no_data_returns_none() {
        assert_eq!(estimate_duration(&[], &[], None), None);
    }
}

