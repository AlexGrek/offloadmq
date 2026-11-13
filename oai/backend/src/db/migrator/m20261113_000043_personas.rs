use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261113_000043_personas"
    }
}

/// Personas: reusable characters (faces, look, system prompt, model preferences),
/// their photo-pipeline parent jobs, and `chats.persona_id` for persona chats.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Personas::Table)
                    .col(
                        ColumnDef::new(Personas::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Personas::UserId).big_integer().not_null())
                    .col(ColumnDef::new(Personas::Name).text().not_null())
                    .col(
                        ColumnDef::new(Personas::SystemPrompt)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(ColumnDef::new(Personas::Look).text().not_null().default(""))
                    .col(
                        ColumnDef::new(Personas::FaceImageIdsJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(ColumnDef::new(Personas::LlmCapability).text())
                    .col(ColumnDef::new(Personas::Txt2imgCapability).text())
                    .col(ColumnDef::new(Personas::Img2imgCapability).text())
                    .col(ColumnDef::new(Personas::FaceSwapCapability).text())
                    .col(ColumnDef::new(Personas::UpscalerCapability).text())
                    .col(
                        ColumnDef::new(Personas::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Personas::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Personas::Table, Personas::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personas_user")
                    .table(Personas::Table)
                    .col(Personas::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PersonaPhotoJobs::Table)
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::PersonaId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonaPhotoJobs::Status).text().not_null())
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::PromptTemplate)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonaPhotoJobs::Prompt).text().not_null())
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::ParamsJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonaPhotoJobs::StepsJson)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonaPhotoJobs::FinalImageId).big_integer())
                    .col(ColumnDef::new(PersonaPhotoJobs::Error).text())
                    .foreign_key(
                        ForeignKey::create()
                            .from(PersonaPhotoJobs::Table, PersonaPhotoJobs::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(PersonaPhotoJobs::Table, PersonaPhotoJobs::PersonaId)
                            .to(Personas::Table, Personas::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_persona_photo_jobs_persona")
                    .table(PersonaPhotoJobs::Table)
                    .col(PersonaPhotoJobs::UserId)
                    .col(PersonaPhotoJobs::PersonaId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_persona_photo_jobs_status")
                    .table(PersonaPhotoJobs::Table)
                    .col(PersonaPhotoJobs::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .add_column(ColumnDef::new(Chats::PersonaId).big_integer())
                    .add_foreign_key(
                        TableForeignKey::new()
                            .name("fk_chats_persona")
                            .from_tbl(Chats::Table)
                            .from_col(Chats::PersonaId)
                            .to_tbl(Personas::Table)
                            .to_col(Personas::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_chats_persona")
                    .table(Chats::Table)
                    .col(Chats::PersonaId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Chats::Table)
                    .drop_foreign_key(Alias::new("fk_chats_persona"))
                    .drop_column(Chats::PersonaId)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(PersonaPhotoJobs::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Personas::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Personas {
    Table,
    Id,
    UserId,
    Name,
    SystemPrompt,
    Look,
    FaceImageIdsJson,
    LlmCapability,
    #[sea_orm(iden = "txt2img_capability")]
    Txt2imgCapability,
    #[sea_orm(iden = "img2img_capability")]
    Img2imgCapability,
    FaceSwapCapability,
    UpscalerCapability,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonaPhotoJobs {
    Table,
    Id,
    UserId,
    PersonaId,
    CreatedAt,
    UpdatedAt,
    Status,
    PromptTemplate,
    Prompt,
    ParamsJson,
    StepsJson,
    FinalImageId,
    Error,
}

#[derive(DeriveIden)]
enum Chats {
    Table,
    PersonaId,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
