use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000013_chat_message_offload_fields"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Track the offload task behind an in-flight (status="pending") assistant
        // reply so a background worker can reconcile it regardless of the WS.
        manager
            .alter_table(
                Table::alter()
                    .table(ChatMessages::Table)
                    .add_column(ColumnDef::new(ChatMessages::OffloadCap).text().null())
                    .add_column(ColumnDef::new(ChatMessages::OffloadTaskId).text().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ChatMessages::Table)
                    .name("idx_chat_messages_status")
                    .col(ChatMessages::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_chat_messages_status")
                    .table(ChatMessages::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ChatMessages::Table)
                    .drop_column(ChatMessages::OffloadCap)
                    .drop_column(ChatMessages::OffloadTaskId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum ChatMessages {
    Table,
    Status,
    OffloadCap,
    OffloadTaskId,
}
