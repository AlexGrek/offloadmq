use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000015_create_imggen_capabilities"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImggenCapabilities::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImggenCapabilities::Base)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ImggenCapabilities::TagsJson).text().not_null())
                    .col(ColumnDef::new(ImggenCapabilities::Raw).text().not_null())
                    .col(
                        ColumnDef::new(ImggenCapabilities::LastAvailableAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImggenCapabilities::CreatedAt)
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
                    .table(ImggenCapabilities::Table)
                    .name("idx_imggen_capabilities_last_available_at")
                    .col(ImggenCapabilities::LastAvailableAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImggenCapabilities::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum ImggenCapabilities {
    Table,
    Base,
    TagsJson,
    Raw,
    LastAvailableAt,
    CreatedAt,
}
