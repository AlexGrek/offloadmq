use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000004_create_chats"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Chats::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Chats::Id).big_integer().not_null().primary_key())
                    .col(ColumnDef::new(Chats::UserId).big_integer().not_null())
                    .col(ColumnDef::new(Chats::Title).text().not_null().default(""))
                    .col(
                        ColumnDef::new(Chats::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Chats::UpdatedAt)
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
                    .table(Chats::Table)
                    .col(Chats::UserId)
                    .name("idx_chats_user_id")
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ChatMessages::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ChatMessages::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ChatMessages::ChatId).big_integer().not_null())
                    .col(ColumnDef::new(ChatMessages::Role).text().not_null())
                    .col(
                        ColumnDef::new(ChatMessages::Content)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(ChatMessages::Status)
                            .text()
                            .not_null()
                            .default("complete"),
                    )
                    .col(ColumnDef::new(ChatMessages::Model).text().null())
                    .col(
                        ColumnDef::new(ChatMessages::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ChatMessages::Table, ChatMessages::ChatId)
                            .to(Chats::Table, Chats::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ChatMessages::Table)
                    .col(ChatMessages::ChatId)
                    .name("idx_chat_messages_chat_id")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ChatMessages::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Chats::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Chats {
    Table,
    Id,
    UserId,
    Title,
    CreatedAt,
    UpdatedAt,
}

#[derive(Iden)]
enum ChatMessages {
    Table,
    Id,
    ChatId,
    Role,
    Content,
    Status,
    Model,
    CreatedAt,
}
