use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(UserPromptDefaults::Table)
                    .col(
                        ColumnDef::new(UserPromptDefaults::UserId)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(UserPromptDefaults::DescribeImage).text())
                    .col(ColumnDef::new(UserPromptDefaults::Chat).text())
                    .col(ColumnDef::new(UserPromptDefaults::ImageCycles).text())
                    .col(ColumnDef::new(UserPromptDefaults::GeneratorImprover).text())
                    .foreign_key(
                        ForeignKey::create()
                            .from(UserPromptDefaults::Table, UserPromptDefaults::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UserPromptDefaults::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum UserPromptDefaults {
    Table,
    UserId,
    DescribeImage,
    Chat,
    ImageCycles,
    GeneratorImprover,
}
#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
