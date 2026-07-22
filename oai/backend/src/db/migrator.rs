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
            Box::new(m20260522_000007_add_user_used_storage::Migration),
            Box::new(m20260522_000008_chat_system_prompts::Migration),
            Box::new(m20260522_000009_create_llm_capabilities::Migration),
            Box::new(m20260522_000010_image_job_pipeline_params::Migration),
            Box::new(m20260522_000011_image_job_display_name::Migration),
            Box::new(m20260522_000012_chat_last_model::Migration),
            Box::new(m20260522_000013_chat_message_offload_fields::Migration),
            Box::new(m20260522_000014_image_file_thumbnails::Migration),
            Box::new(m20260522_000015_create_imggen_capabilities::Migration),
            Box::new(m20260522_000016_create_image_analysis_jobs::Migration),
            Box::new(m20260522_000017_create_tts_jobs::Migration),
            Box::new(m20260522_000018_create_generation_parameters::Migration),
            Box::new(m20260524_000019_create_nude_detect_jobs::Migration),
            Box::new(m20260604_000020_image_analysis_data_preparation::Migration),
            Box::new(m20260604_000021_create_chat_attachments::Migration),
            Box::new(m20260604_000022_create_music_generation_jobs::Migration),
            Box::new(m20260604_000023_create_prompt_entries::Migration),
            Box::new(m20260613_000024_image_offload_task_started_at::Migration),
            Box::new(m20260615_000025_create_llm_compare_debate_jobs::Migration),
            Box::new(m20260615_000026_image_offload_typical_runtime::Migration),
            Box::new(m20260709_000027_image_offload_task_finished_at::Migration),
            Box::new(m20260722_000028_create_img_utils_jobs::Migration),
        ]
    }
}

