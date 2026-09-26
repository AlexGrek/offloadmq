use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260806_000032_image_analysis_external_resize"
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
                        ColumnDef::new(ImageAnalysisJobs::ExternalResize)
                            .boolean()
                            .not_null()
                            .default(false),
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
                    .drop_column(ImageAnalysisJobs::ExternalResize)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImageAnalysisJobs {
    Table,
    ExternalResize,
}
