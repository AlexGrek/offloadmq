use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260709_000027_image_offload_task_finished_at"
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
                        ColumnDef::new(ImageOffloadTasks::FinishedAt)
                            .timestamp_with_time_zone()
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
                    .drop_column(ImageOffloadTasks::FinishedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ImageOffloadTasks {
    Table,
    FinishedAt,
}
