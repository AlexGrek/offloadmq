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
