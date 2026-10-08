use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A client registered through OAuth Dynamic Client Registration (RFC 7591).
/// All clients are public (PKCE, no secret).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "oauth_clients")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub client_id: String,
    pub client_name: String,
    /// JSON-serialized `Vec<String>` of the redirect URIs given at registration.
    pub redirect_uris_json: String,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