/// Generic per-user prompt storage with named buckets (e.g. `llm-system`,
/// `describe-image-user`). Each entry is either a `recent` (auto-managed history,
/// last 10 unique per bucket) or a `starred` favorite (user-curated, editable).
/// Replaces the chat-only `user_system_prompts` table — existing rows are migrated
/// into the `llm-system` bucket before the old table is dropped.
mod m20260604_000023_create_prompt_entries {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260604_000023_create_prompt_entries"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(PromptEntries::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(PromptEntries::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(PromptEntries::UserId).big_integer().not_null())
                        .col(ColumnDef::new(PromptEntries::Bucket).text().not_null())
                        .col(ColumnDef::new(PromptEntries::Kind).text().not_null())
                        .col(ColumnDef::new(PromptEntries::Content).text().not_null())
                        .col(
                            ColumnDef::new(PromptEntries::LastUsedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(PromptEntries::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(PromptEntries::UpdatedAt)
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
                        .table(PromptEntries::Table)
                        .col(PromptEntries::UserId)
                        .col(PromptEntries::Bucket)
                        .col(PromptEntries::Kind)
                        .col(PromptEntries::LastUsedAt)
                        .name("idx_prompt_entries_user_bucket_kind")
                        .to_owned(),
                )
                .await?;

            // Migrate existing chat system prompts into the new bucket, then drop
            // the old table. Starred rows become favorites; the rest become recents.
            let db = manager.get_connection();
            db.execute_unprepared(
                "INSERT INTO prompt_entries \
                   (id, user_id, bucket, kind, content, last_used_at, created_at, updated_at) \
                 SELECT id, user_id, 'llm-system', \
                        CASE WHEN starred THEN 'starred' ELSE 'recent' END, \
                        content, last_used_at, created_at, last_used_at \
                 FROM user_system_prompts",
            )
            .await?;

            manager
                .drop_table(Table::drop().table(UserSystemPrompts::Table).to_owned())
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            // Recreate the old (empty) table so a rollback leaves a usable schema.
            manager
                .create_table(
                    Table::create()
                        .table(UserSystemPrompts::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(UserSystemPrompts::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(UserSystemPrompts::UserId).big_integer().not_null())
                        .col(ColumnDef::new(UserSystemPrompts::Content).text().not_null())
                        .col(
                            ColumnDef::new(UserSystemPrompts::Starred)
                                .boolean()
                                .not_null()
                                .default(false),
                        )
                        .col(
                            ColumnDef::new(UserSystemPrompts::LastUsedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(UserSystemPrompts::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .drop_table(Table::drop().table(PromptEntries::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum PromptEntries {
        Table,
        Id,
        UserId,
        Bucket,
        Kind,
        Content,
        LastUsedAt,
        CreatedAt,
        UpdatedAt,
    }

    #[derive(Iden)]
    enum UserSystemPrompts {
        Table,
        Id,
        UserId,
        Content,
        Starred,
        LastUsedAt,
        CreatedAt,
    }
}

mod m20260604_000022_create_music_generation_jobs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260604_000022_create_music_generation_jobs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(MusicGenerationJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(MusicGenerationJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(MusicGenerationJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(MusicGenerationJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(MusicGenerationJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(MusicGenerationJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(ColumnDef::new(MusicGenerationJobs::Capability).text().not_null())
                        .col(ColumnDef::new(MusicGenerationJobs::OffloadCap).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::OffloadTaskId).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::OutputBucketUid).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Tags).text().not_null())
                        .col(ColumnDef::new(MusicGenerationJobs::Lyrics).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Bpm).integer().null())
                        .col(
                            ColumnDef::new(MusicGenerationJobs::Duration)
                                .integer()
                                .not_null()
                                .default(30),
                        )
                        .col(ColumnDef::new(MusicGenerationJobs::Seed).integer().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Language).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Keyscale).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::CfgScale).double().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Temperature).double().null())
                        .col(ColumnDef::new(MusicGenerationJobs::ResultSeed).integer().null())
                        .col(ColumnDef::new(MusicGenerationJobs::AudioFilesJson).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Stage).text().null())
                        .col(ColumnDef::new(MusicGenerationJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(MusicGenerationJobs::Table, MusicGenerationJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(MusicGenerationJobs::Table)
                        .name("idx_music_generation_jobs_user_id")
                        .col(MusicGenerationJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(MusicGenerationJobs::Table)
                        .name("idx_music_generation_jobs_status")
                        .col(MusicGenerationJobs::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(MusicGenerationJobs::Table).to_owned())
                .await
        }
    }

    #[derive(DeriveIden)]
    enum MusicGenerationJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Capability,
        OffloadCap,
        OffloadTaskId,
        OutputBucketUid,
        Tags,
        Lyrics,
        Bpm,
        Duration,
        Seed,
        Language,
        Keyscale,
        CfgScale,
        Temperature,
        ResultSeed,
        AudioFilesJson,
        Stage,
        Error,
    }

    #[derive(DeriveIden)]
    enum Users {
        Table,
        Id,
    }
}

mod m20260604_000021_create_chat_attachments {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260604_000021_create_chat_attachments"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ChatAttachments::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ChatAttachments::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ChatAttachments::UserId).big_integer().not_null())
                        // Set when the attachment is linked to a sent user message;
                        // null while it is only pre-uploaded (not yet referenced).
                        .col(ColumnDef::new(ChatAttachments::MessageId).big_integer().null())
                        .col(ColumnDef::new(ChatAttachments::ChatId).big_integer().null())
                        // "image" | "document"
                        .col(ColumnDef::new(ChatAttachments::Kind).text().not_null())
                        .col(ColumnDef::new(ChatAttachments::Filename).text().not_null())
                        .col(ColumnDef::new(ChatAttachments::ContentType).text().not_null())
                        .col(
                            ColumnDef::new(ChatAttachments::SizeBytes)
                                .big_integer()
                                .not_null()
                                .default(0),
                        )
                        // For kind="image": references image_files.id (uploads + generated).
                        .col(ColumnDef::new(ChatAttachments::ImageFileId).big_integer().null())
                        // For kind="document": OAI storage path of the stored doc bytes.
                        .col(ColumnDef::new(ChatAttachments::StoragePath).text().null())
                        .col(ColumnDef::new(ChatAttachments::Sha256).text().null())
                        .col(
                            ColumnDef::new(ChatAttachments::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .foreign_key(
                            ForeignKey::create()
                                .from(ChatAttachments::Table, ChatAttachments::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ChatAttachments::Table)
                        .name("idx_chat_attachments_message_id")
                        .col(ChatAttachments::MessageId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ChatAttachments::Table)
                        .name("idx_chat_attachments_user_id")
                        .col(ChatAttachments::UserId)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ChatAttachments::Table).to_owned())
                .await
        }
    }

    #[derive(DeriveIden)]
    enum ChatAttachments {
        Table,
        Id,
        UserId,
        MessageId,
        ChatId,
        Kind,
        Filename,
        ContentType,
        SizeBytes,
        ImageFileId,
        StoragePath,
        Sha256,
        CreatedAt,
    }

    #[derive(DeriveIden)]
    enum Users {
        Table,
        Id,
    }
}

mod m20260522_000018_create_generation_parameters {
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
}

mod m20260522_000017_create_tts_jobs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000017_create_tts_jobs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(TtsJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(TtsJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(TtsJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(TtsJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(TtsJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(TtsJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(ColumnDef::new(TtsJobs::Text).text().not_null())
                        .col(ColumnDef::new(TtsJobs::Capability).text().not_null())
                        .col(ColumnDef::new(TtsJobs::Voice).text().not_null())
                        .col(ColumnDef::new(TtsJobs::Model).text().not_null())
                        .col(ColumnDef::new(TtsJobs::OffloadCap).text().null())
                        .col(ColumnDef::new(TtsJobs::OffloadTaskId).text().null())
                        .col(ColumnDef::new(TtsJobs::AudioStoragePath).text().null())
                        .col(ColumnDef::new(TtsJobs::AudioContentType).text().null())
                        .col(ColumnDef::new(TtsJobs::AudioSizeBytes).big_integer().null())
                        .col(ColumnDef::new(TtsJobs::Stage).text().null())
                        .col(ColumnDef::new(TtsJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(TtsJobs::Table, TtsJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(TtsJobs::Table)
                        .name("idx_tts_jobs_user_id")
                        .col(TtsJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(TtsJobs::Table)
                        .name("idx_tts_jobs_status")
                        .col(TtsJobs::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(TtsJobs::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        Id,
    }

    #[derive(Iden)]
    enum TtsJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Text,
        Capability,
        Voice,
        Model,
        OffloadCap,
        OffloadTaskId,
        AudioStoragePath,
        AudioContentType,
        AudioSizeBytes,
        Stage,
        Error,
    }
}

mod m20260522_000016_create_image_analysis_jobs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000016_create_image_analysis_jobs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ImageAnalysisJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImageAnalysisJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImageAnalysisJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(ImageAnalysisJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImageAnalysisJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImageAnalysisJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(ColumnDef::new(ImageAnalysisJobs::Prompt).text().not_null())
                        .col(ColumnDef::new(ImageAnalysisJobs::Capability).text().not_null())
                        .col(ColumnDef::new(ImageAnalysisJobs::InputImageId).big_integer().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::OffloadCap).text().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::OffloadTaskId).text().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::OffloadBucketUid).text().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::Result).text().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::Stage).text().null())
                        .col(ColumnDef::new(ImageAnalysisJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImageAnalysisJobs::Table, ImageAnalysisJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageAnalysisJobs::Table)
                        .name("idx_image_analysis_jobs_user_id")
                        .col(ImageAnalysisJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImageAnalysisJobs::Table)
                        .name("idx_image_analysis_jobs_status")
                        .col(ImageAnalysisJobs::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ImageAnalysisJobs::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        Id,
    }

    #[derive(Iden)]
    enum ImageAnalysisJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Prompt,
        Capability,
        InputImageId,
        OffloadCap,
        OffloadTaskId,
        OffloadBucketUid,
        Result,
        Stage,
        Error,
    }
}

mod m20260522_000014_image_file_thumbnails {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000014_image_file_thumbnails"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageFiles::Table)
                        .add_column(
                            ColumnDef::new(ImageFiles::ThumbnailStoragePath)
                                .text()
                                .null(),
                        )
                        .add_column(
                            ColumnDef::new(ImageFiles::ThumbnailStoredBytes)
                                .big_integer()
                                .not_null()
                                .default(0),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageFiles::Table)
                        .drop_column(ImageFiles::ThumbnailStoredBytes)
                        .drop_column(ImageFiles::ThumbnailStoragePath)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum ImageFiles {
        Table,
        ThumbnailStoragePath,
        ThumbnailStoredBytes,
    }
}

mod m20260522_000015_create_imggen_capabilities {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000015_create_imggen_capabilities"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ImggenCapabilities::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImggenCapabilities::Base)
                                .text()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImggenCapabilities::TagsJson).text().not_null())
                        .col(ColumnDef::new(ImggenCapabilities::Raw).text().not_null())
                        .col(
                            ColumnDef::new(ImggenCapabilities::LastAvailableAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImggenCapabilities::CreatedAt)
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
                        .table(ImggenCapabilities::Table)
                        .name("idx_imggen_capabilities_last_available_at")
                        .col(ImggenCapabilities::LastAvailableAt)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ImggenCapabilities::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum ImggenCapabilities {
        Table,
        Base,
        TagsJson,
        Raw,
        LastAvailableAt,
        CreatedAt,
    }
}

mod m20260522_000013_chat_message_offload_fields {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000013_chat_message_offload_fields"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            // Track the offload task behind an in-flight (status="pending") assistant
            // reply so a background worker can reconcile it regardless of the WS.
            manager
                .alter_table(
                    Table::alter()
                        .table(ChatMessages::Table)
                        .add_column(ColumnDef::new(ChatMessages::OffloadCap).text().null())
                        .add_column(ColumnDef::new(ChatMessages::OffloadTaskId).text().null())
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ChatMessages::Table)
                        .name("idx_chat_messages_status")
                        .col(ChatMessages::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_index(
                    Index::drop()
                        .name("idx_chat_messages_status")
                        .table(ChatMessages::Table)
                        .to_owned(),
                )
                .await?;
            manager
                .alter_table(
                    Table::alter()
                        .table(ChatMessages::Table)
                        .drop_column(ChatMessages::OffloadCap)
                        .drop_column(ChatMessages::OffloadTaskId)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum ChatMessages {
        Table,
        Status,
        OffloadCap,
        OffloadTaskId,
    }
}

mod m20260522_000012_chat_last_model {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000012_chat_last_model"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Chats::Table)
                        .add_column(ColumnDef::new(Chats::LastModel).string().null())
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Chats::Table)
                        .drop_column(Chats::LastModel)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum Chats {
        Table,
        LastModel,
    }
}

mod m20260522_000011_image_job_display_name {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000011_image_job_display_name"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageGenerationJobs::Table)
                        .add_column(
                            ColumnDef::new(ImageGenerationJobs::DisplayName)
                                .text()
                                .not_null()
                                .default(""),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageGenerationJobs::Table)
                        .drop_column(ImageGenerationJobs::DisplayName)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum ImageGenerationJobs {
        Table,
        DisplayName,
    }
}

mod m20260522_000010_image_job_pipeline_params {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000010_image_job_pipeline_params"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageGenerationJobs::Table)
                        .add_column(
                            ColumnDef::new(ImageGenerationJobs::PipelineParamsJson)
                                .text()
                                .not_null()
                                .default("{}"),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageGenerationJobs::Table)
                        .drop_column(ImageGenerationJobs::PipelineParamsJson)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum ImageGenerationJobs {
        Table,
        PipelineParamsJson,
    }
}

mod m20260522_000009_create_llm_capabilities {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000009_create_llm_capabilities"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(LlmCapabilities::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(LlmCapabilities::Base)
                                .text()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(LlmCapabilities::TagsJson).text().not_null())
                        .col(ColumnDef::new(LlmCapabilities::Raw).text().not_null())
                        .col(
                            ColumnDef::new(LlmCapabilities::LastAvailableAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(LlmCapabilities::CreatedAt)
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
                        .table(LlmCapabilities::Table)
                        .name("idx_llm_capabilities_last_available_at")
                        .col(LlmCapabilities::LastAvailableAt)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(LlmCapabilities::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum LlmCapabilities {
        Table,
        Base,
        TagsJson,
        Raw,
        LastAvailableAt,
        CreatedAt,
    }
}

mod m20260522_000008_chat_system_prompts {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000008_chat_system_prompts"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Chats::Table)
                        .add_column(
                            ColumnDef::new(Chats::SystemPrompt)
                                .text()
                                .not_null()
                                .default(""),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_table(
                    Table::create()
                        .table(UserSystemPrompts::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(UserSystemPrompts::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(
                            ColumnDef::new(UserSystemPrompts::UserId)
                                .big_integer()
                                .not_null(),
                        )
                        .col(ColumnDef::new(UserSystemPrompts::Content).text().not_null())
                        .col(
                            ColumnDef::new(UserSystemPrompts::Starred)
                                .boolean()
                                .not_null()
                                .default(false),
                        )
                        .col(
                            ColumnDef::new(UserSystemPrompts::LastUsedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(UserSystemPrompts::CreatedAt)
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
                        .table(UserSystemPrompts::Table)
                        .col(UserSystemPrompts::UserId)
                        .col(UserSystemPrompts::LastUsedAt)
                        .name("idx_user_system_prompts_user_last_used")
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(UserSystemPrompts::Table)
                        .col(UserSystemPrompts::UserId)
                        .col(UserSystemPrompts::Starred)
                        .name("idx_user_system_prompts_user_starred")
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(UserSystemPrompts::Table).to_owned())
                .await?;
            manager
                .alter_table(
                    Table::alter()
                        .table(Chats::Table)
                        .drop_column(Chats::SystemPrompt)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum Chats {
        Table,
        SystemPrompt,
    }

    #[derive(Iden)]
    enum UserSystemPrompts {
        Table,
        Id,
        UserId,
        Content,
        Starred,
        LastUsedAt,
        CreatedAt,
    }
}

mod m20260522_000007_add_user_used_storage {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260522_000007_add_user_used_storage"
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
                            ColumnDef::new(Users::UsedStorageBytes)
                                .big_integer()
                                .not_null()
                                .default(0),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(Users::Table)
                        .drop_column(Users::UsedStorageBytes)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        UsedStorageBytes,
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

mod m20260524_000019_create_nude_detect_jobs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260524_000019_create_nude_detect_jobs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(NudeDetectJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(NudeDetectJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(NudeDetectJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(NudeDetectJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(NudeDetectJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(NudeDetectJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(
                            ColumnDef::new(NudeDetectJobs::Threshold)
                                .double()
                                .not_null()
                                .default(0.25),
                        )
                        .col(ColumnDef::new(NudeDetectJobs::InputImageId).big_integer().null())
                        .col(ColumnDef::new(NudeDetectJobs::OffloadCap).text().null())
                        .col(ColumnDef::new(NudeDetectJobs::OffloadTaskId).text().null())
                        .col(ColumnDef::new(NudeDetectJobs::OffloadBucketUid).text().null())
                        .col(ColumnDef::new(NudeDetectJobs::Result).text().null())
                        .col(ColumnDef::new(NudeDetectJobs::Stage).text().null())
                        .col(ColumnDef::new(NudeDetectJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(NudeDetectJobs::Table, NudeDetectJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(NudeDetectJobs::Table)
                        .name("idx_nude_detect_jobs_user_id")
                        .col(NudeDetectJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(NudeDetectJobs::Table)
                        .name("idx_nude_detect_jobs_status")
                        .col(NudeDetectJobs::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(NudeDetectJobs::Table).to_owned())
                .await
        }
    }

    #[derive(DeriveIden)]
    enum NudeDetectJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Threshold,
        InputImageId,
        OffloadCap,
        OffloadTaskId,
        OffloadBucketUid,
        Result,
        Stage,
        Error,
    }

    #[derive(DeriveIden)]
    enum Users {
        Table,
        Id,
    }
}

mod m20260604_000020_image_analysis_data_preparation {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260604_000020_image_analysis_data_preparation"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageAnalysisJobs::Table)
                        .add_column(
                            ColumnDef::new(ImageAnalysisJobs::DataPreparation).text().null(),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageAnalysisJobs::Table)
                        .drop_column(ImageAnalysisJobs::DataPreparation)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(DeriveIden)]
    enum ImageAnalysisJobs {
        Table,
        DataPreparation,
    }
}

mod m20260613_000024_image_offload_task_started_at {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260613_000024_image_offload_task_started_at"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .add_column(
                            ColumnDef::new(ImageOffloadTasks::StartedAt)
                                .timestamp_with_time_zone()
                                .null(),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .drop_column(ImageOffloadTasks::StartedAt)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(DeriveIden)]
    enum ImageOffloadTasks {
        Table,
        StartedAt,
    }
}

mod m20260615_000025_create_llm_compare_debate_jobs {
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
}

mod m20260615_000026_image_offload_typical_runtime {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260615_000026_image_offload_typical_runtime"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .add_column(
                            ColumnDef::new(ImageOffloadTasks::TypicalRuntimeSeconds)
                                .double()
                                .null(),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .drop_column(ImageOffloadTasks::TypicalRuntimeSeconds)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(DeriveIden)]
    enum ImageOffloadTasks {
        Table,
        TypicalRuntimeSeconds,
    }
}

mod m20260709_000027_image_offload_task_finished_at {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260709_000027_image_offload_task_finished_at"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .add_column(
                            ColumnDef::new(ImageOffloadTasks::FinishedAt)
                                .timestamp_with_time_zone()
                                .null(),
                        )
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .alter_table(
                    Table::alter()
                        .table(ImageOffloadTasks::Table)
                        .drop_column(ImageOffloadTasks::FinishedAt)
                        .to_owned(),
                )
                .await
        }
    }

    #[derive(DeriveIden)]
    enum ImageOffloadTasks {
        Table,
        FinishedAt,
    }
}

/// `img-utils.*` jobs — one-shot ComfyUI image transforms (depth map, face swap,
/// …). Each job references one or two uploaded `image_files` rows as input and
/// stores the produced image as another `image_files` row.
mod m20260722_000028_create_img_utils_jobs {
    use sea_orm_migration::prelude::*;

    pub struct Migration;

    impl MigrationName for Migration {
        fn name(&self) -> &str {
            "m20260722_000028_create_img_utils_jobs"
        }
    }

    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .create_table(
                    Table::create()
                        .table(ImgUtilsJobs::Table)
                        .if_not_exists()
                        .col(
                            ColumnDef::new(ImgUtilsJobs::Id)
                                .big_integer()
                                .not_null()
                                .primary_key(),
                        )
                        .col(ColumnDef::new(ImgUtilsJobs::UserId).big_integer().not_null())
                        .col(
                            ColumnDef::new(ImgUtilsJobs::CreatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImgUtilsJobs::UpdatedAt)
                                .timestamp_with_time_zone()
                                .not_null()
                                .default(Expr::current_timestamp()),
                        )
                        .col(
                            ColumnDef::new(ImgUtilsJobs::Status)
                                .text()
                                .not_null()
                                .default("created"),
                        )
                        .col(ColumnDef::new(ImgUtilsJobs::Capability).text().not_null())
                        .col(ColumnDef::new(ImgUtilsJobs::Utility).text().not_null())
                        .col(ColumnDef::new(ImgUtilsJobs::Workflow).text().not_null())
                        .col(ColumnDef::new(ImgUtilsJobs::InputImageId).big_integer().null())
                        .col(ColumnDef::new(ImgUtilsJobs::SourceImageId).big_integer().null())
                        .col(ColumnDef::new(ImgUtilsJobs::OptionsJson).text().null())
                        .col(ColumnDef::new(ImgUtilsJobs::OffloadCap).text().null())
                        .col(ColumnDef::new(ImgUtilsJobs::OffloadTaskId).text().null())
                        .col(ColumnDef::new(ImgUtilsJobs::OutputBucketUid).text().null())
                        .col(ColumnDef::new(ImgUtilsJobs::OutputImageId).big_integer().null())
                        .col(ColumnDef::new(ImgUtilsJobs::Stage).text().null())
                        .col(ColumnDef::new(ImgUtilsJobs::Error).text().null())
                        .foreign_key(
                            ForeignKey::create()
                                .from(ImgUtilsJobs::Table, ImgUtilsJobs::UserId)
                                .to(Users::Table, Users::Id)
                                .on_delete(ForeignKeyAction::Cascade),
                        )
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImgUtilsJobs::Table)
                        .name("idx_img_utils_jobs_user_id")
                        .col(ImgUtilsJobs::UserId)
                        .to_owned(),
                )
                .await?;

            manager
                .create_index(
                    Index::create()
                        .table(ImgUtilsJobs::Table)
                        .name("idx_img_utils_jobs_status")
                        .col(ImgUtilsJobs::Status)
                        .to_owned(),
                )
                .await
        }

        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .drop_table(Table::drop().table(ImgUtilsJobs::Table).to_owned())
                .await
        }
    }

    #[derive(Iden)]
    enum Users {
        Table,
        Id,
    }

    #[derive(Iden)]
    enum ImgUtilsJobs {
        Table,
        Id,
        UserId,
        CreatedAt,
        UpdatedAt,
        Status,
        Capability,
        Utility,
        Workflow,
        InputImageId,
        SourceImageId,
        OptionsJson,
        OffloadCap,
        OffloadTaskId,
        OutputBucketUid,
        OutputImageId,
        Stage,
        Error,
    }
}
