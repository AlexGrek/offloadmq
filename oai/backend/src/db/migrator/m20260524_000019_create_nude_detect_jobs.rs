use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260524_000019_create_nude_detect_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(NudeDetectJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(NudeDetectJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(NudeDetectJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(NudeDetectJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(NudeDetectJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(NudeDetectJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(
                        ColumnDef::new(NudeDetectJobs::Threshold)
                            .double()
                            .not_null()
                            .default(0.25),
                    )
                    .col(ColumnDef::new(NudeDetectJobs::InputImageId).big_integer().null())
                    .col(ColumnDef::new(NudeDetectJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(NudeDetectJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(NudeDetectJobs::OffloadBucketUid).text().null())
                    .col(ColumnDef::new(NudeDetectJobs::Result).text().null())
                    .col(ColumnDef::new(NudeDetectJobs::Stage).text().null())
                    .col(ColumnDef::new(NudeDetectJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(NudeDetectJobs::Table, NudeDetectJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(NudeDetectJobs::Table)
                    .name("idx_nude_detect_jobs_user_id")
                    .col(NudeDetectJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(NudeDetectJobs::Table)
                    .name("idx_nude_detect_jobs_status")
                    .col(NudeDetectJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(NudeDetectJobs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum NudeDetectJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Threshold,
    InputImageId,
    OffloadCap,
    OffloadTaskId,
    OffloadBucketUid,
    Result,
    Stage,
    Error,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
