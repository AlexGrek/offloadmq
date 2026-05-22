use opendal::Operator;
use sea_orm::DatabaseConnection;

use crate::middleware::auth::Auth;
use crate::snowflake::SnowflakeGenerator;

pub struct AppState {
    pub db: DatabaseConnection,
    pub auth: Auth,
    pub snowflake: SnowflakeGenerator,
    pub storage: Option<Operator>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn next_id(&self) -> i64 {
        self.snowflake.next_id()
    }
}
