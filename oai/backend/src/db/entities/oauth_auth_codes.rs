use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A single-use authorization code, keyed by the SHA-256 hex of the code itself.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "oauth_auth_codes")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub code_hash: String,
    pub client_id: String,
    pub user_id: i64,
    pub redirect_uri: String,
    /// PKCE S256 challenge sent with the authorization request.
    pub code_challenge: String,
    pub scope: String,
    /// RFC 8707 `resource` indicator, when the client sent one.
    pub resource: Option<String>,
    pub expires_at: DateTimeWithTimeZone,
    /// Set when the code is exchanged; a code is never accepted twice.
    pub used_at: Option<DateTimeWithTimeZone>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
