use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "prompt_placeholders")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    /// Custom placeholder name, e.g. `.cinematic` or `film.` — matched as `{name}`
    /// in prompts. No special meaning to a leading/trailing `.`; any charset-valid
    /// text is a legal name (see `db::prompt_placeholders::normalize_name`).
    pub name: String,
    /// JSON-serialized `Vec<String>` of variant phrases, one of which is picked at
    /// random on each expansion. May itself contain further `{...}` placeholders
    /// (builtin categories, `{?}`, or other custom names) — resolved recursively,
    /// client-side, in `lib/promptPlaceholders.ts`.
    pub variants_json: String,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
