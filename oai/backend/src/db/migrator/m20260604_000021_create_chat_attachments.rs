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
