use sea_orm_migration::prelude::*;
pub struct Migration;
impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261110_000041_img_utils_priority"
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
                        ColumnDef::new(ImgUtilsJobs::Priority)
                            .string()
                            .not_null()
                            .default("normal"),
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
                    .drop_column(ImgUtilsJobs::Priority)
                    .to_owned(),
            )
            .await
    }
}
#[derive(DeriveIden)]
enum ImgUtilsJobs {
    Table,
    Priority,
}
