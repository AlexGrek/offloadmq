use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260615_000026_image_offload_typical_runtime"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageOffloadTasks::Table)
                    .add_column(
                        ColumnDef::new(ImageOffloadTasks::TypicalRuntimeSeconds)
                            .double()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageOffloadTasks::Table)
                    .drop_column(ImageOffloadTasks::TypicalRuntimeSeconds)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImageOffloadTasks {
    Table,
    TypicalRuntimeSeconds,
}
