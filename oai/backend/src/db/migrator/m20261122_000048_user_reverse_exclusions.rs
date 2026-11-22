use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(UserReverseExclusions::Table)
                    .col(
                        ColumnDef::new(UserReverseExclusions::UserId)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UserReverseExclusions::WordsJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(UserReverseExclusions::PlaceholdersJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(UserReverseExclusions::Table, UserReverseExclusions::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UserReverseExclusions::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum UserReverseExclusions {
    Table,
    UserId,
    WordsJson,
    PlaceholdersJson,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
