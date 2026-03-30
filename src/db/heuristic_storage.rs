use anyhow::Result;
use chrono::{Duration, Utc};
use sled::Db;
use std::collections::HashMap;

use crate::mq::heuristic::HeuristicRecord;

/// Execution statistics for a specific (runner, capability) pair
pub struct RunnerCapStats {
    pub total_runs: usize,
    pub success_count: usize,
    pub fail_count: usize,
    /// Fraction 0.0–100.0
    pub success_pct: f64,
    // Successful runs timing (None when success_count == 0)
    pub success_avg_ms: Option<f64>,
    pub success_min_ms: Option<f64>,
    pub success_max_ms: Option<f64>,
    // Failed runs timing (None when fail_count == 0)
    pub fail_avg_ms: Option<f64>,
    pub fail_min_ms: Option<f64>,
    pub fail_max_ms: Option<f64>,
}

/// Persistent storage for heuristic data (non-urgent tasks only)
///
/// Maintains three Sled trees for efficient querying:
/// 1. `heuristics_by_cap` — key: "capability|runner_id|record_id"
///    Fast for: finding all tasks for a capability, or capability+runner
/// 2. `heuristics_by_runner` — key: "runner_id|capability|record_id"
///    Fast for: finding all tasks executed by a specific runner
/// 3. `heuristics_by_machine` — key: "machine_id|capability|record_id"
///    Fast for: finding all tasks across all agents sharing the same physical machine
///    Machine-level stats aggregate across agent IDs — useful because same-spec machines
///    share performance characteristics regardless of which agent instance ran the task.
///    Only populated when the agent reports a machine_id.
///
/// All trees store identical data (the full HeuristicRecord); the key difference
/// is the order of components for efficient prefix-based range queries.
pub struct HeuristicStorage {
    _db: Db,
    heuristics_by_cap: sled::Tree,
    heuristics_by_runner: sled::Tree,
    heuristics_by_machine: sled::Tree,
}

impl HeuristicStorage {
    /// Open or create heuristic storage at the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let heuristics_by_cap = db.open_tree("heuristics_by_cap")?;
        let heuristics_by_runner = db.open_tree("heuristics_by_runner")?;
        let heuristics_by_machine = db.open_tree("heuristics_by_machine")?;

