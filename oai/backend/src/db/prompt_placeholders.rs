//! User-scoped custom prompt placeholders, e.g. `{.cinematic}` -> one of a few
//! variant phrases. Resolved (including recursively) client-side in the frontend's
//! `lib/promptPlaceholders.ts`; this module only handles validated CRUD storage.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder,
};

use crate::{
    db::entities::prompt_placeholders::{self, Entity as PlaceholderEntity},
    error::AppError,
};

pub type Placeholder = prompt_placeholders::Model;

const MAX_NAME_LEN: usize = 64;
const MAX_VARIANTS: usize = 30;
const MAX_VARIANT_LEN: usize = 2_000;

/// Names reserved for the 7 builtin categories in the frontend's
/// `lib/promptPlaceholders.ts::CATEGORY_DICTIONARIES`, plus the server-side `{?}`
/// placeholder (`services::image_job_names::expand_prompt_placeholders`). Custom
/// placeholder names may not collide with these (case-insensitive). Keep this list
/// in sync with `RESERVED_PLACEHOLDER_NAMES` in
/// `oai/frontend/src/lib/promptPlaceholders.ts` by hand — there is no shared schema
/// between the two languages here.
pub const RESERVED_PLACEHOLDER_NAMES: &[&str] =
    &["color", "animal", "adjective", "country", "language", "name", "starwars", "?"];

pub fn is_reserved_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    RESERVED_PLACEHOLDER_NAMES.contains(&lower.as_str())
}

/// Charset: letters, digits, `.`, `-`, `_`. Deliberately allows leading/trailing
/// `.` and `-` (`.cinematic`, `film.`, `common-ending`) — no positional meaning,
/// any charset-valid text is a legal name. Implemented as a char scan rather than a
/// `Regex` object, matching `db::prompts::normalize_bucket`'s style (this backend
/// has no `regex` crate dependency).
pub fn normalize_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("placeholder name cannot be empty".into()));
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(format!(
            "placeholder name exceeds {MAX_NAME_LEN} characters"
        )));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::BadRequest(
            "placeholder name may only contain letters, digits, '-', '_' or '.'".into(),
        ));
    }
    Ok(trimmed.to_string())
}

fn normalize_variants(variants: Vec<String>) -> Result<Vec<String>, AppError> {
    let cleaned: Vec<String> = variants
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Err(AppError::BadRequest("at least one variant is required".into()));
    }
    if cleaned.len() > MAX_VARIANTS {
        return Err(AppError::BadRequest(format!("too many variants (max {MAX_VARIANTS})")));
    }
    if cleaned.iter().any(|v| v.len() > MAX_VARIANT_LEN) {
        return Err(AppError::BadRequest(format!(
            "a variant exceeds {MAX_VARIANT_LEN} characters"
        )));
    }
    Ok(cleaned)
}

/// True if `user_id` already owns a placeholder named `normalized_name`
/// (case-insensitive), excluding `exclude_id` (used by `update` to allow saving a
/// row under its own unchanged name).
async fn has_name_conflict(
    db: &DatabaseConnection,
    user_id: i64,
    normalized_name: &str,
    exclude_id: Option<i64>,
) -> Result<bool, AppError> {
    let lower = normalized_name.to_lowercase();
    let existing = PlaceholderEntity::find()
        .filter(prompt_placeholders::Column::UserId.eq(user_id))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    Ok(existing
        .iter()
        .any(|row| Some(row.id) != exclude_id && row.name.to_lowercase() == lower))
}

pub async fn list_for_user(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<Placeholder>, AppError> {
    PlaceholderEntity::find()
        .filter(prompt_placeholders::Column::UserId.eq(user_id))
        .order_by_asc(prompt_placeholders::Column::Name)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn create(
    db: &DatabaseConnection,
    id_gen: impl FnOnce() -> i64,
    user_id: i64,
    name: &str,
    variants: Vec<String>,
) -> Result<Placeholder, AppError> {
    let name = normalize_name(name)?;
    if is_reserved_name(&name) {
        return Err(AppError::BadRequest(format!(
            "'{name}' is a reserved placeholder name"
        )));
    }
    if has_name_conflict(db, user_id, &name, None).await? {
        return Err(AppError::BadRequest(format!(
            "you already have a placeholder named '{name}'"
        )));
    }
    let variants = normalize_variants(variants)?;
    let variants_json =
        serde_json::to_string(&variants).map_err(|e| AppError::Internal(e.to_string()))?;
    let now = chrono::Utc::now().fixed_offset();

    let model = prompt_placeholders::ActiveModel {
        id: ActiveValue::Set(id_gen()),
        user_id: ActiveValue::Set(user_id),
        name: ActiveValue::Set(name),
        variants_json: ActiveValue::Set(variants_json),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn update(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
    name: &str,
    variants: Vec<String>,
) -> Result<Placeholder, AppError> {
    let name = normalize_name(name)?;
    if is_reserved_name(&name) {
        return Err(AppError::BadRequest(format!(
            "'{name}' is a reserved placeholder name"
        )));
    }
    if has_name_conflict(db, user_id, &name, Some(id)).await? {
        return Err(AppError::BadRequest(format!(
            "you already have a placeholder named '{name}'"
        )));
    }
    let variants = normalize_variants(variants)?;
    let variants_json =
        serde_json::to_string(&variants).map_err(|e| AppError::Internal(e.to_string()))?;

    let row = PlaceholderEntity::find_by_id(id)
        .filter(prompt_placeholders::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound)?;

    let mut am: prompt_placeholders::ActiveModel = row.into();
    am.name = ActiveValue::Set(name);
    am.variants_json = ActiveValue::Set(variants_json);
    am.updated_at = ActiveValue::Set(chrono::Utc::now().fixed_offset());
    am.update(db).await.map_err(AppError::Database)
}

pub async fn delete(db: &DatabaseConnection, user_id: i64, id: i64) -> Result<(), AppError> {
    let result = PlaceholderEntity::delete_many()
        .filter(prompt_placeholders::Column::Id.eq(id))
        .filter(prompt_placeholders::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub fn decode_variants(row: &Placeholder) -> Result<Vec<String>, AppError> {
    serde_json::from_str(&row.variants_json).map_err(|e| AppError::Internal(e.to_string()))
}
