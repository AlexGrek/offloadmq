//! OAuth 2.1 authorization server state for the MCP endpoint (`/mcp`): dynamically
//! registered clients, single-use authorization codes, per-connection grants, and the
//! access/refresh tokens issued under them. Codes and tokens are stored as SHA-256
//! hex only — a database leak exposes no usable credential.

use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261009_000035_create_oauth_tables"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(OauthClients::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(OauthClients::ClientId)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(OauthClients::ClientName).text().not_null())
                    .col(
                        ColumnDef::new(OauthClients::RedirectUrisJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(OauthClients::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(OauthAuthCodes::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(OauthAuthCodes::CodeHash)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(OauthAuthCodes::ClientId).text().not_null())
                    .col(
                        ColumnDef::new(OauthAuthCodes::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(OauthAuthCodes::RedirectUri)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(OauthAuthCodes::CodeChallenge)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(OauthAuthCodes::Scope).text().not_null())
                    .col(ColumnDef::new(OauthAuthCodes::Resource).text().null())
                    .col(
                        ColumnDef::new(OauthAuthCodes::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(OauthAuthCodes::UsedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(OauthAuthCodes::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(OauthGrants::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(OauthGrants::Id)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(OauthGrants::UserId).big_integer().not_null())
                    .col(ColumnDef::new(OauthGrants::ClientId).text().not_null())
                    .col(ColumnDef::new(OauthGrants::Scope).text().not_null())
                    .col(
                        ColumnDef::new(OauthGrants::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(OauthGrants::LastUsedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(OauthGrants::RevokedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(OauthGrants::Table)
                    .col(OauthGrants::UserId)
                    .name("idx_oauth_grants_user")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(OauthGrants::Table)
                    .col(OauthGrants::ClientId)
                    .name("idx_oauth_grants_client")
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(OauthTokens::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(OauthTokens::TokenHash)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(OauthTokens::GrantId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(OauthTokens::UserId).big_integer().not_null())
                    .col(ColumnDef::new(OauthTokens::Kind).text().not_null())
                    .col(
                        ColumnDef::new(OauthTokens::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(OauthTokens::RevokedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(OauthTokens::CreatedAt)
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
                    .table(OauthTokens::Table)
                    .col(OauthTokens::GrantId)
                    .name("idx_oauth_tokens_grant")
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(OauthTokens::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(OauthGrants::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(OauthAuthCodes::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(OauthClients::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum OauthClients {
    Table,
    ClientId,
    ClientName,
    RedirectUrisJson,
    CreatedAt,
}

#[derive(DeriveIden)]
enum OauthAuthCodes {
    Table,
    CodeHash,
    ClientId,
    UserId,
    RedirectUri,
    CodeChallenge,
    Scope,
    Resource,
    ExpiresAt,
    UsedAt,
    CreatedAt,
}

#[derive(DeriveIden)]
enum OauthGrants {
    Table,
    Id,
    UserId,
    ClientId,
    Scope,
    CreatedAt,
    LastUsedAt,
    RevokedAt,
}

#[derive(DeriveIden)]
enum OauthTokens {
    Table,
    TokenHash,
    GrantId,
    UserId,
    Kind,
    ExpiresAt,
    RevokedAt,
    CreatedAt,
}
