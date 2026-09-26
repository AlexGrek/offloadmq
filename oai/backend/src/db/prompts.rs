//! Generic per-user prompt storage, organized into named buckets (e.g.
//! `llm-system`, `describe-image-user`). Each bucket holds two logical lists:
//! `recent` (auto-managed history, capped at the last 10 unique prompts) and
//! `starred` (user-curated favorites that are editable and deletable).
//!
//! Entries may carry an image preview (`preview_updated_at`); the blob lives in
//! storage at a content-derived path and is owned by `services::prompt_previews`.
//! Functions here that remove or rewrite rows return the affected rows so that
//! service can garbage-collect blobs no remaining entry references.

use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr, LikeExpr},
    ActiveModelTrait, ActiveValue, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};

use crate::{
    db::entities::prompt_entries::{self, Entity as PromptEntryEntity},
    error::AppError,
};

pub type PromptEntry = prompt_entries::Model;
type Timestamp = chrono::DateTime<chrono::FixedOffset>;

const MAX_CONTENT_LEN: usize = 32_000;
const MAX_BUCKET_LEN: usize = 64;
const MAX_QUERY_LEN: usize = 500;
/// How many `recent` entries to keep per (user, bucket).
const RECENT_LIMIT: u64 = 10;
pub const DEFAULT_PAGE_SIZE: u64 = 40;
pub const MAX_PAGE_SIZE: u64 = 100;

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

pub fn normalize_kind(kind: &str) -> Result<&'static str, AppError> {
    match kind.trim() {
        KIND_RECENT => Ok(KIND_RECENT),
        KIND_STARRED => Ok(KIND_STARRED),
        other => Err(AppError::BadRequest(format!(
            "kind must be '{KIND_RECENT}' or '{KIND_STARRED}', got '{other}'"
        ))),
    }
}

/// Keyset position in a paged listing: the sort timestamp and id of the last row
/// already returned. Serialized as an opaque `"{micros}_{id}"` token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCursor {
    pub ts_micros: i64,
    pub id: i64,
}

impl PageCursor {
    pub fn encode(&self) -> String {
        format!("{}_{}", self.ts_micros, self.id)
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let bad = || AppError::BadRequest("invalid cursor".into());
        let (ts, id) = raw.split_once('_').ok_or_else(bad)?;
        Ok(Self {
            ts_micros: ts.parse().map_err(|_| bad())?,
            id: id.parse().map_err(|_| bad())?,
        })
    }

    fn timestamp(&self) -> Result<Timestamp, AppError> {
        chrono::DateTime::from_timestamp_micros(self.ts_micros)
            .map(|t| t.fixed_offset())
            .ok_or_else(|| AppError::BadRequest("invalid cursor".into()))
    }
}

pub struct PromptPage {
    pub items: Vec<PromptEntry>,
    pub next_cursor: Option<PageCursor>,
}

/// The column a kind is ordered by: recents by last use, favorites by last edit.
fn sort_column(kind: &str) -> prompt_entries::Column {
    if kind == KIND_RECENT {
        prompt_entries::Column::LastUsedAt
    } else {
        prompt_entries::Column::UpdatedAt
    }
}

fn sort_value(kind: &str, m: &PromptEntry) -> Timestamp {
    if kind == KIND_RECENT {
        m.last_used_at
    } else {
        m.updated_at
    }
}

