use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000006_create_image_worker_logs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImageWorkerLogs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageWorkerLogs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ImageWorkerLogs::RunId).text().not_null())
                    .col(ColumnDef::new(ImageWorkerLogs::Level).text().not_null())
                    .col(ColumnDef::new(ImageWorkerLogs::Message).text().not_null())
                    .col(ColumnDef::new(ImageWorkerLogs::DataJson).text().not_null())
                    .col(
                        ColumnDef::new(ImageWorkerLogs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImageWorkerLogs::Table)
                    .name("idx_image_worker_logs_created_at")
                    .col(ImageWorkerLogs::CreatedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageWorkerLogs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum ImageWorkerLogs {
    Table,
    Id,
    RunId,
    Level,
    Message,
    DataJson,
    CreatedAt,
}
