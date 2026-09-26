use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000016_create_image_analysis_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImageAnalysisJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageAnalysisJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ImageAnalysisJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(ImageAnalysisJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImageAnalysisJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImageAnalysisJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(ImageAnalysisJobs::Prompt).text().not_null())
                    .col(ColumnDef::new(ImageAnalysisJobs::Capability).text().not_null())
                    .col(ColumnDef::new(ImageAnalysisJobs::InputImageId).big_integer().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::OffloadBucketUid).text().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::Result).text().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::Stage).text().null())
                    .col(ColumnDef::new(ImageAnalysisJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ImageAnalysisJobs::Table, ImageAnalysisJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImageAnalysisJobs::Table)
                    .name("idx_image_analysis_jobs_user_id")
                    .col(ImageAnalysisJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImageAnalysisJobs::Table)
                    .name("idx_image_analysis_jobs_status")
                    .col(ImageAnalysisJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageAnalysisJobs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum ImageAnalysisJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Prompt,
    Capability,
    InputImageId,
    OffloadCap,
    OffloadTaskId,
    OffloadBucketUid,
    Result,
    Stage,
    Error,
}
