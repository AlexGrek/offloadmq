use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000017_create_tts_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(TtsJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(TtsJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(TtsJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(TtsJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(TtsJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(TtsJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(TtsJobs::Text).text().not_null())
                    .col(ColumnDef::new(TtsJobs::Capability).text().not_null())
                    .col(ColumnDef::new(TtsJobs::Voice).text().not_null())
                    .col(ColumnDef::new(TtsJobs::Model).text().not_null())
                    .col(ColumnDef::new(TtsJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(TtsJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(TtsJobs::AudioStoragePath).text().null())
                    .col(ColumnDef::new(TtsJobs::AudioContentType).text().null())
                    .col(ColumnDef::new(TtsJobs::AudioSizeBytes).big_integer().null())
                    .col(ColumnDef::new(TtsJobs::Stage).text().null())
                    .col(ColumnDef::new(TtsJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(TtsJobs::Table, TtsJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(TtsJobs::Table)
                    .name("idx_tts_jobs_user_id")
                    .col(TtsJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(TtsJobs::Table)
                    .name("idx_tts_jobs_status")
                    .col(TtsJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(TtsJobs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum TtsJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Text,
    Capability,
    Voice,
    Model,
    OffloadCap,
    OffloadTaskId,
    AudioStoragePath,
    AudioContentType,
    AudioSizeBytes,
    Stage,
    Error,
}
