use sea_orm_migration::prelude::*;
pub struct Migration;
impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261113_000042_prompt_studio"
    }
}

/// Prompt Studio: `chats.kind` separates studio sessions from plain LLM chats, and
/// two per-user defaults (studio system prompt + message template).
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .add_column(
                        ColumnDef::new(Chats::Kind)
                            .string()
                            .not_null()
                            .default("chat"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(UserPromptDefaults::Table)
                    .add_column(ColumnDef::new(UserPromptDefaults::PromptStudioSystem).text())
                    .add_column(ColumnDef::new(UserPromptDefaults::PromptStudioTemplate).text())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(UserPromptDefaults::Table)
                    .drop_column(UserPromptDefaults::PromptStudioSystem)
                    .drop_column(UserPromptDefaults::PromptStudioTemplate)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .drop_column(Chats::Kind)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Chats {
    Table,
    Kind,
}

#[derive(DeriveIden)]
enum UserPromptDefaults {
    Table,
    PromptStudioSystem,
    PromptStudioTemplate,
}
