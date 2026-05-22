use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_create_users::Migration),
            Box::new(m20260522_000002_add_admin_and_quotas_fields::Migration),
            Box::new(m20260522_000003_create_app_settings::Migration),
            Box::new(m20260522_000004_create_chats::Migration),
            Box::new(m20260522_000005_create_image_generation_tables::Migration),
            Box::new(m20260522_000006_create_image_worker_logs::Migration),
        ]
    }
}

mod m20260522_000006_create_image_worker_logs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000006_create_image_worker_logs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ImageWorkerLogs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImageWorkerLogs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImageWorkerLogs::RunId).text().not_null())
                        .col(ColumnDef::new(ImageWorkerLogs::Level).text().not_null())
                        .col(ColumnDef::new(ImageWorkerLogs::Message).text().not_null())
                        .col(ColumnDef::new(ImageWorkerLogs::DataJson).text().not_null())
                        .col(
                            ColumnDef::new(ImageWorkerLogs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageWorkerLogs::Table)
                        .name("idx_image_worker_logs_created_at")
                        .col(ImageWorkerLogs::CreatedAt)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ImageWorkerLogs::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum ImageWorkerLogs {
        Table,
        Id,
        RunId,
        Level,
        Message,
        DataJson,
        CreatedAt,
    }
}

