use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sled::Db;

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
        let db = sled::open(path)?;
        let tree = db.open_tree("service_messages")?;
        Ok(Self { _db: db, tree })
    }

    /// Append a new message. record_id is generated automatically.
    pub fn push(&self, class: &str, kind: &str, content: Value) -> Result<()> {
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
        Ok(())
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
}
