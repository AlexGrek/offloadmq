use anyhow::Result;
use chrono::Utc;
use sled::Db;

use crate::{error::AppError, models::ClientApiKey};

pub struct ApiKeysStorage {
    _db: Db,
    active: sled::Tree,
    archived: sled::Tree,
}

impl ApiKeysStorage {
    /// Open or create a new task storage in the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let active = db.open_tree("api_keys_active")?;
        let archived = db.open_tree("api_keys_archived")?;

        Ok(Self {
            _db: db,
            active,
            archived,
        })
    }

    /// Get an active key by id
    pub fn find_active(&self, id: &str) -> Result<Option<ClientApiKey>> {
        let key = id;
        if let Some(value) = self.active.get(key.as_bytes())? {
            Ok(Some(rmp_serde::from_slice(&value)?))
        } else {
            Ok(None)
        }
    }

    pub fn verify_key(&self, key: &str, cap: &str) -> Result<(), AppError> {
        if let Some(key_descr) = self.find_active(key)? {
            if !key_descr.is_revoked && Self::has_capability(&key_descr.capabilities, cap) {
                return Ok(());
            }
        }
        return Err(AppError::Authorization("API key invalid".to_string()));
    }

    pub fn is_key_real_not_revoked(&self, key: &str) -> bool {
        if let Some(key_descr) = self.find_active(key).unwrap_or(None) {
            if !key_descr.is_revoked {
                return true;
            }
        }
        return false;
    }

    pub fn list_all(&self) -> Vec<ClientApiKey> {
        let mut keys = Vec::new();

        // Get all agents from database (cache might not have all due to TTL)
        for item in self.active.iter() {
            if let Ok((_, v)) = item {
                if let Ok(k) = rmp_serde::from_slice::<ClientApiKey>(&v) {
                    keys.push(k);
                }
            }
        }

        keys
    }

    /// Check if the given capability is allowed by the key's capabilities (supporting wildcards)
    pub fn has_capability(key_capabilities: &[String], required_cap: &str) -> bool {
        for cap in key_capabilities {
            if cap == "*" {
                // Universal wildcard allows everything
                return true;
            } else if cap.ends_with("*") {
                // Prefix wildcard - check if required capability starts with the prefix
                let prefix = &cap[..cap.len() - 1];
                if required_cap.starts_with(prefix) {
                    return true;
                }
            } else if cap == required_cap {
                // Exact match
                return true;
            }
        }
        false
    }

    /// Upsert (insert or update) an API key in the active storage
    pub fn upsert_key(&self, id: &str, key: &ClientApiKey) -> Result<()> {
        let serialized = rmp_serde::to_vec(key)?;
        self.active.insert(id.as_bytes(), serialized)?;
        Ok(())
    }

    /// Update an existing API key, archiving it if revoked
    pub fn update_key(&self, id: &str, key: &ClientApiKey) -> Result<()> {
        // Check if the key is being revoked
        if key.is_revoked {
            // Serialize the key for archiving
            let serialized = rmp_serde::to_vec(key)?;

            // Move to archived storage
            self.archived.insert(id.as_bytes(), serialized)?;

            // Remove from active storage
            self.active.remove(id.as_bytes())?;
        } else {
            // Key is still active, update in active storage
            let serialized = rmp_serde::to_vec(key)?;
            self.active.insert(id.as_bytes(), serialized)?;
        }
        Ok(())
    }

    pub fn initialize_from_list(&self, keys: &Vec<String>) -> Result<()> {
        for key in keys.iter() {
            self.upsert_key(
                key,
                &ClientApiKey {
                    key: key.clone(),
                    capabilities: vec!["*".to_string()],
                    is_predefined: true,
                    created: Utc::now(),
                    is_revoked: false,
                },
            )?;
        }
        Ok(())
    }
}
