//! Reaping of `rm_after_task` buckets whose task is over.
//!
//! `rm_after_task` promises the bucket is deleted "as soon as the task that
//! references it reaches a terminal state". The agent-resolve path in
//! [`crate::api::agent::service`] honours that for the common case, but it is
//! only *one* of the ways a task ends: it can be cancelled while still queued,
//! time out unassigned, be failed by the stale-cancel sweep, or be orphaned when
//! its agent goes offline. None of those paths touches storage, so their input
//! buckets used to survive until the 24 h TTL purge — holding both bytes and a
//! slot against the per-key bucket cap.
//!
//! Rather than bolt a storage call onto every one of those transitions (and
//! every future one), this sweep re-derives the invariant from the task store:
//! an `rm_after_task` bucket whose recorded tasks have all finished — or no
//! longer exist at all — has nothing left to serve.
//!
//! Buckets with no recorded task are deliberately left alone: they were created
//! but never submitted, so no task can vouch for them either way, and the TTL
//! purge is the right owner. Same for anything younger than [`MIN_AGE`]: a
//! bucket is created, filled and only then submitted, so a young bucket may
//! legitimately have no task recorded yet.

use std::sync::Arc;

use chrono::Utc;
use log::{info, warn};

use crate::{schema::TaskId, state::AppState};

/// Grace period before a bucket is eligible. Comfortably longer than the
/// create → upload → submit sequence, and than the 60 s urgent-task TTL.
const MIN_AGE: chrono::TimeDelta = chrono::Duration::minutes(10);

#[derive(Debug, Default)]
pub struct SweepStats {
    pub deleted: usize,
    pub errors: usize,
}

/// Delete every `rm_after_task` bucket whose tasks have all reached a terminal
/// state. Errors are logged and counted, never propagated — this runs from a
/// background worker where the next pass retries anyway.
pub async fn sweep_spent_buckets(state: &Arc<AppState>) -> SweepStats {
    let mut stats = SweepStats::default();
    let cutoff = Utc::now() - MIN_AGE;

    for bucket in state.storage.buckets.list_all_buckets() {
        if !bucket.rm_after_task || bucket.tasks.is_empty() || bucket.created_at > cutoff {
            continue;
        }
        if !bucket.tasks.iter().all(|raw| task_is_over(state, raw)) {
            continue;
        }

        let mut ok = true;
        if let Err(e) = state.storage.file_store.delete_bucket(&bucket.uid).await {
            warn!("Spent-bucket sweep: failed to delete files of {}: {}", bucket.uid, e);
            ok = false;
        }
        if let Err(e) = state
            .storage
            .buckets
            .delete_bucket(&bucket.uid, &bucket.api_key)
            .await
        {
            warn!("Spent-bucket sweep: failed to delete metadata of {}: {}", bucket.uid, e);
            ok = false;
        }
        if ok {
            info!("Deleted spent rm_after_task bucket {}", bucket.uid);
            stats.deleted += 1;
        } else {
            stats.errors += 1;
        }
    }
    stats
}

/// Whether a task recorded on a bucket can still read from it.
///
/// A task that is missing from both trees is over too: it was archived, or it
/// was an urgent task that lived only in memory and has long since expired.
/// Anything we cannot make sense of (an unparseable id, a storage error) counts
/// as still running, so an unclear case never costs a live task its input.
fn task_is_over(state: &Arc<AppState>, raw: &str) -> bool {
    let Some(id) = parse_task_id(raw) else {
        warn!("Spent-bucket sweep: unparseable task id {raw:?} on a bucket");
        return false;
    };
    match state.storage.tasks.get_unassigned(&id) {
        Ok(Some(_)) => return false, // still queued
        Ok(None) => {}
        Err(e) => {
            warn!("Spent-bucket sweep: cannot read unassigned {id}: {e}");
            return false;
        }
    }
    match state.storage.tasks.get_assigned(&id) {
        Ok(Some(task)) => task.status.is_terminal(),
        Ok(None) => true,
        Err(e) => {
            warn!("Spent-bucket sweep: cannot read assigned {id}: {e}");
            false
        }
    }
}

/// Inverse of `TaskId`'s `Display` (`cap[id]`). The capability may itself
/// contain brackets (`imggen.flux[lora]`), so the split is on the *last* one.
fn parse_task_id(raw: &str) -> Option<TaskId> {
    let inner = raw.strip_suffix(']')?;
    let (cap, id) = inner.rsplit_once('[')?;
    if cap.is_empty() || id.is_empty() {
        return None;
    }
    Some(TaskId {
        cap: cap.to_string(),
        id: id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_display_writes() {
        let id = TaskId {
            cap: "img-utils.depth".into(),
            id: "01HXYZ".into(),
        };
        let parsed = parse_task_id(&id.to_string()).expect("round-trips");
        assert_eq!(parsed.cap, id.cap);
        assert_eq!(parsed.id, id.id);
    }

    #[test]
    fn splits_on_the_last_bracket_so_extended_caps_survive() {
        let id = TaskId {
            cap: "llm.qwen3:8b[vision;tools]".into(),
            id: "01HXYZ".into(),
        };
        let parsed = parse_task_id(&id.to_string()).expect("round-trips");
        assert_eq!(parsed.cap, "llm.qwen3:8b[vision;tools]");
        assert_eq!(parsed.id, "01HXYZ");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_task_id("").is_none());
        assert!(parse_task_id("no-brackets").is_none());
        assert!(parse_task_id("cap[]").is_none());
        assert!(parse_task_id("[id]").is_none());
    }
}
