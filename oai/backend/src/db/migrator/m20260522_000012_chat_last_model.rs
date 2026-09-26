use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000012_chat_last_model"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .add_column(ColumnDef::new(Chats::LastModel).string().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .drop_column(Chats::LastModel)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum Chats {
    Table,
    LastModel,
}
