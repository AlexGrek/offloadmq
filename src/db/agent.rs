use crate::{
    error::AppError,
    models::{Agent, CommunicationMethod},
};
use chrono::Utc;
use log::info;
use rmp_serde::{from_slice, to_vec_named};
use uuid::Uuid;

pub struct AgentStorage {
    pub db: sled::Db,
}

impl AgentStorage {
    pub fn new(path: &str) -> sled::Result<Self> {
        Ok(Self {
            db: sled::open(path)?,
        })
    }

    fn generate_unique_uid(&self) -> String {
        loop {
            let uid = Uuid::new_v4().to_string();

            if !self.db.contains_key(uid.as_bytes()).unwrap_or(false) {
                return uid;
            }

            eprintln!("UUID collision detected for {}, generating new one", uid);
        }
    }

    pub async fn create_agent(&self, agent: &mut Agent) -> sled::Result<()> {
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
        self.db.flush_async().await?;

        info!("Created agent {:?}", agent);
        Ok(())
    }

    pub fn get_agent(&self, id: &str) -> Option<Agent> {
        let data = self.db.get(id.as_bytes()).ok()??;
        from_slice::<Agent>(&data).ok()
    }

    pub async fn update_agent_last_contact(
        &self,
        mut agent: Agent,
        method: CommunicationMethod,
    ) -> Result<Agent, sled::Error> {
        agent.last_contact = Some(Utc::now());
        agent.last_comm_method = method;
        self.update_agent(agent.clone()).await.map(|()| agent)
    }

    pub async fn update_agent(&self, agent: Agent) -> sled::Result<()> {
        let id = agent.uid.clone();

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
        self.db.flush_async().await?;
        Ok(())
    }

    pub async fn delete_agent(&self, id: &str) -> sled::Result<()> {
        self.db.remove(id.as_bytes())?;
        self.db.flush_async().await?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), AppError> {
        self.db.clear()?;
        Ok(())
    }

    pub fn list_all_agents(&self) -> Vec<Agent> {
        let mut agents = Vec::new();

        for item in self.db.iter() {
            if let Ok((_, v)) = item {
                if let Ok(agent) = from_slice::<Agent>(&v) {
                    agents.push(agent);
                }
            }
        }

        agents
    }

    pub fn agent_count(&self) -> usize {
        self.db.len()
    }

    pub fn log_online_agents(&self) {
        let agents: Vec<_> = self
            .list_all_agents()
            .into_iter()
            .filter(|agent| agent.is_online())
            .collect();
        info!("Online agents: ");
        for agent in agents {
            info!("     {:?}", agent);
        }
    }

    pub async fn cleanup_stale_agents(&self, ttl_days: u32) -> Result<usize, sled::Error> {
        let mut deleted = 0usize;
        let now = Utc::now();
        let ttl_secs = ttl_days as i64 * 24 * 60 * 60;

        let agents_to_delete: Vec<String> = self
            .list_all_agents()
            .into_iter()
            .filter_map(|agent| {
                let age_secs = now
                    .signed_duration_since(agent.last_activity_at())
                    .num_seconds();
                if age_secs > ttl_secs {
                    Some(agent.uid)
                } else {
                    None
                }
            })
            .collect();

        for agent_id in agents_to_delete {
            self.delete_agent(&agent_id).await?;
            deleted += 1;
        }

        Ok(deleted)
    }
}
