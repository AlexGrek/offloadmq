use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260604_000023_create_prompt_entries"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PromptEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PromptEntries::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(PromptEntries::UserId).big_integer().not_null())
                    .col(ColumnDef::new(PromptEntries::Bucket).text().not_null())
                    .col(ColumnDef::new(PromptEntries::Kind).text().not_null())
                    .col(ColumnDef::new(PromptEntries::Content).text().not_null())
                    .col(
                        ColumnDef::new(PromptEntries::LastUsedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(PromptEntries::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(PromptEntries::UpdatedAt)
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
                    .table(PromptEntries::Table)
                    .col(PromptEntries::UserId)
                    .col(PromptEntries::Bucket)
                    .col(PromptEntries::Kind)
                    .col(PromptEntries::LastUsedAt)
                    .name("idx_prompt_entries_user_bucket_kind")
                    .to_owned(),
            )
            .await?;

        // Migrate existing chat system prompts into the new bucket, then drop
        // the old table. Starred rows become favorites; the rest become recents.
        let db = manager.get_connection();
        db.execute_unprepared(
            "INSERT INTO prompt_entries \
               (id, user_id, bucket, kind, content, last_used_at, created_at, updated_at) \
             SELECT id, user_id, 'llm-system', \
                    CASE WHEN starred THEN 'starred' ELSE 'recent' END, \
                    content, last_used_at, created_at, last_used_at \
             FROM user_system_prompts",
        )
        .await?;

        manager
            .drop_table(Table::drop().table(UserSystemPrompts::Table).to_owned())
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Recreate the old (empty) table so a rollback leaves a usable schema.
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
                    .col(ColumnDef::new(UserSystemPrompts::UserId).big_integer().not_null())
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
            .drop_table(Table::drop().table(PromptEntries::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum PromptEntries {
    Table,
    Id,
    UserId,
    Bucket,
    Kind,
    Content,
    LastUsedAt,
    CreatedAt,
    UpdatedAt,
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
