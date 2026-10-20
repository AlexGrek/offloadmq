use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ImageCycleJobs::Table)
                    .col(
                        ColumnDef::new(ImageCycleJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImageCycleJobs::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageCycleJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageCycleJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImageCycleJobs::Status).text().not_null())
                    .col(ColumnDef::new(ImageCycleJobs::ParamsJson).text().not_null())
                    .col(ColumnDef::new(ImageCycleJobs::StepsJson).text().not_null())
                    .col(ColumnDef::new(ImageCycleJobs::Error).text())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ImageCycleJobs::Table, ImageCycleJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        for (name, column) in [
            ("idx_image_cycle_jobs_user", ImageCycleJobs::UserId),
            ("idx_image_cycle_jobs_status", ImageCycleJobs::Status),
        ] {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(ImageCycleJobs::Table)
                        .col(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageCycleJobs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ImageCycleJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    ParamsJson,
    StepsJson,
    Error,
}
#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
