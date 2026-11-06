use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImgModelWarJobs::Table)
                    .col(
                        ColumnDef::new(ImgModelWarJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImgModelWarJobs::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImgModelWarJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImgModelWarJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImgModelWarJobs::Status).text().not_null())
                    .col(
                        ColumnDef::new(ImgModelWarJobs::ParamsJson)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImgModelWarJobs::SlotsJson).text().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ImgModelWarJobs::Table, ImgModelWarJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_img_model_war_jobs_user")
                    .table(ImgModelWarJobs::Table)
                    .col(ImgModelWarJobs::UserId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImgModelWarJobs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ImgModelWarJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    ParamsJson,
    SlotsJson,
}
#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
