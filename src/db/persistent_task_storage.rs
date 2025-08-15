use anyhow::Result;
use chrono::Utc;
use sled::Db;

use crate::{
    error::AppError,
    models::{AssignedTask, UnassignedTask},
    schema::{TaskId, TaskStatus},
};

pub struct TaskStorage {
    _db: Db,
    unassigned: sled::Tree,
    assigned: sled::Tree,
    archived: sled::Tree,
}

impl TaskStorage {
    /// Open or create a new task storage in the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let unassigned = db.open_tree("tasks_unassigned")?;
        let assigned = db.open_tree("tasks_assigned")?;
        let archived = db.open_tree("tasks_archived")?;

        Ok(Self {
            _db: db,
            unassigned,
            assigned,
            archived,
        })
    }

    /// Create composite key: "capability|uuid"
    fn make_key(id: &TaskId) -> String {
        format!("{}|{}", id.cap, id.id)
    }

    /// Add a new unassigned task
    pub fn add_unassigned(&self, task: &UnassignedTask) -> Result<()> {
        let key = Self::make_key(&task.id);
        let bytes = rmp_serde::to_vec_named(task)?;
        self.unassigned.insert(key.as_bytes(), bytes)?;
        Ok(())
    }

    /// Move a task from unassigned to assigned when agent confirms
    pub fn assign_task(&self, id: &TaskId, agent_id: &str) -> Result<AssignedTask, AppError> {
        let key = Self::make_key(id);
        if let Some(value) = self.unassigned.remove(key.as_bytes())? {
            let unassigned: UnassignedTask = rmp_serde::from_slice(&value)?;

            let assigned = unassigned.assign_to(agent_id);

            let bytes = rmp_serde::to_vec_named(&assigned)?;
            self.assigned.insert(key.as_bytes(), bytes)?;
            return Ok(assigned);
        }
        Err(AppError::Conflict(format!(
            "Unassigned task not found: {}",
            id
        )))
    }

    /// Archive tasks older than 7 days that are NOT running
    pub fn archive_stale_tasks(&self) -> Result<()> {
        let now = Utc::now();
        let cutoff = now - chrono::Duration::days(7);

        let mut to_archive = Vec::new();

        for item in self.assigned.iter() {
            let (k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            if task.status != TaskStatus::Running && task.assigned_at < cutoff {
                to_archive.push((k, v));
            }
        }

        for (k, v) in to_archive {
            self.assigned.remove(&k)?;
            self.archived.insert(&k, v)?;
        }

        Ok(())
    }

    /// Get an unassigned task by id
    pub fn get_unassigned(&self, id: &TaskId) -> Result<Option<UnassignedTask>> {
        let key = Self::make_key(id);
        if let Some(value) = self.unassigned.get(key.as_bytes())? {
            Ok(Some(rmp_serde::from_slice(&value)?))
        } else {
            Ok(None)
        }
    }

    /// Get an assigned task by id
    pub fn get_assigned(&self, id: &TaskId) -> Result<Option<AssignedTask>> {
        let key = Self::make_key(id);
        if let Some(value) = self.assigned.get(key.as_bytes())? {
            Ok(Some(rmp_serde::from_slice(&value)?))
        } else {
            Ok(None)
        }
    }

    pub fn update_assigned(&self, assigned: &AssignedTask) -> Result<()> {
        let bytes = rmp_serde::to_vec_named(assigned)?;
        let key = Self::make_key(&assigned.id);
        self.assigned.insert(key.as_bytes(), bytes)?;
        return Ok(());
    }

    /// List unassigned tasks for a given capability
    pub fn list_unassigned_for_capability(&self, capability: &str) -> Result<Vec<UnassignedTask>> {
        let prefix = format!("{}|", capability);
        let mut result = Vec::new();

        for item in self.unassigned.scan_prefix(prefix.as_bytes()) {
            let (_k, v) = item?;
            let task: UnassignedTask = rmp_serde::from_slice(&v)?;
            result.push(task);
        }

        Ok(result)
    }

    pub fn list_unassigned_with_caps(&self, caps: &Vec<String>) -> Result<Vec<UnassignedTask>> {
        Ok(caps
            .iter()
            .filter_map(|x| self.list_unassigned_for_capability(x).ok())
            .flatten()
            .collect())
    }

    pub fn list_unassigned_all(&self) -> Result<Vec<UnassignedTask>> {
        let mut result = Vec::new();
        // The iter() method returns an iterator over all key-value pairs in the tree.
        for item in self.unassigned.iter() {
            // Each item is a sled::Result<(IVec, IVec)>
            let (_key, value) = item?;
            let task: UnassignedTask = rmp_serde::from_slice(&value)?;
            result.push(task);
        }
        Ok(result)
    }

    pub fn list_assigned_all(&self) -> Result<Vec<AssignedTask>> {
        let mut result = Vec::new();
        // The iter() method returns an iterator over all key-value pairs in the tree.
        for item in self.assigned.iter() {
            // Each item is a sled::Result<(IVec, IVec)>
            let (_key, value) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&value)?;
            result.push(task);
        }
        Ok(result)
    }
}
