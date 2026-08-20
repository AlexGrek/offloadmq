use std::sync::Arc;

use opendal::Operator;
use sea_orm::DatabaseConnection;

use crate::middleware::auth::Auth;
use crate::offload::watch::TaskWatch;
use crate::snowflake::SnowflakeGenerator;

pub struct AppState {
    pub db: DatabaseConnection,
    pub auth: Auth,
    pub snowflake: SnowflakeGenerator,
    pub storage: Option<Operator>,
    pub http: reqwest::Client,
    /// Single shared OffloadMQ task-watch connection — see `offload::watch`.
    pub watch: Arc<TaskWatch>,
}

impl AppState {
    pub fn next_id(&self) -> i64 {
        self.snowflake.next_id()
    }
}
