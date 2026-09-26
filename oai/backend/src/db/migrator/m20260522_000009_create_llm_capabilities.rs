use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000009_create_llm_capabilities"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(LlmCapabilities::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(LlmCapabilities::Base)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(LlmCapabilities::TagsJson).text().not_null())
                    .col(ColumnDef::new(LlmCapabilities::Raw).text().not_null())
                    .col(
                        ColumnDef::new(LlmCapabilities::LastAvailableAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LlmCapabilities::CreatedAt)
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
                    .table(LlmCapabilities::Table)
                    .name("idx_llm_capabilities_last_available_at")
                    .col(LlmCapabilities::LastAvailableAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(LlmCapabilities::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum LlmCapabilities {
    Table,
    Base,
    TagsJson,
    Raw,
    LastAvailableAt,
    CreatedAt,
}
