//! Generic per-user prompt storage, organized into named buckets (e.g.
//! `llm-system`, `describe-image-user`). Each bucket holds two logical lists:
//! `recent` (auto-managed history, capped at the last 10 unique prompts) and
//! `starred` (user-curated favorites that are editable and deletable).

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::prompt_entries::{self, Entity as PromptEntryEntity},
    error::AppError,
};

pub type PromptEntry = prompt_entries::Model;

const MAX_CONTENT_LEN: usize = 32_000;
const MAX_BUCKET_LEN: usize = 64;
/// How many `recent` entries to keep per (user, bucket).
const RECENT_LIMIT: u64 = 10;

pub const KIND_RECENT: &str = "recent";
pub const KIND_STARRED: &str = "starred";

pub fn normalize_content(content: &str) -> Result<String, AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("prompt cannot be empty".into()));
    }
    if trimmed.len() > MAX_CONTENT_LEN {
        return Err(AppError::BadRequest(format!(
            "prompt exceeds {MAX_CONTENT_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

pub fn normalize_bucket(bucket: &str) -> Result<String, AppError> {
    let trimmed = bucket.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("bucket cannot be empty".into()));
    }
    if trimmed.len() > MAX_BUCKET_LEN {
        return Err(AppError::BadRequest(format!(
            "bucket exceeds {MAX_BUCKET_LEN} characters"
        )));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::BadRequest(
            "bucket may only contain letters, digits, '-', '_' or '.'".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Returns `(recent, starred)` for one bucket. `recent` is newest-first capped at
/// [`RECENT_LIMIT`]; `starred` is newest-edited-first with no cap.
pub async fn list_library(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
) -> Result<(Vec<PromptEntry>, Vec<PromptEntry>), AppError> {
    let bucket = normalize_bucket(bucket)?;

    let recent = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(&bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_RECENT))
        .order_by_desc(prompt_entries::Column::LastUsedAt)
        .limit(RECENT_LIMIT)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let starred = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(&bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_STARRED))
        .order_by_desc(prompt_entries::Column::UpdatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    Ok((recent, starred))
}

/// Record a prompt as recently used: dedupe by exact content within the bucket,
/// bump its timestamp, then trim the bucket back to [`RECENT_LIMIT`]. Best-effort
/// callers (chat/describe submit) should ignore the error.
pub async fn record_use(
    db: &DatabaseConnection,
    id_gen: impl FnOnce() -> i64,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<PromptEntry, AppError> {
    let bucket = normalize_bucket(bucket)?;
    let content = normalize_content(content)?;
    let now = chrono::Utc::now().fixed_offset();

    let entry = if let Some(existing) = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(&bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_RECENT))
        .filter(prompt_entries::Column::Content.eq(&content))
        .one(db)
        .await
        .map_err(AppError::Database)?
    {
        let mut am: prompt_entries::ActiveModel = existing.into();
        am.last_used_at = ActiveValue::Set(now);
        am.update(db).await.map_err(AppError::Database)?
    } else {
        let model = prompt_entries::ActiveModel {
            id: ActiveValue::Set(id_gen()),
            user_id: ActiveValue::Set(user_id),
            bucket: ActiveValue::Set(bucket.clone()),
            kind: ActiveValue::Set(KIND_RECENT.to_string()),
            content: ActiveValue::Set(content),
            last_used_at: ActiveValue::Set(now),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
        };
        model.insert(db).await.map_err(AppError::Database)?
    };

    trim_recent(db, user_id, &bucket).await?;
    Ok(entry)
}

/// Delete `recent` rows beyond the newest [`RECENT_LIMIT`] for one bucket.
async fn trim_recent(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
) -> Result<(), AppError> {
    let keep: Vec<i64> = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_RECENT))
        .order_by_desc(prompt_entries::Column::LastUsedAt)
        .limit(RECENT_LIMIT)
        .all(db)
        .await
        .map_err(AppError::Database)?
        .into_iter()
        .map(|m| m.id)
        .collect();

    if keep.is_empty() {
        return Ok(());
    }

    PromptEntryEntity::delete_many()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_RECENT))
        .filter(prompt_entries::Column::Id.is_not_in(keep))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Add the given content to a bucket's favorites. Dedupes by exact content: an
/// existing favorite is bumped (touch `updated_at`) rather than duplicated.
pub async fn add_starred(
    db: &DatabaseConnection,
    id_gen: impl FnOnce() -> i64,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<PromptEntry, AppError> {
    let bucket = normalize_bucket(bucket)?;
    let content = normalize_content(content)?;
    let now = chrono::Utc::now().fixed_offset();

    if let Some(existing) = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(&bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_STARRED))
        .filter(prompt_entries::Column::Content.eq(&content))
        .one(db)
        .await
        .map_err(AppError::Database)?
    {
        let mut am: prompt_entries::ActiveModel = existing.into();
        am.updated_at = ActiveValue::Set(now);
        return am.update(db).await.map_err(AppError::Database);
    }

    let model = prompt_entries::ActiveModel {
        id: ActiveValue::Set(id_gen()),
        user_id: ActiveValue::Set(user_id),
        bucket: ActiveValue::Set(bucket),
        kind: ActiveValue::Set(KIND_STARRED.to_string()),
        content: ActiveValue::Set(content),
        last_used_at: ActiveValue::Set(now),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Edit the content of an owned entry (used to edit favorites).
pub async fn update_content(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
    content: &str,
) -> Result<PromptEntry, AppError> {
    let content = normalize_content(content)?;
    let row = PromptEntryEntity::find_by_id(id)
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound)?;

    let mut am: prompt_entries::ActiveModel = row.into();
    am.content = ActiveValue::Set(content);
    am.updated_at = ActiveValue::Set(chrono::Utc::now().fixed_offset());
    am.update(db).await.map_err(AppError::Database)
}

pub async fn delete_entry(db: &DatabaseConnection, user_id: i64, id: i64) -> Result<(), AppError> {
    let result = PromptEntryEntity::delete_many()
        .filter(prompt_entries::Column::Id.eq(id))
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
