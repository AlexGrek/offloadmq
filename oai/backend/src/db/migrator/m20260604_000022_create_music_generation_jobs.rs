use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260604_000022_create_music_generation_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(MusicGenerationJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MusicGenerationJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(MusicGenerationJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(MusicGenerationJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(MusicGenerationJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(MusicGenerationJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(MusicGenerationJobs::Capability).text().not_null())
                    .col(ColumnDef::new(MusicGenerationJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::OutputBucketUid).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Tags).text().not_null())
                    .col(ColumnDef::new(MusicGenerationJobs::Lyrics).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Bpm).integer().null())
                    .col(
                        ColumnDef::new(MusicGenerationJobs::Duration)
                            .integer()
                            .not_null()
                            .default(30),
                    )
                    .col(ColumnDef::new(MusicGenerationJobs::Seed).integer().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Language).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Keyscale).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::CfgScale).double().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Temperature).double().null())
                    .col(ColumnDef::new(MusicGenerationJobs::ResultSeed).integer().null())
                    .col(ColumnDef::new(MusicGenerationJobs::AudioFilesJson).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Stage).text().null())
                    .col(ColumnDef::new(MusicGenerationJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(MusicGenerationJobs::Table, MusicGenerationJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(MusicGenerationJobs::Table)
                    .name("idx_music_generation_jobs_user_id")
                    .col(MusicGenerationJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(MusicGenerationJobs::Table)
                    .name("idx_music_generation_jobs_status")
                    .col(MusicGenerationJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MusicGenerationJobs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum MusicGenerationJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Capability,
    OffloadCap,
    OffloadTaskId,
    OutputBucketUid,
    Tags,
    Lyrics,
    Bpm,
    Duration,
    Seed,
    Language,
    Keyscale,
    CfgScale,
    Temperature,
    ResultSeed,
    AudioFilesJson,
    Stage,
    Error,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
