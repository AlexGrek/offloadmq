use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260522_000018_create_generation_parameters"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(GenerationParameters::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GenerationParameters::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(GenerationParameters::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(GenerationParameters::Filename).text().not_null())
                    .col(ColumnDef::new(GenerationParameters::Source).text().not_null())
                    .col(
                        ColumnDef::new(GenerationParameters::Parameters)
                            .json_binary()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GenerationParameters::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                GenerationParameters::Table,
                                GenerationParameters::UserId,
                            )
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(GenerationParameters::Table)
                    .name("uq_generation_parameters_user_filename")
                    .col(GenerationParameters::UserId)
                    .col(GenerationParameters::Filename)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(GenerationParameters::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum GenerationParameters {
    Table,
    Id,
    UserId,
    Filename,
    Source,
    Parameters,
    CreatedAt,
}
