use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261126_000050_image_analysis_progress_timing"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageAnalysisJobs::Table)
                    .add_column(
                        ColumnDef::new(ImageAnalysisJobs::StartedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ImageAnalysisJobs::TypicalRuntimeSeconds).double().null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageAnalysisJobs::Table)
                    .drop_column(ImageAnalysisJobs::StartedAt)
                    .drop_column(ImageAnalysisJobs::TypicalRuntimeSeconds)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImageAnalysisJobs {
    Table,
    StartedAt,
    TypicalRuntimeSeconds,
}
