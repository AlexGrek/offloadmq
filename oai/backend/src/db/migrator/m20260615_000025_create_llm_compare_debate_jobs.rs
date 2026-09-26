use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260615_000025_create_llm_compare_debate_jobs"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(LlmCompareJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(LlmCompareJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(LlmCompareJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(LlmCompareJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LlmCompareJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LlmCompareJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(
                        ColumnDef::new(LlmCompareJobs::SystemPrompt)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(ColumnDef::new(LlmCompareJobs::UserPrompt).text().not_null())
                    .col(ColumnDef::new(LlmCompareJobs::SlotsJson).text().not_null())
                    .col(ColumnDef::new(LlmCompareJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(LlmCompareJobs::Table, LlmCompareJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(LlmCompareJobs::Table)
                    .name("idx_llm_compare_jobs_user_id")
                    .col(LlmCompareJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(LlmCompareJobs::Table)
                    .name("idx_llm_compare_jobs_status")
                    .col(LlmCompareJobs::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(LlmDebateJobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(LlmDebateJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(LlmDebateJobs::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(LlmDebateJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LlmDebateJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LlmDebateJobs::Status)
                            .text()
                            .not_null()
                            .default("created"),
                    )
                    .col(ColumnDef::new(LlmDebateJobs::ModelA).text().not_null())
                    .col(ColumnDef::new(LlmDebateJobs::ModelB).text().not_null())
                    .col(ColumnDef::new(LlmDebateJobs::SystemA).text().not_null())
                    .col(ColumnDef::new(LlmDebateJobs::SystemB).text().not_null())
                    .col(ColumnDef::new(LlmDebateJobs::InitialPrompt).text().not_null())
                    .col(
                        ColumnDef::new(LlmDebateJobs::RefereeEnabled)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(LlmDebateJobs::ModelRef).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::SystemRef).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::CommandRef).text().null())
                    .col(
                        ColumnDef::new(LlmDebateJobs::RefereeTurns)
                            .integer()
                            .not_null()
                            .default(6),
                    )
                    .col(
                        ColumnDef::new(LlmDebateJobs::MessagesJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(LlmDebateJobs::Phase)
                            .text()
                            .not_null()
                            .default("debate"),
                    )
                    .col(ColumnDef::new(LlmDebateJobs::CurrentTurn).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::OffloadCap).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::OffloadTaskId).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::ActiveLog).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::Stage).text().null())
                    .col(ColumnDef::new(LlmDebateJobs::Error).text().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(LlmDebateJobs::Table, LlmDebateJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(LlmDebateJobs::Table)
                    .name("idx_llm_debate_jobs_user_id")
                    .col(LlmDebateJobs::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(LlmDebateJobs::Table)
                    .name("idx_llm_debate_jobs_status")
                    .col(LlmDebateJobs::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(LlmDebateJobs::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(LlmCompareJobs::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Users {
    Table,
    Id,
}

#[derive(Iden)]
enum LlmCompareJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    SystemPrompt,
    UserPrompt,
    SlotsJson,
    Error,
}

#[derive(Iden)]
enum LlmDebateJobs {
    Table,
    Id,
    UserId,
    CreatedAt,
    UpdatedAt,
    Status,
    ModelA,
    ModelB,
    SystemA,
    SystemB,
    InitialPrompt,
    RefereeEnabled,
    ModelRef,
    SystemRef,
    CommandRef,
    RefereeTurns,
    MessagesJson,
    Phase,
    CurrentTurn,
    OffloadCap,
    OffloadTaskId,
    ActiveLog,
    Stage,
    Error,
}