mod m20260522_000005_create_image_generation_tables {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000005_create_image_generation_tables"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ImageGenerationJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImageGenerationJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImageGenerationJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(ImageGenerationJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImageGenerationJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImageGenerationJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(ColumnDef::new(ImageGenerationJobs::Prompt).text().not_null())
                        .col(ColumnDef::new(ImageGenerationJobs::NegativePrompt).text().null())
                        .col(ColumnDef::new(ImageGenerationJobs::Capability).text().not_null())
                        .col(ColumnDef::new(ImageGenerationJobs::Workflow).text().not_null())
                        .col(ColumnDef::new(ImageGenerationJobs::Width).integer().not_null())
                        .col(ColumnDef::new(ImageGenerationJobs::Height).integer().not_null())
                        .col(ColumnDef::new(ImageGenerationJobs::Seed).big_integer().null())
                        .col(ColumnDef::new(ImageGenerationJobs::InputImageId).big_integer().null())
                        .col(ColumnDef::new(ImageGenerationJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImageGenerationJobs::Table, ImageGenerationJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageGenerationJobs::Table)
                        .name("idx_image_generation_jobs_user_id")
                        .col(ImageGenerationJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_table(
                    Table::create()
                        .table(ImageFiles::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImageFiles::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImageFiles::UserId).big_integer().not_null())
                        .col(ColumnDef::new(ImageFiles::JobId).big_integer().null())
                        .col(ColumnDef::new(ImageFiles::Direction).text().not_null())
                        .col(ColumnDef::new(ImageFiles::Source).text().not_null())
                        .col(ColumnDef::new(ImageFiles::StoragePath).text().not_null())
                        .col(ColumnDef::new(ImageFiles::Filename).text().not_null())
                        .col(ColumnDef::new(ImageFiles::ContentType).text().not_null())
                        .col(ColumnDef::new(ImageFiles::OriginalBytes).big_integer().null())
                        .col(ColumnDef::new(ImageFiles::StoredBytes).big_integer().not_null())
                        .col(ColumnDef::new(ImageFiles::OriginalWidth).integer().null())
                        .col(ColumnDef::new(ImageFiles::OriginalHeight).integer().null())
                        .col(ColumnDef::new(ImageFiles::StoredWidth).integer().not_null())
                        .col(ColumnDef::new(ImageFiles::StoredHeight).integer().not_null())
                        .col(ColumnDef::new(ImageFiles::ExifOrientation).integer().null())
                        .col(ColumnDef::new(ImageFiles::Rescaled).boolean().not_null())
                        .col(ColumnDef::new(ImageFiles::Reencoded).boolean().not_null())
                        .col(ColumnDef::new(ImageFiles::Sha256).string_len(64).not_null())
                        .col(ColumnDef::new(ImageFiles::OffloadBucketUid).text().null())
                        .col(ColumnDef::new(ImageFiles::OffloadFileUid).text().null())
                        .col(
                            ColumnDef::new(ImageFiles::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImageFiles::Table, ImageFiles::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImageFiles::Table, ImageFiles::JobId)
                                .to(ImageGenerationJobs::Table, ImageGenerationJobs::Id)
                                .on_delete(ForeignKeyAction::SetNull),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageFiles::Table)
                        .name("idx_image_files_user_id")
                        .col(ImageFiles::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageFiles::Table)
                        .name("idx_image_files_job_id")
                        .col(ImageFiles::JobId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_table(
                    Table::create()
                        .table(ImagePipelineEvents::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImagePipelineEvents::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImagePipelineEvents::JobId).big_integer().not_null())
                        .col(ColumnDef::new(ImagePipelineEvents::Step).text().not_null())
                        .col(ColumnDef::new(ImagePipelineEvents::State).text().not_null())
                        .col(ColumnDef::new(ImagePipelineEvents::Details).text().null())
                        .col(
                            ColumnDef::new(ImagePipelineEvents::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImagePipelineEvents::Table, ImagePipelineEvents::JobId)
                                .to(ImageGenerationJobs::Table, ImageGenerationJobs::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImagePipelineEvents::Table)
                        .name("idx_image_pipeline_events_job_id")
                        .col(ImagePipelineEvents::JobId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_table(
                    Table::create()
                        .table(ImageOffloadTasks::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImageOffloadTasks::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImageOffloadTasks::JobId).big_integer().not_null())
                        .col(ColumnDef::new(ImageOffloadTasks::OffloadCap).text().not_null())
                        .col(ColumnDef::new(ImageOffloadTasks::OffloadTaskId).text().not_null())
                        .col(
                            ColumnDef::new(ImageOffloadTasks::SubmitPayload)
                                .text()
                                .not_null(),
                        )
                        .col(ColumnDef::new(ImageOffloadTasks::LastPollStatus).text().null())
                        .col(ColumnDef::new(ImageOffloadTasks::LastPollStage).text().null())
                        .col(ColumnDef::new(ImageOffloadTasks::LastPollLog).text().null())
                        .col(ColumnDef::new(ImageOffloadTasks::LastPollOutput).text().null())
                        .col(
                            ColumnDef::new(ImageOffloadTasks::SubmittedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImageOffloadTasks::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImageOffloadTasks::Table, ImageOffloadTasks::JobId)
                                .to(ImageGenerationJobs::Table, ImageGenerationJobs::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageOffloadTasks::Table)
                        .name("idx_image_offload_tasks_job_id")
                        .col(ImageOffloadTasks::JobId)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ImageOffloadTasks::Table).to_owned())
                .await?;
            manager
                .drop_table(Table::drop().table(ImagePipelineEvents::Table).to_owned())
                .await?;
            manager
                .drop_table(Table::drop().table(ImageFiles::Table).to_owned())
                .await?;
            manager
                .drop_table(Table::drop().table(ImageGenerationJobs::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        Id,
    }

    #[derive(Iden)]
    enum ImageGenerationJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Prompt,
        NegativePrompt,
        Capability,
        Workflow,
        Width,
        Height,
        Seed,
        InputImageId,
        Error,
    }

    #[derive(Iden)]
    enum ImageFiles {
        Table,
        Id,
        UserId,
        JobId,
        Direction,
        Source,
        StoragePath,
        Filename,
        ContentType,
        OriginalBytes,
        StoredBytes,
        OriginalWidth,
        OriginalHeight,
        StoredWidth,
        StoredHeight,
        ExifOrientation,
        Rescaled,
        Reencoded,
        Sha256,
        OffloadBucketUid,
        OffloadFileUid,
        CreatedAt,
    }

    #[derive(Iden)]
    enum ImagePipelineEvents {
        Table,
        Id,
        JobId,
        Step,
        State,
        Details,
        CreatedAt,
    }

    #[derive(Iden)]
    enum ImageOffloadTasks {
        Table,
        Id,
        JobId,
        OffloadCap,
        OffloadTaskId,
        SubmitPayload,
        LastPollStatus,
        LastPollStage,
        LastPollLog,
        LastPollOutput,
        SubmittedAt,
        UpdatedAt,
    }
}

mod m20260522_000003_create_app_settings {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000003_create_app_settings"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(AppSettings::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(AppSettings::Id)
                                .integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(
                            ColumnDef::new(AppSettings::OffloadmqUrl)
                                .text()
                                .not_null()
                                .default("https://offloadmq.alexgr.space/"),
                        )
                        .col(ColumnDef::new(AppSettings::ClientApiToken).text().null())
                        .col(ColumnDef::new(AppSettings::ManagementApiToken).text().null())
                        .to_owned(),
                )
                .await?;

            manager
                .get_connection()
                .execute_unprepared(
                    "INSERT INTO app_settings (id, offloadmq_url) VALUES (1, 'https://offloadmq.alexgr.space/') ON CONFLICT (id) DO NOTHING",
                )
                .await
                .map(|_| ())
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(AppSettings::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum AppSettings {
        Table,
        Id,
        OffloadmqUrl,
        ClientApiToken,
        ManagementApiToken,
    }
}

mod m20260522_000004_create_chats {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000004_create_chats"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(Chats::Table)
                        .if_not_exists()
                        .col(ColumnDef::new(Chats::Id).big_integer().not_null().primary_key())
                        .col(ColumnDef::new(Chats::UserId).big_integer().not_null())
                        .col(ColumnDef::new(Chats::Title).text().not_null().default(""))
                        .col(
                            ColumnDef::new(Chats::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(Chats::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(Chats::Table)
                        .col(Chats::UserId)
                        .name("idx_chats_user_id")
                        .to_owned(),
                )
                .await?;

            manager
                .create_table(
                    Table::create()
                        .table(ChatMessages::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ChatMessages::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ChatMessages::ChatId).big_integer().not_null())
                        .col(ColumnDef::new(ChatMessages::Role).text().not_null())
                        .col(
                            ColumnDef::new(ChatMessages::Content)
                                .text()
                                .not_null()
                                .default(""),
                        )
                        .col(
                            ColumnDef::new(ChatMessages::Status)
                                .text()
                                .not_null()
                                .default("complete"),
                        )
                        .col(ColumnDef::new(ChatMessages::Model).text().null())
                        .col(
                            ColumnDef::new(ChatMessages::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ChatMessages::Table, ChatMessages::ChatId)
                                .to(Chats::Table, Chats::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ChatMessages::Table)
                        .col(ChatMessages::ChatId)
                        .name("idx_chat_messages_chat_id")
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ChatMessages::Table).to_owned())
                .await?;
            manager
                .drop_table(Table::drop().table(Chats::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Chats {
        Table,
        Id,
        UserId,
        Title,
        CreatedAt,
        UpdatedAt,
    }

    #[derive(Iden)]
    enum ChatMessages {
        Table,
        Id,
        ChatId,
        Role,
        Content,
        Status,
        Model,
        CreatedAt,
    }
}

mod m20260522_000002_add_admin_and_quotas_fields {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000002_add_admin_and_quotas_fields"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Users::Table)
                        .add_column(
                            ColumnDef::new(Users::LastQuotasUpdateTimestamp)
                                .timestamp_with_time_zone()
                                .null(),
                        )
                        .add_column(ColumnDef::new(Users::IsAdmin).boolean().null())
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Users::Table)
                        .drop_column(Users::LastQuotasUpdateTimestamp)
                        .drop_column(Users::IsAdmin)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        LastQuotasUpdateTimestamp,
        IsAdmin,
    }
}

mod m20240101_000001_create_users {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20240101_000001_create_users"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(Users::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(Users::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(
                            ColumnDef::new(Users::Login)
                                .string_len(255)
                                .not_null()
                                .unique_key(),
                        )
                        .col(ColumnDef::new(Users::PasswordHash).string_len(255))
                        .col(
                            ColumnDef::new(Users::GoogleId)
                                .string_len(255)
                                .unique_key(),
                        )
                        .col(
                            ColumnDef::new(Users::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(Users::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        Id,
        Login,
        PasswordHash,
        GoogleId,
        CreatedAt,
    }
}
