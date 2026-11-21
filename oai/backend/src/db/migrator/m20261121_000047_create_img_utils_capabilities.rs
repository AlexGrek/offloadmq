use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261121_000047_create_img_utils_capabilities"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImgUtilsCapabilities::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImgUtilsCapabilities::Base)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImgUtilsCapabilities::TagsJson)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImgUtilsCapabilities::Raw).text().not_null())
                    .col(
                        ColumnDef::new(ImgUtilsCapabilities::LastAvailableAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ImgUtilsCapabilities::CreatedAt)
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
                    .table(ImgUtilsCapabilities::Table)
                    .name("idx_img_utils_capabilities_last_available_at")
                    .col(ImgUtilsCapabilities::LastAvailableAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImgUtilsCapabilities::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum ImgUtilsCapabilities {
    Table,
    Base,
    TagsJson,
    Raw,
    LastAvailableAt,
    CreatedAt,
}
