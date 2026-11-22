use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261122_000049_create_bg_remover_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BgRemoverJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BgRemoverJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BgRemoverJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(BgRemoverJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(BgRemoverJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(BgRemoverJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(BgRemoverJobs::Capability).text().not_null())
                    .col(ColumnDef::new(BgRemoverJobs::InputImageId).big_integer().null())
                    .col(ColumnDef::new(BgRemoverJobs::OptionsJson).text().null())
                    .col(ColumnDef::new(BgRemoverJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(BgRemoverJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(BgRemoverJobs::OutputBucketUid).text().null())
                    .col(ColumnDef::new(BgRemoverJobs::OutputImageId).big_integer().null())
                    .col(ColumnDef::new(BgRemoverJobs::ForegroundRatio).double().null())
                    .col(ColumnDef::new(BgRemoverJobs::Stage).text().null())
                    .col(ColumnDef::new(BgRemoverJobs::Error).text().null())
                    .col(
                        ColumnDef::new(BgRemoverJobs::StartedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(ColumnDef::new(BgRemoverJobs::TypicalRuntimeSeconds).double().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(BgRemoverJobs::Table, BgRemoverJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(BgRemoverJobs::Table)
                    .name("idx_bg_remover_jobs_user_id")
                    .col(BgRemoverJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(BgRemoverJobs::Table)
                    .name("idx_bg_remover_jobs_status")
                    .col(BgRemoverJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BgRemoverJobs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum BgRemoverJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Capability,
    InputImageId,
    OptionsJson,
    OffloadCap,
    OffloadTaskId,
    OutputBucketUid,
    OutputImageId,
    ForegroundRatio,
    Stage,
    Error,
    StartedAt,
    TypicalRuntimeSeconds,
}
