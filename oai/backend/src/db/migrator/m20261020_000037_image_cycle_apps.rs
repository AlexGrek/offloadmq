use sea_orm_migration::prelude::*;
#[derive(DeriveMigrationName)]
pub struct Migration;
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("ALTER TABLE image_cycle_jobs ADD COLUMN app text NOT NULL DEFAULT 'image-cycles'; ALTER TABLE image_analysis_jobs ADD COLUMN response_format text").await?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("ALTER TABLE image_analysis_jobs DROP COLUMN response_format; ALTER TABLE image_cycle_jobs DROP COLUMN app").await?;
        Ok(())
    }
}