/// `%`, `_` and the escape char (`\`) itself are literal in a user's search text.
fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// One page of a bucket's `kind` list, newest first, optionally filtered by a
/// case-insensitive substring `query`. Keyset-paged on `(sort ts, id)` so rows
/// inserted while the user scrolls never shift or duplicate later pages.
pub async fn list_page(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
    kind: &str,
    query: Option<&str>,
    cursor: Option<PageCursor>,
    limit: u64,
) -> Result<PromptPage, AppError> {
    let bucket = normalize_bucket(bucket)?;
    let kind = normalize_kind(kind)?;
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let sort_col = sort_column(kind);

    let mut select = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(&bucket))
        .filter(prompt_entries::Column::Kind.eq(kind));

    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        if q.len() > MAX_QUERY_LEN {
            return Err(AppError::BadRequest(format!(
                "search exceeds {MAX_QUERY_LEN} characters"
            )));
        }
        // Backslash is Postgres' default LIKE escape, matching `like_pattern`. (An
        // explicit `.escape()` renders as invalid `ILIKE ($n ESCAPE ..)` here.)
        select = select.filter(
            Expr::col((PromptEntryEntity, prompt_entries::Column::Content))
                .ilike(LikeExpr::new(like_pattern(q))),
        );
    }

    if let Some(cursor) = cursor {
        let ts = cursor.timestamp()?;
        select = select.filter(
            Condition::any().add(sort_col.lt(ts)).add(
                Condition::all()
                    .add(sort_col.eq(ts))
                    .add(prompt_entries::Column::Id.lt(cursor.id)),
            ),
        );
    }

    let mut items = select
        .order_by_desc(sort_col)
        .order_by_desc(prompt_entries::Column::Id)
        .limit(limit + 1)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let next_cursor = if items.len() as u64 > limit {
        items.truncate(limit as usize);
        items.last().map(|m| PageCursor {
            ts_micros: sort_value(kind, m).timestamp_micros(),
            id: m.id,
        })
    } else {
        None
    };

    Ok(PromptPage { items, next_cursor })
}

/// Returns `(recent, starred)` for one bucket. `recent` is newest-first capped at
/// [`RECENT_LIMIT`]; `starred` is newest-edited-first with no cap. Legacy
/// all-at-once listing — the SPA pages through [`list_page`] instead.
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

pub async fn find_owned(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
) -> Result<PromptEntry, AppError> {
    PromptEntryEntity::find_by_id(id)
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound)
}

/// Latest `preview_updated_at` among the bucket's entries with exactly this
/// content — lets a newly created row inherit a preview that already exists.
async fn sibling_preview(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<Option<Timestamp>, AppError> {
    Ok(PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Content.eq(content))
        .filter(prompt_entries::Column::PreviewUpdatedAt.is_not_null())
        .order_by_desc(prompt_entries::Column::PreviewUpdatedAt)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .and_then(|m| m.preview_updated_at))
}

/// Whether any entry in the bucket still has exactly this content — i.e. whether
/// its content-keyed preview blob is still referenced.
pub async fn content_referenced(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<bool, AppError> {
    Ok(PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Content.eq(content))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .is_some())
}

/// Flag every entry in the bucket with exactly this content as having a preview
/// as of `at`. Returns how many rows were touched.
pub async fn mark_preview(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
    content: &str,
    at: Timestamp,
) -> Result<u64, AppError> {
    let result = PromptEntryEntity::update_many()
        .col_expr(prompt_entries::Column::PreviewUpdatedAt, Expr::value(at))
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Content.eq(content))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected)
}

