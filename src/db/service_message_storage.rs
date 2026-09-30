use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sled::Db;

/// Keys deleted per round by the retention sweep (bounds its memory use).
const CLEANUP_BATCH: usize = 1000;

/// A service/system message stored in the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMessage {
    pub message_class: String,
    pub message_kind: String,
    pub timestamp: DateTime<Utc>,
    /// Time-sortable UID — also the last component of the storage key
    pub record_id: String,
    pub message_content: Value,
}

/// Persistent log of internal service messages.
///
/// Key format: `{message_class}|{record_id}` (record_id is time-sortable)
/// This enables efficient prefix-based range scans by class.
/// message_kind is stored only in the value — not indexed.
pub struct ServiceMessageStorage {
    _db: Db,
    tree: sled::Tree,
}

impl ServiceMessageStorage {
    pub fn open(path: &str) -> Result<Self> {
        let db = crate::db::open_sled(path)?;
        let tree = db.open_tree("service_messages")?;
        Ok(Self { _db: db, tree })
    }

    /// Append a new message. record_id is generated automatically.
    pub fn push(&self, class: &str, kind: &str, content: Value) -> Result<ServiceMessage> {
        let record_id = crate::utils::time_sortable_uid();
        let msg = ServiceMessage {
            message_class: class.to_string(),
            message_kind: kind.to_string(),
            timestamp: Utc::now(),
            record_id: record_id.clone(),
            message_content: content,
        };
        let key = format!("{}|{}", class, record_id);
        let bytes = rmp_serde::to_vec_named(&msg)?;
        self.tree.insert(key.as_bytes(), bytes)?;
        Ok(msg)
    }

    /// List messages for a class, newest first, with cursor-based pagination.
    ///
    /// - `limit`: max items to return
    /// - `cursor`: the `record_id` of the last item from the previous page (exclusive).
    ///   Pass `None` for the first page.
    ///
    /// Returns `(items, next_cursor)` where `next_cursor` is `Some(record_id)` when
    /// there may be more items, or `None` when the last page has been reached.
    pub fn list_by_class(
        &self,
        class: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<(Vec<ServiceMessage>, Option<String>)> {
        let prefix = format!("{}|", class);

        let items: Vec<ServiceMessage> = match cursor {
            // With cursor: return items older than the cursor key (exclusive upper bound)
            Some(c) => {
                let end_key = format!("{}|{}", class, c);
                self.tree
                    .range(prefix.as_bytes()..end_key.as_bytes())
                    .rev()
                    .take(limit + 1)
                    .filter_map(|item| item.ok())
                    .filter_map(|(_, v)| rmp_serde::from_slice(&v).ok())
                    .collect()
            }
            // First page: all items for this class, newest first
            None => self
                .tree
                .scan_prefix(prefix.as_bytes())
                .rev()
                .take(limit + 1)
                .filter_map(|item| item.ok())
                .filter_map(|(_, v)| rmp_serde::from_slice(&v).ok())
                .collect(),
        };

        // If we got limit+1 items there is a next page; return the last item's record_id as cursor
        let next_cursor = if items.len() > limit {
            items.get(limit).map(|m| m.record_id.clone())
        } else {
            None
        };

        Ok((items.into_iter().take(limit).collect(), next_cursor))
    }

    /// Delete messages older than `max_age_days`. Streams the tree and deletes
    /// in bounded batches — the tree can hold hundreds of thousands of rows, so
    /// keys are never all collected. Undecodable rows are left alone. Returns
    /// the number of messages deleted.
    pub fn cleanup_older_than(&self, max_age_days: i64) -> Result<usize> {
        self.cleanup_in_batches(max_age_days, CLEANUP_BATCH)
    }

    fn cleanup_in_batches(&self, max_age_days: i64, batch_size: usize) -> Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(max_age_days);
        let mut deleted = 0;
        let mut batch: Vec<sled::IVec> = Vec::with_capacity(batch_size);

        for item in self.tree.iter() {
            let (k, v) = item?;
            let Ok(msg) = rmp_serde::from_slice::<ServiceMessage>(&v) else {
                continue;
            };
            if msg.timestamp < cutoff {
                batch.push(k);
                if batch.len() >= batch_size {
                    deleted += self.flush_delete_batch(&mut batch)?;
                }
            }
        }
        deleted += self.flush_delete_batch(&mut batch)?;
        Ok(deleted)
    }

    fn flush_delete_batch(&self, batch: &mut Vec<sled::IVec>) -> Result<usize> {
        let n = batch.len();
        for k in batch.drain(..) {
            self.tree.remove(&k)?;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDirGuard(std::path::PathBuf);

    impl TempDirGuard {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "offloadmq-svcmsg-test-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn storage() -> (ServiceMessageStorage, TempDirGuard) {
        let guard = TempDirGuard::new();
        let store = ServiceMessageStorage::open(guard.0.to_str().unwrap()).expect("open");
        (store, guard)
    }

    /// Insert a message stamped `age_days` ago.
    fn put(store: &ServiceMessageStorage, id: &str, age_days: i64) {
        let msg = ServiceMessage {
            message_class: "bg".into(),
            message_kind: "test".into(),
            timestamp: Utc::now() - chrono::Duration::days(age_days),
            record_id: id.into(),
            message_content: json!({}),
        };
        store
            .tree
            .insert(
                format!("bg|{id}").as_bytes(),
                rmp_serde::to_vec_named(&msg).unwrap(),
            )
            .unwrap();
    }

    #[test]
    fn cleanup_deletes_only_messages_past_ttl() {
        let (store, _guard) = storage();
        put(&store, "a-old", 45);
        put(&store, "b-new", 5);
        store.push("bg", "fresh", json!({})).unwrap();

        assert_eq!(store.cleanup_older_than(30).unwrap(), 1);
        assert_eq!(store.tree.len(), 2);
        assert_eq!(store.cleanup_older_than(30).unwrap(), 0);
    }

    #[test]
    fn cleanup_drains_more_than_one_batch() {
        let (store, _guard) = storage();
        for i in 0..25 {
            put(&store, &format!("old-{i:02}"), 90);
        }
        put(&store, "keep", 1);

        assert_eq!(store.cleanup_in_batches(30, 4).unwrap(), 25);
        assert_eq!(store.tree.len(), 1);
    }
}
