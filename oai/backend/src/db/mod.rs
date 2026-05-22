pub mod app_settings;
pub mod imggen_capabilities;
pub mod llm_capabilities;
pub mod chats;
pub mod user_system_prompts;
pub mod entities;
pub mod image_generation;
pub mod image_worker_logs;
pub mod migrator;
pub mod users;

use anyhow::Result;
use sea_orm::{Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait;

pub async fn connect(database_url: &str) -> Result<DatabaseConnection> {
    let db = Database::connect(database_url).await?;
    migrator::Migrator::up(&db, None).await?;
    Ok(db)
}
