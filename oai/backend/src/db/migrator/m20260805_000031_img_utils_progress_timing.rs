use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260805_000031_img_utils_progress_timing"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImgUtilsJobs::Table)
                    .add_column(
                        ColumnDef::new(ImgUtilsJobs::StartedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ImgUtilsJobs::TypicalRuntimeSeconds).double().null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImgUtilsJobs::Table)
                    .drop_column(ImgUtilsJobs::StartedAt)
                    .drop_column(ImgUtilsJobs::TypicalRuntimeSeconds)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImgUtilsJobs {
    Table,
    StartedAt,
    TypicalRuntimeSeconds,
}
