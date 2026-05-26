use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sled::Db;

/// Severity level of an agent log record. Stored as a fixed-width prefix in the
/// Sled key so that prefix scans by severity are O(matching) and never require
/// a full table scan.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LogSeverity {
    Critical,
    Error,
    Info,
}

impl LogSeverity {
    /// 2-character prefix used in the storage key. Keys are sorted as bytes, so
    /// the prefix is opaque — its only job is to group records of the same
    /// severity together.
    pub fn key_prefix(&self) -> &'static str {
        match self {
            LogSeverity::Critical => "00",
            LogSeverity::Error => "10",
            LogSeverity::Info => "20",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            LogSeverity::Critical => "CRITICAL",
            LogSeverity::Error => "ERROR",
            LogSeverity::Info => "INFO",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_uppercase().as_str() {
            "CRITICAL" => Some(LogSeverity::Critical),
            "ERROR" => Some(LogSeverity::Error),
            "INFO" => Some(LogSeverity::Info),
            _ => None,
        }
    }

    pub fn all() -> [LogSeverity; 3] {
        [LogSeverity::Critical, LogSeverity::Error, LogSeverity::Info]
    }
}

/// A single log record sent by an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogRecord {
    pub record_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub machine_fingerprint: Option<String>,
    pub severity: LogSeverity,
    pub text: String,
    /// Server-assigned timestamp (set on ingest).
    pub timestamp: DateTime<Utc>,
}

/// Persistent agent log store backed by a dedicated Sled tree (`agent_logs`).
///
/// Key layout: `{severity_prefix}|{agent_id}|{record_id}`
/// - `severity_prefix` is a fixed 2-char tag (see [`LogSeverity::key_prefix`]).
/// - `record_id` is a time-sortable ULID, so within a severity+agent pair
///   records sort chronologically.
/// - Severity-first ordering enables fast severity scans; the agent_id segment
///   keeps records of the same agent contiguous, but agent-specific queries
///   currently iterate the full tree (one severity at a time would not be a
///   strict subset of any per-severity prefix because the agent_id is below).
pub struct AgentLogStorage {
    _db: Db,
    tree: sled::Tree,
}

impl AgentLogStorage {
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let tree = db.open_tree("agent_logs")?;
        Ok(Self { _db: db, tree })
    }

    fn build_key(severity: LogSeverity, agent_id: &str, record_id: &str) -> String {
        format!("{}|{}|{}", severity.key_prefix(), agent_id, record_id)
    }

    /// Append a new log record. Returns the stored record (with timestamp and
    /// record_id populated by the server).
    pub fn push(
        &self,
        agent_id: &str,
        agent_name: Option<String>,
        machine_fingerprint: Option<String>,
        severity: LogSeverity,
        text: String,
    ) -> Result<AgentLogRecord> {
        let record_id = crate::utils::time_sortable_uid();
        let record = AgentLogRecord {
            record_id: record_id.clone(),
            agent_id: agent_id.to_string(),
            agent_name,
            machine_fingerprint,
            severity,
            text,
            timestamp: Utc::now(),
        };
        let key = Self::build_key(severity, agent_id, &record_id);
        let bytes = rmp_serde::to_vec_named(&record)?;
        self.tree.insert(key.as_bytes(), bytes)?;
        Ok(record)
    }

    /// Decode a stored record from raw bytes, returning None if the value is
    /// corrupt rather than failing the whole scan.
    fn decode(value: &[u8]) -> Option<AgentLogRecord> {
        rmp_serde::from_slice(value).ok()
    }

    /// Apply the standard `limit` semantics:
    ///   - `Some(n)` with `n >= 0` → take `n`
    ///   - `Some(-1)` or `None` → return all
    fn apply_limit<I: Iterator<Item = AgentLogRecord>>(iter: I, limit: i64) -> Vec<AgentLogRecord> {
        if limit < 0 {
            iter.collect()
        } else {
            iter.take(limit as usize).collect()
        }
    }

    /// List logs for a given severity, newest first.
    pub fn list_by_severity(&self, severity: LogSeverity, limit: i64) -> Result<Vec<AgentLogRecord>> {
        let prefix = format!("{}|", severity.key_prefix());
        let iter = self
            .tree
            .scan_prefix(prefix.as_bytes())
            .rev()
            .filter_map(|item| item.ok())
            .filter_map(|(_, v)| Self::decode(&v));
        Ok(Self::apply_limit(iter, limit))
    }

    /// List logs for a specific agent across all severities, newest first.
    pub fn list_by_agent(&self, agent_id: &str, limit: i64) -> Result<Vec<AgentLogRecord>> {
        // Scan all severities; collect matching records, then sort by record_id
        // descending (ULID is lexicographically chronological).
        let mut collected: Vec<AgentLogRecord> = Vec::new();
        for severity in LogSeverity::all() {
            let prefix = format!("{}|{}|", severity.key_prefix(), agent_id);
            for item in self.tree.scan_prefix(prefix.as_bytes()).rev() {
                if let Ok((_, v)) = item {
                    if let Some(rec) = Self::decode(&v) {
                        collected.push(rec);
                    }
                }
            }
        }
        collected.sort_by(|a, b| b.record_id.cmp(&a.record_id));
        Ok(if limit < 0 {
            collected
        } else {
            collected.into_iter().take(limit as usize).collect()
        })
    }

    /// List the latest N logs across all agents and severities, newest first.
    pub fn list_latest(&self, limit: i64) -> Result<Vec<AgentLogRecord>> {
        // Same approach: merge per-severity reverse scans, then sort. Each
        // sub-iterator yields newest-first within its severity, so we can also
        // bound work when `limit` is small by taking limit+ from each severity.
        let take_per_severity = if limit < 0 { usize::MAX } else { limit as usize };
        let mut collected: Vec<AgentLogRecord> = Vec::new();
        for severity in LogSeverity::all() {
            let prefix = format!("{}|", severity.key_prefix());
            for item in self
                .tree
                .scan_prefix(prefix.as_bytes())
                .rev()
                .take(take_per_severity)
            {
                if let Ok((_, v)) = item {
                    if let Some(rec) = Self::decode(&v) {
                        collected.push(rec);
                    }
                }
            }
        }
        collected.sort_by(|a, b| b.record_id.cmp(&a.record_id));
        Ok(if limit < 0 {
            collected
        } else {
            collected.into_iter().take(limit as usize).collect()
        })
    }

    /// Delete records older than `max_age_days`. Returns the number of records
    /// deleted.
    pub fn cleanup_older_than(&self, max_age_days: i64) -> Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(max_age_days);
        let mut to_delete: Vec<Vec<u8>> = Vec::new();
        for item in self.tree.iter() {
            if let Ok((k, v)) = item {
                if let Some(rec) = Self::decode(&v) {
                    if rec.timestamp < cutoff {
                        to_delete.push(k.to_vec());
                    }
                }
            }
        }
        let n = to_delete.len();
        for k in to_delete {
            let _ = self.tree.remove(k);
        }
        Ok(n)
    }
}
