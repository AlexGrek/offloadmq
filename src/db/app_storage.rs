use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{db::{
    agent::CachedAgentStorage, apikeys::ApiKeysStorage, persistent_task_storage::TaskStorage
}, models::Agent};

// Composite storage for both agents and tasks
#[derive(Clone)]
pub struct AppStorage {
    pub agents: Arc<CachedAgentStorage>,
    pub tasks: Arc<TaskStorage>,
    pub client_keys: Arc<ApiKeysStorage>
}

impl AppStorage {
    /// Create a new AppStorage with default TTL of 120 seconds
    /// Takes a base path and creates "/agents" and "/tasks" subdirectories
    pub fn new(base_path: &str) -> anyhow::Result<Self> {
        Self::with_ttl(base_path, Duration::from_secs(120))
    }

    /// Create a new AppStorage with custom TTL for agent cache
    /// Token cache TTL will be the same as agent cache TTL
    pub fn with_ttl(base_path: &str, cache_ttl: Duration) -> anyhow::Result<Self> {
        let mut agents_path = PathBuf::from(base_path);
        agents_path.push("agents");

        let mut tasks_path = PathBuf::from(base_path);
        tasks_path.push("tasks");

        let mut client_keys_path = PathBuf::from(base_path);
        client_keys_path.push("client_api_keys");

        // Create directories if they don't exist
        if let Some(parent) = agents_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                sled::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create agents directory: {}", e),
                ))
            })?;
        }

        if let Some(parent) = tasks_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                sled::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create tasks directory: {}", e),
                ))
            })?;
        }

        let agents = Arc::new(CachedAgentStorage::new(
            agents_path.to_str().unwrap(),
            cache_ttl,
            cache_ttl, // Same TTL for token cache
        )?);

        let tasks = Arc::new(TaskStorage::open(tasks_path.to_str().unwrap())?);
        let client_keys = Arc::new(ApiKeysStorage::open(client_keys_path.to_str().unwrap())?);

        Ok(Self { agents, tasks, client_keys })
    }

    /// Get cache statistics for agents
    pub fn get_agent_cache_stats(&self) -> (usize, usize) {
        let agent_count = self.agents.agent_cache.read().unwrap().len();
        let token_count = self.agents.token_cache.read().unwrap().len();
        (agent_count, token_count)
    }

    /// Cleanup expired entries from caches
    pub fn cleanup_expired(&self) {
        self.agents.agent_cache.write().unwrap().iter(); // Triggers internal cleanup
        self.agents.token_cache.write().unwrap().iter(); // Triggers internal cleanup
    }
}

// Convenience methods that delegate to the underlying storages
impl AppStorage {
    // Agent methods
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
