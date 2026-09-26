use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260722_000028_create_img_utils_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImgUtilsJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImgUtilsJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ImgUtilsJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(ImgUtilsJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImgUtilsJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImgUtilsJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(ImgUtilsJobs::Capability).text().not_null())
                    .col(ColumnDef::new(ImgUtilsJobs::Utility).text().not_null())
                    .col(ColumnDef::new(ImgUtilsJobs::Workflow).text().not_null())
                    .col(ColumnDef::new(ImgUtilsJobs::InputImageId).big_integer().null())
                    .col(ColumnDef::new(ImgUtilsJobs::SourceImageId).big_integer().null())
                    .col(ColumnDef::new(ImgUtilsJobs::OptionsJson).text().null())
                    .col(ColumnDef::new(ImgUtilsJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(ImgUtilsJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(ImgUtilsJobs::OutputBucketUid).text().null())
                    .col(ColumnDef::new(ImgUtilsJobs::OutputImageId).big_integer().null())
                    .col(ColumnDef::new(ImgUtilsJobs::Stage).text().null())
                    .col(ColumnDef::new(ImgUtilsJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ImgUtilsJobs::Table, ImgUtilsJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImgUtilsJobs::Table)
                    .name("idx_img_utils_jobs_user_id")
                    .col(ImgUtilsJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImgUtilsJobs::Table)
                    .name("idx_img_utils_jobs_status")
                    .col(ImgUtilsJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImgUtilsJobs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum ImgUtilsJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Capability,
    Utility,
    Workflow,
    InputImageId,
    SourceImageId,
    OptionsJson,
    OffloadCap,
    OffloadTaskId,
    OutputBucketUid,
    OutputImageId,
    Stage,
    Error,
}
