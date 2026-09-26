use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260730_000029_create_movie_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(MovieJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MovieJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(MovieJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(MovieJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::Status)
                            .text()
                            .not_null()
                            .default("running"),
                    )
                    .col(ColumnDef::new(MovieJobs::Idea).text().not_null())
                    .col(ColumnDef::new(MovieJobs::Width).integer().not_null())
                    .col(ColumnDef::new(MovieJobs::Height).integer().not_null())
                    .col(ColumnDef::new(MovieJobs::SceneCount).integer().not_null())
                    .col(ColumnDef::new(MovieJobs::SceneLength).integer().not_null())
                    .col(
                        ColumnDef::new(MovieJobs::LongShot)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::AutoApprove)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::ExpandPrompt)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(ColumnDef::new(MovieJobs::DirectorModel).text().not_null())
                    .col(ColumnDef::new(MovieJobs::SceneModel).text().not_null())
                    .col(ColumnDef::new(MovieJobs::VideoCapability).text().not_null())
                    .col(ColumnDef::new(MovieJobs::DirectorSystem).text().not_null())
                    .col(ColumnDef::new(MovieJobs::SceneSystem).text().not_null())
                    .col(ColumnDef::new(MovieJobs::InitialImageId).big_integer().null())
                    .col(
                        ColumnDef::new(MovieJobs::Phase)
                            .text()
                            .not_null()
                            .default("director"),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::OutlineJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::ScenesJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(MovieJobs::CurrentScene)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(MovieJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(MovieJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(MovieJobs::ActiveLog).text().null())
                    .col(ColumnDef::new(MovieJobs::Stage).text().null())
                    .col(ColumnDef::new(MovieJobs::Error).text().null())
                    .col(ColumnDef::new(MovieJobs::MovieFileId).big_integer().null())
                    .col(ColumnDef::new(MovieJobs::RawOutline).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(MovieJobs::Table, MovieJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(MovieJobs::Table)
                    .name("idx_movie_jobs_user_id")
                    .col(MovieJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(MovieJobs::Table)
                    .name("idx_movie_jobs_status")
                    .col(MovieJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MovieJobs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum MovieJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    Idea,
    Width,
    Height,
    SceneCount,
    SceneLength,
    LongShot,
    AutoApprove,
    ExpandPrompt,
    DirectorModel,
    SceneModel,
    VideoCapability,
    DirectorSystem,
    SceneSystem,
    InitialImageId,
    Phase,
    OutlineJson,
    ScenesJson,
    CurrentScene,
    OffloadCap,
    OffloadTaskId,
    ActiveLog,
    Stage,
    Error,
    MovieFileId,
    RawOutline,
}
