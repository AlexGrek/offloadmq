//! VR Worlds: one row per `world.splat` job (image → Gaussian-splat PLY).

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let mut table = Table::create();
        table
            .table(WorldJobs::Table)
            .col(ColumnDef::new(WorldJobs::Id).big_integer().not_null().primary_key())
            .col(ColumnDef::new(WorldJobs::UserId).big_integer().not_null());
        for col in [WorldJobs::CreatedAt, WorldJobs::UpdatedAt] {
            table.col(
                ColumnDef::new(col)
                    .timestamp_with_time_zone()
                    .not_null()
                    .default(Expr::current_timestamp()),
            );
        }
        for col in [WorldJobs::Status, WorldJobs::Capability, WorldJobs::Mode, WorldJobs::ParamsJson] {
            table.col(ColumnDef::new(col).text().not_null());
        }
        for col in [
            WorldJobs::OffloadCap,
            WorldJobs::OffloadTaskId,
            WorldJobs::OutputBucketUid,
            WorldJobs::Stage,
            WorldJobs::Error,
            WorldJobs::ResultJson,
            WorldJobs::PlyPath,
            WorldJobs::PreviewPath,
        ] {
            table.col(ColumnDef::new(col).text().null());
        }
        table
            .col(ColumnDef::new(WorldJobs::InputImageId).big_integer().null())
            .col(ColumnDef::new(WorldJobs::PlyBytes).big_integer().null())
            .col(ColumnDef::new(WorldJobs::StartedAt).timestamp_with_time_zone().null())
            .col(ColumnDef::new(WorldJobs::TypicalRuntimeSeconds).double().null())
            .foreign_key(
                ForeignKey::create()
                    .from(WorldJobs::Table, WorldJobs::InputImageId)
                    .to(ImageFiles::Table, ImageFiles::Id)
                    .on_delete(ForeignKeyAction::SetNull),
            )
            .foreign_key(
                ForeignKey::create()
                    .from(WorldJobs::Table, WorldJobs::UserId)
                    .to(Users::Table, Users::Id)
                    .on_delete(ForeignKeyAction::Cascade),
            );
        manager.create_table(table.to_owned()).await?;
        for (name, col) in [
            ("idx_world_jobs_user_id", WorldJobs::UserId),
            ("idx_world_jobs_status", WorldJobs::Status),
        ] {
            manager
                .create_index(Index::create().name(name).table(WorldJobs::Table).col(col).to_owned())
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.drop_table(Table::drop().table(WorldJobs::Table).to_owned()).await
    }
}

#[derive(Iden)]
enum WorldJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Capability,
    Mode,
    ParamsJson,
    InputImageId,
    OffloadCap,
    OffloadTaskId,
    OutputBucketUid,
    Stage,
    Error,
    ResultJson,
    PlyPath,
    PreviewPath,
    PlyBytes,
    StartedAt,
    TypicalRuntimeSeconds,
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum ImageFiles { Table, Id }
