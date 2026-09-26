use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000008_chat_system_prompts"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .add_column(
                        ColumnDef::new(Chats::SystemPrompt)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(UserSystemPrompts::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(UserSystemPrompts::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UserSystemPrompts::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(UserSystemPrompts::Content).text().not_null())
                    .col(
                        ColumnDef::new(UserSystemPrompts::Starred)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(UserSystemPrompts::LastUsedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(UserSystemPrompts::CreatedAt)
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
                    .table(UserSystemPrompts::Table)
                    .col(UserSystemPrompts::UserId)
                    .col(UserSystemPrompts::LastUsedAt)
                    .name("idx_user_system_prompts_user_last_used")
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(UserSystemPrompts::Table)
                    .col(UserSystemPrompts::UserId)
                    .col(UserSystemPrompts::Starred)
                    .name("idx_user_system_prompts_user_starred")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UserSystemPrompts::Table).to_owned())
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .drop_column(Chats::SystemPrompt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum Chats {
    Table,
    SystemPrompt,
}

#[derive(Iden)]
enum UserSystemPrompts {
    Table,
    Id,
    UserId,
    Content,
    Starred,
    LastUsedAt,
    CreatedAt,
}
