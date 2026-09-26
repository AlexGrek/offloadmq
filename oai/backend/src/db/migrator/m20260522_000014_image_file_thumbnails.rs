use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000014_image_file_thumbnails"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageFiles::Table)
                    .add_column(
                        ColumnDef::new(ImageFiles::ThumbnailStoragePath)
                            .text()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ImageFiles::ThumbnailStoredBytes)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ImageFiles::Table)
                    .drop_column(ImageFiles::ThumbnailStoredBytes)
                    .drop_column(ImageFiles::ThumbnailStoragePath)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum ImageFiles {
    Table,
    ThumbnailStoragePath,
    ThumbnailStoredBytes,
}
