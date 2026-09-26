use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000010_image_job_pipeline_params"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageGenerationJobs::Table)
                    .add_column(
                        ColumnDef::new(ImageGenerationJobs::PipelineParamsJson)
                            .text()
                            .not_null()
                            .default("{}"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageGenerationJobs::Table)
                    .drop_column(ImageGenerationJobs::PipelineParamsJson)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum ImageGenerationJobs {
    Table,
    PipelineParamsJson,
}
