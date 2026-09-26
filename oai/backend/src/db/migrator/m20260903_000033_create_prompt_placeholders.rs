use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260903_000033_create_prompt_placeholders"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PromptPlaceholders::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PromptPlaceholders::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(PromptPlaceholders::UserId).big_integer().not_null())
                    .col(ColumnDef::new(PromptPlaceholders::Name).text().not_null())
                    .col(ColumnDef::new(PromptPlaceholders::VariantsJson).text().not_null())
                    .col(
                        ColumnDef::new(PromptPlaceholders::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(PromptPlaceholders::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        // Not unique: case-insensitive uniqueness (and the reserved-builtin-name
        // check) is enforced in db/prompt_placeholders.rs — no functional/LOWER()
        // index is used anywhere else in this migrator. This index is purely for
        // per-user lookup speed.
        manager
            .create_index(
                Index::create()
                    .table(PromptPlaceholders::Table)
                    .col(PromptPlaceholders::UserId)
                    .col(PromptPlaceholders::Name)
                    .name("idx_prompt_placeholders_user_name")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PromptPlaceholders::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum PromptPlaceholders {
    Table,
    Id,
    UserId,
    Name,
    VariantsJson,
    CreatedAt,
    UpdatedAt,
}