/// Clear the preview flag of one entry (its blob could not be carried over).
pub async fn clear_preview(db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
    PromptEntryEntity::update_many()
        .col_expr(
            prompt_entries::Column::PreviewUpdatedAt,
            Expr::value(Option::<Timestamp>::None),
        )
        .filter(prompt_entries::Column::Id.eq(id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Record a prompt as recently used: dedupe by exact content within the bucket,
/// bump its timestamp, then trim the bucket back to [`RECENT_LIMIT`]. Best-effort
/// callers (chat/describe submit) should ignore the error.
///
/// Also returns the rows the trim removed that carried a preview, so a caller
/// that owns storage can drop now-unreferenced blobs. Callers on buckets that
/// never get previews can ignore them.
pub async fn record_use(
    db: &DatabaseConnection,
    id_gen: impl FnOnce() -> i64,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<(PromptEntry, Vec<PromptEntry>), AppError> {
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
        let preview = sibling_preview(db, user_id, &bucket, &content).await?;
        let model = prompt_entries::ActiveModel {
            id: ActiveValue::Set(id_gen()),
            user_id: ActiveValue::Set(user_id),
            bucket: ActiveValue::Set(bucket.clone()),
            kind: ActiveValue::Set(KIND_RECENT.to_string()),
            content: ActiveValue::Set(content),
            last_used_at: ActiveValue::Set(now),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
            preview_updated_at: ActiveValue::Set(preview),
        };
        model.insert(db).await.map_err(AppError::Database)?
    };

    let trimmed = trim_recent(db, user_id, &bucket).await?;
    Ok((entry, trimmed))
}

/// Delete `recent` rows beyond the newest [`RECENT_LIMIT`] for one bucket,
/// returning the removed rows that had a preview.
async fn trim_recent(
    db: &DatabaseConnection,
    user_id: i64,
    bucket: &str,
) -> Result<Vec<PromptEntry>, AppError> {
    let overflow: Vec<PromptEntry> = PromptEntryEntity::find()
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .filter(prompt_entries::Column::Bucket.eq(bucket))
        .filter(prompt_entries::Column::Kind.eq(KIND_RECENT))
        .order_by_desc(prompt_entries::Column::LastUsedAt)
        .order_by_desc(prompt_entries::Column::Id)
        .offset(RECENT_LIMIT)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    if overflow.is_empty() {
        return Ok(Vec::new());
    }

    PromptEntryEntity::delete_many()
        .filter(prompt_entries::Column::Id.is_in(overflow.iter().map(|m| m.id)))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(overflow
        .into_iter()
        .filter(|m| m.preview_updated_at.is_some())
        .collect())
}

/// Add the given content to a bucket's favorites. Dedupes by exact content: an
/// existing favorite is bumped (touch `updated_at`) rather than duplicated. A new
/// favorite inherits the preview of a same-content recent.
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

    let preview = sibling_preview(db, user_id, &bucket, &content).await?;
    let model = prompt_entries::ActiveModel {
        id: ActiveValue::Set(id_gen()),
        user_id: ActiveValue::Set(user_id),
        bucket: ActiveValue::Set(bucket),
        kind: ActiveValue::Set(KIND_STARRED.to_string()),
        content: ActiveValue::Set(content),
        last_used_at: ActiveValue::Set(now),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        preview_updated_at: ActiveValue::Set(preview),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Edit the content of an owned entry (used to edit favorites). Returns
/// `(before, after)` so the caller can carry the preview blob over to the new
/// content's path. If the entry had no preview of its own, it inherits one from
/// an entry that already has the new content.
pub async fn update_content(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
    content: &str,
) -> Result<(PromptEntry, PromptEntry), AppError> {
    let content = normalize_content(content)?;
    let before = find_owned(db, user_id, id).await?;

    let preview = match before.preview_updated_at {
        Some(t) => Some(t),
        None => sibling_preview(db, user_id, &before.bucket, &content).await?,
    };

    let mut am: prompt_entries::ActiveModel = before.clone().into();
    am.content = ActiveValue::Set(content);
    am.updated_at = ActiveValue::Set(chrono::Utc::now().fixed_offset());
    am.preview_updated_at = ActiveValue::Set(preview);
    let after = am.update(db).await.map_err(AppError::Database)?;
    Ok((before, after))
}

/// Remove an owned entry, returning the deleted row.
pub async fn delete_entry(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
) -> Result<PromptEntry, AppError> {
    let row = find_owned(db, user_id, id).await?;
    PromptEntryEntity::delete_many()
        .filter(prompt_entries::Column::Id.eq(id))
        .filter(prompt_entries::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips() {
        let c = PageCursor { ts_micros: 1_790_000_000_123_456, id: 42 };
        assert_eq!(PageCursor::parse(&c.encode()).unwrap(), c);
    }

    #[test]
    fn cursor_rejects_garbage() {
        assert!(PageCursor::parse("").is_err());
        assert!(PageCursor::parse("abc_1").is_err());
        assert!(PageCursor::parse("123").is_err());
        assert!(PageCursor::parse("1_x").is_err());
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("cat"), "%cat%");
        assert_eq!(like_pattern("100%_a\\b"), "%100\\%\\_a\\\\b%");
    }

    #[test]
    fn kind_is_validated() {
        assert_eq!(normalize_kind("recent").unwrap(), KIND_RECENT);
        assert_eq!(normalize_kind(" starred ").unwrap(), KIND_STARRED);
        assert!(normalize_kind("all").is_err());
    }
}
