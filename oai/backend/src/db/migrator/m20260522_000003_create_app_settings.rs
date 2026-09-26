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
