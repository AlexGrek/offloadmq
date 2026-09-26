use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260926_000034_prompt_entry_previews"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PromptEntries::Table)
                    .add_column(
                        ColumnDef::new(PromptEntries::PreviewUpdatedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(PromptEntries::Table)
                    .col(PromptEntries::UserId)
                    .col(PromptEntries::Bucket)
                    .col(PromptEntries::Kind)
                    .col(PromptEntries::UpdatedAt)
                    .name("idx_prompt_entries_user_bucket_kind_updated")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .table(PromptEntries::Table)
                    .name("idx_prompt_entries_user_bucket_kind_updated")
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PromptEntries::Table)
                    .drop_column(PromptEntries::PreviewUpdatedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PromptEntries {
    Table,
    UserId,
    Bucket,
    Kind,
    UpdatedAt,
    PreviewUpdatedAt,
}
