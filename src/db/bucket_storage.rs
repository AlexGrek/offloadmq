use chrono::{DateTime, Utc};
use rmp_serde::{from_slice, to_vec_named};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileMeta {
    pub uid: String,
    pub original_name: String,
    pub size: u64,
    /// SHA-256 hex digest, computed at upload time.
    pub sha256: String,
    pub uploaded_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BucketMeta {
    pub uid: String,
    /// The API key that owns this bucket.
    pub api_key: String,
    pub created_at: DateTime<Utc>,
    pub files: Vec<FileMeta>,
    pub used_bytes: u64,
    /// IDs of tasks that reference this bucket (recorded at submission time).
    #[serde(default)]
    pub tasks: Vec<String>,
    /// When true the bucket is deleted automatically as soon as the task that
    /// references it reaches a terminal state (Completed or Failed).  Any
    /// subsequent task submission that tries to reference an already-used
    /// rm_after_task bucket is rejected.
    #[serde(default)]
    pub rm_after_task: bool,
}

pub struct BucketStorage {
    _db: sled::Db,
    /// key: bucket_uid  →  value: msgpack(BucketMeta)
    buckets: sled::Tree,
    /// key: "{api_key}|{bucket_uid}"  →  value: bucket_uid bytes  (owner index)
    owner_idx: sled::Tree,
}

impl BucketStorage {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        let db = sled::open(path)?;
        let buckets = db.open_tree("buckets")?;
        let owner_idx = db.open_tree("owner_idx")?;
        Ok(Self {
            _db: db,
            buckets,
            owner_idx,
        })
    }

    // ── bucket CRUD ──────────────────────────────────────────────────────────

    pub fn create_bucket(&self, api_key: &str, rm_after_task: bool) -> anyhow::Result<BucketMeta> {
        let uid = uuid::Uuid::new_v4().to_string();
        let meta = BucketMeta {
            uid: uid.clone(),
            api_key: api_key.to_string(),
            created_at: Utc::now(),
            files: vec![],
            used_bytes: 0,
            tasks: vec![],
            rm_after_task,
        };
        self.save_bucket(&meta)?;
        let idx_key = format!("{}|{}", api_key, uid);
        self.owner_idx
            .insert(idx_key.as_bytes(), uid.as_bytes())?;
        self.owner_idx.flush()?;
        Ok(meta)
    }

    pub fn get_bucket(&self, bucket_uid: &str) -> anyhow::Result<Option<BucketMeta>> {
        match self.buckets.get(bucket_uid.as_bytes())? {
            Some(data) => Ok(Some(from_slice(&data)?)),
            None => Ok(None),
        }
    }

    pub fn save_bucket(&self, meta: &BucketMeta) -> anyhow::Result<()> {
        let data = to_vec_named(meta)?;
        self.buckets.insert(meta.uid.as_bytes(), data)?;
        self.buckets.flush()?;
        Ok(())
    }

    pub fn delete_bucket(&self, bucket_uid: &str, api_key: &str) -> anyhow::Result<()> {
        self.buckets.remove(bucket_uid.as_bytes())?;
        let idx_key = format!("{}|{}", api_key, bucket_uid);
        self.owner_idx.remove(idx_key.as_bytes())?;
        self.buckets.flush()?;
        self.owner_idx.flush()?;
        Ok(())
    }

    /// Append `task_id` to the bucket's task list (idempotent; no-op if already present).
    pub fn add_task(&self, bucket_uid: &str, task_id: &str) -> anyhow::Result<()> {
        if let Some(mut meta) = self.get_bucket(bucket_uid)? {
            if !meta.tasks.iter().any(|t| t == task_id) {
                meta.tasks.push(task_id.to_string());
                self.save_bucket(&meta)?;
            }
        }
        Ok(())
    }

    // ── ownership queries ─────────────────────────────────────────────────────

    pub fn count_buckets_for_key(&self, api_key: &str) -> usize {
        let prefix = format!("{}|", api_key);
        self.owner_idx
            .scan_prefix(prefix.as_bytes())
            .count()
    }

    pub fn list_buckets_for_key(&self, api_key: &str) -> Vec<BucketMeta> {
        let prefix = format!("{}|", api_key);
        self.owner_idx
            .scan_prefix(prefix.as_bytes())
            .filter_map(|item| {
                let (_, v) = item.ok()?;
                let uid = String::from_utf8(v.to_vec()).ok()?;
                self.get_bucket(&uid).ok().flatten()
            })
            .collect()
    }

    // ── TTL / cleanup ─────────────────────────────────────────────────────────

    /// Returns all buckets whose `created_at` is older than `ttl_minutes`.
    pub fn list_expired_buckets(&self, ttl_minutes: u64) -> Vec<BucketMeta> {
        let cutoff = Utc::now() - chrono::Duration::minutes(ttl_minutes as i64);
        self.buckets
            .iter()
            .filter_map(|item| {
                let (_, v) = item.ok()?;
                let meta: BucketMeta = from_slice(&v).ok()?;
                if meta.created_at < cutoff { Some(meta) } else { None }
            })
            .collect()
    }

    pub fn list_all_buckets(&self) -> Vec<BucketMeta> {
        self.buckets
            .iter()
            .filter_map(|item| {
                let (_, v) = item.ok()?;
                from_slice(&v).ok()
            })
            .collect()
    }
}