        Ok(Self {
            _db: db,
            heuristics_by_cap,
            heuristics_by_runner,
            heuristics_by_machine,
        })
    }

    /// Record a completed non-urgent task for heuristic analysis
    /// Writes to all three index trees. The machine tree is only populated when
    /// the agent reports a machine_id.
    pub fn log_task_completion(&self, record: &HeuristicRecord) -> Result<()> {
        let bytes = rmp_serde::to_vec_named(record)?;

        // Write to capability index: "capability|runner_id|record_id"
        let cap_key = record.make_key();
        self.heuristics_by_cap.insert(cap_key.as_bytes(), bytes.clone())?;

        // Write to runner index: "runner_id|capability|record_id"
        let runner_key = format!("{}|{}|{}", record.runner_id, record.capability, record.record_id);
        self.heuristics_by_runner.insert(runner_key.as_bytes(), bytes.clone())?;

        // Write to machine index: "machine_id|capability|record_id" (only if machine_id present)
        if let Some(machine_key) = record.make_machine_key() {
            self.heuristics_by_machine.insert(machine_key.as_bytes(), bytes)?;
        }

        Ok(())
    }

    // ========== Queries by Capability ==========

    /// Query heuristics for a specific capability
    /// Returns records sorted by runner_id and record_id
    pub fn query_by_capability(&self, capability: &str) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|", capability);

        for item in self.heuristics_by_cap.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    /// Query heuristics for a specific capability and runner
    /// Returns records sorted by record_id (time-sortable)
    pub fn query_by_capability_and_runner(
        &self,
        capability: &str,
        runner_id: &str,
    ) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|{}|", capability, runner_id);

        for item in self.heuristics_by_cap.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    // ========== Queries by Runner ==========

    /// Query all tasks executed by a specific runner across all capabilities
    /// Returns records sorted by capability and record_id
    pub fn query_by_runner(&self, runner_id: &str) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|", runner_id);

        for item in self.heuristics_by_runner.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    /// Query all tasks executed by a specific runner on a specific capability
    /// Returns records sorted by record_id (time-sortable)
    pub fn query_by_runner_and_capability(
        &self,
        runner_id: &str,
        capability: &str,
    ) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|{}|", runner_id, capability);

        for item in self.heuristics_by_runner.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    // ========== Full Dataset ==========

    /// Get all heuristic records (use with caution on large datasets)
    pub fn list_all(&self) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];

        for item in self.heuristics_by_cap.iter() {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    // ========== Queries by Machine ID ==========

    /// Query heuristics for a specific machine across all capabilities
    /// Returns records sorted by capability and record_id
    pub fn query_by_machine(&self, machine_id: &str) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|", machine_id);

        for item in self.heuristics_by_machine.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    /// Query heuristics for a specific machine and capability
    /// Returns records sorted by record_id (time-sortable)
    pub fn query_by_machine_and_capability(
        &self,
        machine_id: &str,
        capability: &str,
    ) -> Result<Vec<HeuristicRecord>> {
        let mut results = vec![];
        let prefix = format!("{}|{}|", machine_id, capability);

        for item in self.heuristics_by_machine.scan_prefix(prefix.as_bytes()) {
            let (_, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            results.push(record);
        }

        Ok(results)
    }

    // ========== Cleanup Operations ==========

    /// Delete a heuristic record by its composite keys across all three index trees
    fn delete_record(&self, cap_key: &str, runner_key: &str, machine_key: Option<&str>) -> Result<()> {
        self.heuristics_by_cap.remove(cap_key.as_bytes())?;
        self.heuristics_by_runner.remove(runner_key.as_bytes())?;
        if let Some(mk) = machine_key {
            self.heuristics_by_machine.remove(mk.as_bytes())?;
        }
        Ok(())
    }

    /// Clean up heuristic records:
    /// 1. Delete records older than the specified TTL
    /// 2. For each (runner, capability) pair, keep only the most recent max_records records
    /// 3. For each (machine, capability) pair, keep only the most recent max_records records
    pub fn cleanup(&self, ttl_days: u32, max_records_per_runner_cap: u32) -> Result<(usize, usize)> {
        let cutoff_date = Utc::now() - Duration::days(ttl_days as i64);
        let mut deleted_by_age = 0;
        let mut deleted_by_limit = 0;

        // Delete by age: records older than TTL
        let mut keys_to_delete = vec![];
        for item in self.heuristics_by_cap.iter() {
            let (key, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            if record.completed_at < cutoff_date {
                keys_to_delete.push((
                    String::from_utf8_lossy(&key).to_string(),
                    format!("{}|{}|{}", record.runner_id, record.capability, record.record_id),
                    record.make_machine_key(),
                ));
            }
        }

        for (cap_key, runner_key, machine_key) in keys_to_delete {
            self.delete_record(&cap_key, &runner_key, machine_key.as_deref())?;
            deleted_by_age += 1;
        }

        // Delete by limit (runner): for each (runner, capability), keep only the newest max_records
        let mut runner_cap_records: HashMap<(String, String), Vec<(String, String, Option<String>, HeuristicRecord)>> =
            HashMap::new();

        for item in self.heuristics_by_cap.iter() {
            let (key, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            let cap_key = String::from_utf8_lossy(&key).to_string();
            let runner_key = format!("{}|{}|{}", record.runner_id, record.capability, record.record_id);
            let machine_key = record.make_machine_key();
            let key_tuple = (record.runner_id.clone(), record.capability.clone());

            runner_cap_records
                .entry(key_tuple)
                .or_insert_with(Vec::new)
                .push((cap_key, runner_key, machine_key, record));
        }

        for (_, mut records) in runner_cap_records {
            if records.len() > max_records_per_runner_cap as usize {
                records.sort_by(|a, b| a.3.record_id.cmp(&b.3.record_id));
                let to_delete_count = records.len() - max_records_per_runner_cap as usize;
                for (cap_key, runner_key, machine_key, _) in records.iter().take(to_delete_count) {
                    self.delete_record(cap_key, runner_key, machine_key.as_deref())?;
                    deleted_by_limit += 1;
                }
            }
        }

        // Delete by limit (machine): for each (machine, capability), keep only the newest max_records
        // This prevents unbounded growth in the machine index when many agents share a machine.
        let mut machine_cap_records: HashMap<(String, String), Vec<(String, HeuristicRecord)>> =
            HashMap::new();

        for item in self.heuristics_by_machine.iter() {
            let (key, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            let machine_key = String::from_utf8_lossy(&key).to_string();
            if let Some(mid) = &record.machine_id {
                machine_cap_records
                    .entry((mid.clone(), record.capability.clone()))
                    .or_insert_with(Vec::new)
                    .push((machine_key, record));
            }
        }

        for (_, mut records) in machine_cap_records {
            if records.len() > max_records_per_runner_cap as usize {
                records.sort_by(|a, b| a.1.record_id.cmp(&b.1.record_id));
                let to_delete_count = records.len() - max_records_per_runner_cap as usize;
                for (machine_key, _) in records.iter().take(to_delete_count) {
                    // Only remove from machine index — the cap/runner trees enforce their own limits above
                    self.heuristics_by_machine.remove(machine_key.as_bytes())?;
                    deleted_by_limit += 1;
                }
            }
        }

        Ok((deleted_by_age, deleted_by_limit))
    }

    /// Compute execution statistics for a specific (runner, capability) pair.
    /// Returns `None` when there are no records for this pair yet.
    pub fn compute_stats_for(
        &self,
        runner_id: &str,
        capability: &str,
    ) -> Result<Option<RunnerCapStats>> {
        let records = self.query_by_runner_and_capability(runner_id, capability)?;
        if records.is_empty() {
            return Ok(None);
        }

        let mut success_times: Vec<f64> = Vec::new();
        let mut fail_times: Vec<f64> = Vec::new();

        for r in &records {
            if r.success {
                success_times.push(r.execution_time_ms);
            } else {
                fail_times.push(r.execution_time_ms);
            }
        }

        let avg_min_max = |times: &[f64]| -> (f64, f64, f64) {
            let sum: f64 = times.iter().sum();
            let avg = sum / times.len() as f64;
            let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
            let max = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            (avg, min, max)
        };

        let total = records.len();
        let success_count = success_times.len();
        let fail_count = fail_times.len();
        let success_pct = success_count as f64 / total as f64 * 100.0;

        let (success_avg_ms, success_min_ms, success_max_ms) = if !success_times.is_empty() {
            let (avg, min, max) = avg_min_max(&success_times);
            (Some(avg), Some(min), Some(max))
        } else {
            (None, None, None)
        };

        let (fail_avg_ms, fail_min_ms, fail_max_ms) = if !fail_times.is_empty() {
            let (avg, min, max) = avg_min_max(&fail_times);
            (Some(avg), Some(min), Some(max))
        } else {
            (None, None, None)
        };

        Ok(Some(RunnerCapStats {
            total_runs: total,
            success_count,
            fail_count,
            success_pct,
            success_avg_ms,
            success_min_ms,
            success_max_ms,
            fail_avg_ms,
            fail_min_ms,
            fail_max_ms,
        }))
    }
}
