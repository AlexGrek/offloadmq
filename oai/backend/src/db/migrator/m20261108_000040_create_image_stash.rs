use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImageStashEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageStashEntries::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImageStashEntries::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageStashEntries::RequestJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageStashEntries::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ImageStashEntries::Table, ImageStashEntries::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(ImageStashEntries::Table)
                    .col(ImageStashEntries::UserId)
                    .col(ImageStashEntries::CreatedAt)
                    .name("idx_image_stash_entries_user_created")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageStashEntries::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ImageStashEntries {
    Table,
    Id,
    UserId,
    RequestJson,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
