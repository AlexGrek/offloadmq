use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260604_000020_image_analysis_data_preparation"
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
                        ColumnDef::new(ImageAnalysisJobs::DataPreparation).text().null(),
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
                    .drop_column(ImageAnalysisJobs::DataPreparation)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImageAnalysisJobs {
    Table,
    DataPreparation,
}
