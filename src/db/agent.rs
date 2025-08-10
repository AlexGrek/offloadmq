use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use crate::{models::Agent, schema::SystemInfo};
use chrono::{DateTime, Utc};
use lru_time_cache::LruCache;
use rmp_serde::{from_slice, to_vec_named};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub struct CachedAgentStorage {
    pub db: sled::Db,
    pub agent_cache: Arc<RwLock<LruCache<String, Agent>>>,
    pub token_cache: Arc<RwLock<LruCache<String, ()>>>,
}

impl CachedAgentStorage {
    pub fn new(
        path: &str,
        agent_cache_ttl: Duration,
        token_cache_ttl: Duration,
    ) -> sled::Result<Self> {
        let db = sled::open(path)?;

        // Create LRU caches with time-based eviction
        let agent_cache = Arc::new(RwLock::new(LruCache::with_expiry_duration(agent_cache_ttl)));
        let token_cache = Arc::new(RwLock::new(LruCache::with_expiry_duration(token_cache_ttl)));

        // Populate agent cache from sled on init
        for item in db.iter() {
            let (k, v) = item?;
            if let Ok(agent) = from_slice::<Agent>(&v) {
                if let Ok(id) = String::from_utf8(k.to_vec()) {
                    agent_cache.write().unwrap().insert(id, agent);
                }
            }
        }

        Ok(Self {
            db,
            agent_cache,
            token_cache,
        })
    }

    // Generate UUID with collision detection
    fn generate_unique_uid(&self) -> String {
        loop {
            let uid = Uuid::new_v4().to_string();

            // Check both cache and database for collision
            if self.agent_cache.read().unwrap().peek(&uid).is_none()
                && !self.db.contains_key(uid.as_bytes()).unwrap_or(false)
            {
                return uid;
            }

            // Collision detected, generate new UUID
            eprintln!("UUID collision detected for {}, generating new one", uid);
        }
    }

    // CRUD for agents

    pub fn create_agent(&self, agent: &mut Agent) -> sled::Result<()> {
        // Generate unique UID if not provided or if collision exists
        if agent.uid.is_empty() || self.get_agent(&agent.uid).is_some() {
            agent.uid = self.generate_unique_uid();
            agent.uid_short = agent.uid.chars().take(8).collect();
        }

        let id = agent.uid.clone();
        let data = to_vec_named(&agent).map_err(|e| {
            sled::Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Serialization error: {}", e),
            ))
        })?;

        self.db.insert(id.as_bytes(), data)?;
        self.db.flush()?;

        self.agent_cache.write().unwrap().insert(id, agent.clone());
        Ok(())
    }

    pub fn get_agent(&self, id: &str) -> Option<Agent> {
        // First check cache
        if let Some(agent) = self.agent_cache.write().unwrap().get(id) {
            return Some(agent.clone());
        }

        // If not in cache, check database and update cache
        if let Ok(Some(data)) = self.db.get(id.as_bytes()) {
            if let Ok(agent) = from_slice::<Agent>(&data) {
                self.agent_cache
                    .write()
                    .unwrap()
                    .insert(id.to_string(), agent.clone());
                return Some(agent);
            }
        }

        None
    }

    pub fn update_agent(&self, agent: Agent) -> sled::Result<()> {
        let id = agent.uid.clone();

        // Verify agent exists
        if self.get_agent(&id).is_none() {
            return Err(sled::Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("Agent {} not found", id),
            )));
        }

        let data = to_vec_named(&agent).map_err(|e| {
            sled::Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Serialization error: {}", e),
            ))
        })?;

        self.db.insert(id.as_bytes(), data)?;
        self.db.flush()?;

        self.agent_cache.write().unwrap().insert(id, agent);
        Ok(())
    }

    pub fn delete_agent(&self, id: &str) -> sled::Result<()> {
        self.db.remove(id.as_bytes())?;
        self.db.flush()?;

        self.agent_cache.write().unwrap().remove(id);
        Ok(())
    }

    pub fn list_all_agents(&self) -> Vec<Agent> {
        let mut agents = Vec::new();

        // Get all agents from database (cache might not have all due to TTL)
        for item in self.db.iter() {
            if let Ok((_, v)) = item {
                if let Ok(agent) = from_slice::<Agent>(&v) {
                    agents.push(agent);
                }
            }
        }

        agents
    }

    // Token handling with LRU cache

    pub fn has_token(&self, token: &str) -> bool {
        self.token_cache.read().unwrap().peek(token).is_some()
    }

    pub fn insert_token(&self, token: String) {
        self.token_cache.write().unwrap().insert(token, ());
    }

    pub fn remove_token(&self, token: &str) {
        self.token_cache.write().unwrap().remove(token);
    }

    pub fn cleanup_expired(&self) {
        // LruCache automatically handles expiry, but we can manually trigger cleanup
        self.agent_cache.write().unwrap().iter(); // Triggers internal cleanup
        self.token_cache.write().unwrap().iter(); // Triggers internal cleanup
    }

    // Utility methods

    pub fn get_cache_stats(&self) -> (usize, usize) {
        let agent_count = self.agent_cache.read().unwrap().len();
        let token_count = self.token_cache.read().unwrap().len();
        (agent_count, token_count)
    }
}
