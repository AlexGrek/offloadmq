use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{
    config::StorageConfig,
    db::{
        agent::CachedAgentStorage,
        apikeys::ApiKeysStorage,
        bucket_storage::BucketStorage,
        persistent_task_storage::TaskStorage,
    },
    models::Agent,
    storage::FileStore,
};

// Composite storage for agents, tasks, keys, and file buckets
#[derive(Clone)]
pub struct AppStorage {
    pub agents: Arc<CachedAgentStorage>,
    pub tasks: Arc<TaskStorage>,
    pub client_keys: Arc<ApiKeysStorage>,
    pub buckets: Arc<BucketStorage>,
    pub file_store: Arc<FileStore>,
}

impl AppStorage {
    /// Create a new AppStorage with default TTL of 120 seconds
    pub fn new(base_path: &str, storage_config: &StorageConfig) -> anyhow::Result<Self> {
        Self::with_ttl(base_path, Duration::from_secs(120), storage_config)
    }

    pub fn with_ttl(
        base_path: &str,
        cache_ttl: Duration,
        storage_config: &StorageConfig,
    ) -> anyhow::Result<Self> {
        let mut agents_path = PathBuf::from(base_path);
        agents_path.push("agents");

        let mut tasks_path = PathBuf::from(base_path);
        tasks_path.push("tasks");

        let mut client_keys_path = PathBuf::from(base_path);
        client_keys_path.push("client_api_keys");

        let mut buckets_path = PathBuf::from(base_path);
        buckets_path.push("buckets");

        // Create base directory
        std::fs::create_dir_all(base_path)?;

        let agents = Arc::new(CachedAgentStorage::new(
            agents_path.to_str().unwrap(),
            cache_ttl,
            cache_ttl,
        )?);

        let tasks = Arc::new(TaskStorage::open(tasks_path.to_str().unwrap())?);
        let client_keys = Arc::new(ApiKeysStorage::open(client_keys_path.to_str().unwrap())?);
        let buckets = Arc::new(BucketStorage::open(buckets_path.to_str().unwrap())?);
        let file_store = Arc::new(FileStore::new(storage_config)?);

        Ok(Self {
            agents,
            tasks,
            client_keys,
            buckets,
            file_store,
        })
    }

    /// Get cache statistics for agents
    pub fn get_agent_cache_stats(&self) -> (usize, usize) {
        let agent_count = self.agents.agent_cache.read().unwrap().len();
        let token_count = self.agents.token_cache.read().unwrap().len();
        (agent_count, token_count)
    }

    /// Cleanup expired entries from caches
    pub fn cleanup_expired(&self) {
        self.agents.agent_cache.write().unwrap().iter();
        self.agents.token_cache.write().unwrap().iter();
    }
}

// Convenience methods that delegate to the underlying storages
impl AppStorage {
    pub fn create_agent(&self, agent: &mut Agent) -> sled::Result<()> {
        self.agents.create_agent(agent)
    }

    pub fn get_agent(&self, id: &str) -> Option<Agent> {
        self.agents.get_agent(id)
    }

    pub fn update_agent(&self, agent: Agent) -> sled::Result<()> {
        self.agents.update_agent(agent)
    }

    pub fn delete_agent(&self, id: &str) -> sled::Result<()> {
        self.agents.delete_agent(id)
    }
}
