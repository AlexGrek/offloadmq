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
/// Maintains two redundant Sled trees for efficient querying:
/// 1. `heuristics_by_cap` — key: "capability|runner_id|record_id"
///    Fast for: finding all tasks for a capability, or capability+runner
/// 2. `heuristics_by_runner` — key: "runner_id|capability|record_id"
///    Fast for: finding all tasks executed by a specific runner
///
/// Both trees store identical data (the full HeuristicRecord); the key difference
/// is the order of components for efficient prefix-based range queries.
pub struct HeuristicStorage {
    _db: Db,
    heuristics_by_cap: sled::Tree,
    heuristics_by_runner: sled::Tree,
}

impl HeuristicStorage {
    /// Open or create heuristic storage at the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let heuristics_by_cap = db.open_tree("heuristics_by_cap")?;
        let heuristics_by_runner = db.open_tree("heuristics_by_runner")?;

        Ok(Self {
            _db: db,
            heuristics_by_cap,
            heuristics_by_runner,
        })
    }

    /// Record a completed non-urgent task for heuristic analysis
    /// Writes to both index trees for redundancy and query performance
    pub fn log_task_completion(&self, record: &HeuristicRecord) -> Result<()> {
        let bytes = rmp_serde::to_vec_named(record)?;

        // Write to capability index: "capability|runner_id|record_id"
        let cap_key = record.make_key();
        self.heuristics_by_cap.insert(cap_key.as_bytes(), bytes.clone())?;

        // Write to runner index: "runner_id|capability|record_id"
        let runner_key = format!("{}|{}|{}", record.runner_id, record.capability, record.record_id);
        self.heuristics_by_runner.insert(runner_key.as_bytes(), bytes)?;

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

    // ========== Cleanup Operations ==========

    /// Delete a heuristic record by its composite keys
    /// Removes from both index trees to maintain consistency
    fn delete_record(&self, cap_key: &str, runner_key: &str) -> Result<()> {
        self.heuristics_by_cap.remove(cap_key.as_bytes())?;
        self.heuristics_by_runner.remove(runner_key.as_bytes())?;
        Ok(())
    }

    /// Clean up heuristic records:
    /// 1. Delete records older than the specified TTL
    /// 2. For each (runner, capability) pair, keep only the most recent max_records records
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
                ));
            }
        }

        for (cap_key, runner_key) in keys_to_delete {
            self.delete_record(&cap_key, &runner_key)?;
            deleted_by_age += 1;
        }

        // Delete by limit: for each (runner, capability), keep only the newest max_records
        let mut runner_cap_records: HashMap<(String, String), Vec<(String, String, HeuristicRecord)>> =
            HashMap::new();

        // Collect all records grouped by (runner, capability)
        for item in self.heuristics_by_cap.iter() {
            let (key, bytes) = item?;
            let record: HeuristicRecord = rmp_serde::from_slice(&bytes)?;
            let cap_key = String::from_utf8_lossy(&key).to_string();
            let runner_key = format!("{}|{}|{}", record.runner_id, record.capability, record.record_id);
            let key_tuple = (record.runner_id.clone(), record.capability.clone());

            runner_cap_records
                .entry(key_tuple)
                .or_insert_with(Vec::new)
                .push((cap_key, runner_key, record));
        }

        // For each (runner, capability) pair with too many records, delete oldest ones
        for (_, mut records) in runner_cap_records {
            if records.len() > max_records_per_runner_cap as usize {
                // Sort by record_id (time-sortable, ascending = oldest first)
                records.sort_by(|a, b| a.2.record_id.cmp(&b.2.record_id));

                // Delete the oldest records to keep only max_records
                let to_delete_count = records.len() - max_records_per_runner_cap as usize;
                for (cap_key, runner_key, _) in records.iter().take(to_delete_count) {
                    self.delete_record(cap_key, runner_key)?;
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
