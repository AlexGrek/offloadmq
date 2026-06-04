pub mod app_settings;
pub mod imggen_capabilities;
pub mod llm_capabilities;
pub mod chat_attachments;
pub mod chats;
pub mod prompts;
pub mod entities;
pub mod generation_parameters;
pub mod offload_jobs;
pub mod image_analysis;
pub mod nude_detect;
pub mod image_generation;
pub mod image_worker_logs;
pub mod migrator;
pub mod tts;
pub mod music_generation;
pub mod users;

use anyhow::Result;
use sea_orm::{Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait;

pub async fn connect(database_url: &str) -> Result<DatabaseConnection> {
    let db = Database::connect(database_url).await?;
    migrator::Migrator::up(&db, None).await?;
    Ok(db)
}
