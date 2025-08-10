use std::sync::Arc;

use crate::{config::AppConfig, db::app_storage::AppStorage, middleware::auth::Auth, mq::urgent::UrgentTaskStore};

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<AppStorage>,
    pub config: Arc<AppConfig>,
    pub auth: Arc<Auth>,
    pub urgent: Arc<UrgentTaskStore>
}

impl AppState {
    pub fn new(storage: AppStorage, config: AppConfig, auth: Auth) -> Self {
        Self {
            storage: Arc::new(storage),
            config: Arc::new(config),
            auth: Arc::new(auth),
            urgent: UrgentTaskStore::new()
        }
    }
}
