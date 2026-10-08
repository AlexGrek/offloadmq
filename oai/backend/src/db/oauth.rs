//! Storage for the MCP OAuth authorization server: clients, authorization codes,
//! grants and tokens. Codes and tokens arrive here already hashed — the plaintext
//! never touches the database. Protocol rules (PKCE, rotation, expiry policy) live in
//! `services::oauth`; this module only does the reads and the race-safe writes.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend,
    EntityTrait, QueryFilter, Statement, sea_query::Expr,
};

use crate::{
    db::entities::{
        oauth_auth_codes::{self, Entity as CodeEntity},
        oauth_clients::{self, Entity as ClientEntity},
        oauth_grants::{self, Entity as GrantEntity},
        oauth_tokens::{self, Entity as TokenEntity},
    },
    error::AppError,
};

pub type Client = oauth_clients::Model;
pub type AuthCode = oauth_auth_codes::Model;
pub type Grant = oauth_grants::Model;
pub type Token = oauth_tokens::Model;

pub const KIND_ACCESS: &str = "access";
pub const KIND_REFRESH: &str = "refresh";

type Timestamp = chrono::DateTime<chrono::FixedOffset>;

fn now() -> Timestamp {
    chrono::Utc::now().fixed_offset()
}

// ── Clients ──────────────────────────────────────────────────────────────────

