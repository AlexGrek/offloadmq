use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// An access or refresh token, keyed by the SHA-256 hex of the token itself.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "oauth_tokens")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub token_hash: String,
    pub grant_id: i64,
    pub user_id: i64,
    /// `access` or `refresh`.
    pub kind: String,
    pub expires_at: DateTimeWithTimeZone,
    pub revoked_at: Option<DateTimeWithTimeZone>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
