use std::sync::Arc;

use crate::{config::AppConfig, db::app_storage::AppStorage, middleware::auth::Auth, mq::urgent::UrgentTaskStore};

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<AppStorage>,
    pub config: Arc<AppConfig>,
    pub auth: Arc<Auth>,
    pub urgent: Arc<UrgentTaskStore>,
    /// Serializes bucket validation + reservation during task submission so two
    /// concurrent submissions can't both pass the `rm_after_task` single-use
    /// check before either records its task id (TOCTOU).
    pub bucket_submit_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(storage: AppStorage, config: AppConfig, auth: Auth) -> Self {
        Self {
            storage: Arc::new(storage),
            config: Arc::new(config),
            auth: Arc::new(auth),
            urgent: UrgentTaskStore::new(),
            bucket_submit_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
