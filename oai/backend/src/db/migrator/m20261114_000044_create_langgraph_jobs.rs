use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let mut table = Table::create();
        table
            .table(LanggraphJobs::Table)
            .col(
                ColumnDef::new(LanggraphJobs::Id)
                    .big_integer()
                    .not_null()
                    .primary_key(),
            )
            .col(
                ColumnDef::new(LanggraphJobs::UserId)
                    .big_integer()
                    .not_null(),
            );
        for col in [LanggraphJobs::CreatedAt, LanggraphJobs::UpdatedAt] {
            table.col(
                ColumnDef::new(col)
                    .timestamp_with_time_zone()
                    .not_null()
                    .default(Expr::current_timestamp()),
            );
        }
        for col in [
            LanggraphJobs::Status,
            LanggraphJobs::Prompt,
            LanggraphJobs::Capability,
            LanggraphJobs::RequestJson,
            LanggraphJobs::ArtifactsJson,
        ] {
            table.col(ColumnDef::new(col).text().not_null());
        }
        for col in [
            LanggraphJobs::ResultJson,
            LanggraphJobs::OffloadCap,
            LanggraphJobs::OffloadTaskId,
            LanggraphJobs::OffloadBucketUid,
            LanggraphJobs::Stage,
            LanggraphJobs::Error,
        ] {
            table.col(ColumnDef::new(col).text().null());
        }
        table.foreign_key(
            ForeignKey::create()
                .from(LanggraphJobs::Table, LanggraphJobs::UserId)
                .to(Users::Table, Users::Id)
                .on_delete(ForeignKeyAction::Cascade),
        );
        manager.create_table(table.to_owned()).await?;
        for (name, col) in [
            ("idx_langgraph_jobs_user_id", LanggraphJobs::UserId),
            ("idx_langgraph_jobs_status", LanggraphJobs::Status),
        ] {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(LanggraphJobs::Table)
                        .col(col)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(LanggraphJobs::Table).to_owned())
            .await
    }
}
#[derive(Iden)]
enum LanggraphJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Prompt,
    Capability,
    RequestJson,
    ResultJson,
    ArtifactsJson,
    OffloadCap,
    OffloadTaskId,
    OffloadBucketUid,
    Stage,
    Error,
}
#[derive(Iden)]
enum Users {
    Table,
    Id,
}
