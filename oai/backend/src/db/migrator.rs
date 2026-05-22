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
        ]
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