pub async fn create_client(
    db: &DatabaseConnection,
    client_id: &str,
    client_name: &str,
    redirect_uris: &[String],
) -> Result<Client, AppError> {
    let redirect_uris_json =
        serde_json::to_string(redirect_uris).map_err(|e| AppError::Internal(e.to_string()))?;
    oauth_clients::ActiveModel {
        client_id: ActiveValue::Set(client_id.to_string()),
        client_name: ActiveValue::Set(client_name.to_string()),
        redirect_uris_json: ActiveValue::Set(redirect_uris_json),
        created_at: ActiveValue::Set(now()),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

pub async fn find_client(
    db: &DatabaseConnection,
    client_id: &str,
) -> Result<Option<Client>, AppError> {
    ClientEntity::find_by_id(client_id.to_string())
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub fn client_redirect_uris(client: &Client) -> Vec<String> {
    serde_json::from_str(&client.redirect_uris_json).unwrap_or_default()
}

// ── Authorization codes ──────────────────────────────────────────────────────

pub struct NewAuthCode<'a> {
    pub code_hash: &'a str,
    pub client_id: &'a str,
    pub user_id: i64,
    pub redirect_uri: &'a str,
    pub code_challenge: &'a str,
    pub scope: &'a str,
    pub resource: Option<&'a str>,
    pub expires_at: Timestamp,
}

pub async fn create_code(db: &DatabaseConnection, code: NewAuthCode<'_>) -> Result<(), AppError> {
    oauth_auth_codes::ActiveModel {
        code_hash: ActiveValue::Set(code.code_hash.to_string()),
        client_id: ActiveValue::Set(code.client_id.to_string()),
        user_id: ActiveValue::Set(code.user_id),
        redirect_uri: ActiveValue::Set(code.redirect_uri.to_string()),
        code_challenge: ActiveValue::Set(code.code_challenge.to_string()),
        scope: ActiveValue::Set(code.scope.to_string()),
        resource: ActiveValue::Set(code.resource.map(str::to_string)),
        expires_at: ActiveValue::Set(code.expires_at),
        used_at: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now()),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// Marks an unused, unexpired code as used and returns it. The conditional UPDATE is
/// what makes a code single-use even under concurrent exchanges: only one caller can
/// flip `used_at` from NULL. Returns `None` for unknown, expired or already-used codes.
pub async fn consume_code(
    db: &DatabaseConnection,
    code_hash: &str,
) -> Result<Option<AuthCode>, AppError> {
    let at = now();
    let result = CodeEntity::update_many()
        .col_expr(oauth_auth_codes::Column::UsedAt, Expr::value(at))
        .filter(oauth_auth_codes::Column::CodeHash.eq(code_hash))
        .filter(oauth_auth_codes::Column::UsedAt.is_null())
        .filter(oauth_auth_codes::Column::ExpiresAt.gt(at))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected != 1 {
        return Ok(None);
    }
    CodeEntity::find_by_id(code_hash.to_string())
        .one(db)
        .await
        .map_err(AppError::Database)
}

// ── Grants ───────────────────────────────────────────────────────────────────

pub async fn create_grant(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    client_id: &str,
    scope: &str,
) -> Result<Grant, AppError> {
    oauth_grants::ActiveModel {
        id: ActiveValue::Set(id),
        user_id: ActiveValue::Set(user_id),
        client_id: ActiveValue::Set(client_id.to_string()),
        scope: ActiveValue::Set(scope.to_string()),
        created_at: ActiveValue::Set(now()),
        last_used_at: ActiveValue::Set(None),
        revoked_at: ActiveValue::Set(None),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

pub async fn find_grant(db: &DatabaseConnection, id: i64) -> Result<Option<Grant>, AppError> {
    GrantEntity::find_by_id(id)
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// Records that the grant was used, at most once per `min_interval` (so an active MCP
/// session doesn't write a row on every request).
pub async fn touch_grant(
    db: &DatabaseConnection,
    id: i64,
    min_interval: chrono::Duration,
) -> Result<(), AppError> {
    let at = now();
    GrantEntity::update_many()
        .col_expr(oauth_grants::Column::LastUsedAt, Expr::value(at))
        .filter(oauth_grants::Column::Id.eq(id))
        .filter(
            oauth_grants::Column::LastUsedAt
                .is_null()
                .or(oauth_grants::Column::LastUsedAt.lt(at - min_interval)),
        )
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Revokes a grant and every token issued under it.
pub async fn revoke_grant(db: &DatabaseConnection, grant_id: i64) -> Result<(), AppError> {
    let at = now();
    GrantEntity::update_many()
        .col_expr(oauth_grants::Column::RevokedAt, Expr::value(at))
        .filter(oauth_grants::Column::Id.eq(grant_id))
        .filter(oauth_grants::Column::RevokedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    TokenEntity::update_many()
        .col_expr(oauth_tokens::Column::RevokedAt, Expr::value(at))
        .filter(oauth_tokens::Column::GrantId.eq(grant_id))
        .filter(oauth_tokens::Column::RevokedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Revokes every grant (and so every token) the user has — e.g. on password change.
pub async fn revoke_user_grants(db: &DatabaseConnection, user_id: i64) -> Result<(), AppError> {
    let at = now();
    GrantEntity::update_many()
        .col_expr(oauth_grants::Column::RevokedAt, Expr::value(at))
        .filter(oauth_grants::Column::UserId.eq(user_id))
        .filter(oauth_grants::Column::RevokedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    TokenEntity::update_many()
        .col_expr(oauth_tokens::Column::RevokedAt, Expr::value(at))
        .filter(oauth_tokens::Column::UserId.eq(user_id))
        .filter(oauth_tokens::Column::RevokedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

// ── Tokens ───────────────────────────────────────────────────────────────────

pub async fn insert_token(
    db: &DatabaseConnection,
    token_hash: &str,
    grant_id: i64,
    user_id: i64,
    kind: &str,
    expires_at: Timestamp,
) -> Result<(), AppError> {
    oauth_tokens::ActiveModel {
        token_hash: ActiveValue::Set(token_hash.to_string()),
        grant_id: ActiveValue::Set(grant_id),
        user_id: ActiveValue::Set(user_id),
        kind: ActiveValue::Set(kind.to_string()),
        expires_at: ActiveValue::Set(expires_at),
        revoked_at: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now()),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

pub async fn find_token(
    db: &DatabaseConnection,
    token_hash: &str,
) -> Result<Option<Token>, AppError> {
    TokenEntity::find_by_id(token_hash.to_string())
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// Revokes a token only if it is still live; returns whether this call revoked it.
/// Refresh rotation relies on this: of two concurrent refreshes with the same token,
/// exactly one wins.
pub async fn revoke_token_if_active(
    db: &DatabaseConnection,
    token_hash: &str,
) -> Result<bool, AppError> {
    let result = TokenEntity::update_many()
        .col_expr(oauth_tokens::Column::RevokedAt, Expr::value(now()))
        .filter(oauth_tokens::Column::TokenHash.eq(token_hash))
        .filter(oauth_tokens::Column::RevokedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected == 1)
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/// Counts of rows removed by [`cleanup`].
#[derive(Debug, Default)]
pub struct CleanupStats {
    pub codes: u64,
    pub tokens: u64,
    pub grants: u64,
    pub clients: u64,
}

/// Deletes dead OAuth state:
/// - codes expired before now (they are only valid for minutes);
/// - tokens that expired or were revoked before `dead_before`;
/// - revoked grants, and grants left with no tokens, older than `dead_before`;
/// - clients registered before `unused_client_before` that never got a grant
///   (registration is unauthenticated, so this bounds what spam can accumulate).
pub async fn cleanup(
    db: &DatabaseConnection,
    dead_before: Timestamp,
    unused_client_before: Timestamp,
) -> Result<CleanupStats, AppError> {
    let codes = CodeEntity::delete_many()
        .filter(oauth_auth_codes::Column::ExpiresAt.lt(now()))
        .exec(db)
        .await
        .map_err(AppError::Database)?
        .rows_affected;

    let tokens = TokenEntity::delete_many()
        .filter(
            oauth_tokens::Column::ExpiresAt
                .lt(dead_before)
                .or(oauth_tokens::Column::RevokedAt.lt(dead_before)),
        )
        .exec(db)
        .await
        .map_err(AppError::Database)?
        .rows_affected;

    let grants = db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM oauth_grants g WHERE g.created_at < $1 AND (g.revoked_at IS NOT NULL \
             OR NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id))",
            [dead_before.into()],
        ))
        .await
        .map_err(AppError::Database)?
        .rows_affected();

    let clients = db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM oauth_clients c WHERE c.created_at < $1 \
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)",
            [unused_client_before.into()],
        ))
        .await
        .map_err(AppError::Database)?
        .rows_affected();

    Ok(CleanupStats {
        codes,
        tokens,
        grants,
        clients,
    })
}
