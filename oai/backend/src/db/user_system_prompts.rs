use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::user_system_prompts::{self, Entity as UserSystemPromptEntity},
    error::AppError,
};

pub type UserSystemPrompt = user_system_prompts::Model;

const MAX_CONTENT_LEN: usize = 32_000;

pub fn normalize_content(content: &str) -> Result<String, AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("system prompt cannot be empty".into()));
    }
    if trimmed.len() > MAX_CONTENT_LEN {
        return Err(AppError::BadRequest(format!(
            "system prompt exceeds {MAX_CONTENT_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

pub async fn list_library(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<(Vec<UserSystemPrompt>, Vec<UserSystemPrompt>), AppError> {
    let recent = UserSystemPromptEntity::find()
        .filter(user_system_prompts::Column::UserId.eq(user_id))
        .order_by_desc(user_system_prompts::Column::LastUsedAt)
        .limit(3)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let starred = UserSystemPromptEntity::find()
        .filter(user_system_prompts::Column::UserId.eq(user_id))
        .filter(user_system_prompts::Column::Starred.eq(true))
        .order_by_desc(user_system_prompts::Column::LastUsedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    Ok((recent, starred))
}

/// Upsert by exact content match and bump `last_used_at` (drives "recent 3").
pub async fn record_use(
    db: &DatabaseConnection,
    id_gen: impl FnOnce() -> i64,
    user_id: i64,
    content: &str,
) -> Result<UserSystemPrompt, AppError> {
    let content = normalize_content(content)?;
    let now = chrono::Utc::now().fixed_offset();

    if let Some(existing) = UserSystemPromptEntity::find()
        .filter(user_system_prompts::Column::UserId.eq(user_id))
        .filter(user_system_prompts::Column::Content.eq(&content))
        .one(db)
        .await
        .map_err(AppError::Database)?
    {
        let mut am: user_system_prompts::ActiveModel = existing.into();
        am.last_used_at = ActiveValue::Set(now);
        return am.update(db).await.map_err(AppError::Database);
    }

    let model = user_system_prompts::ActiveModel {
        id: ActiveValue::Set(id_gen()),
        user_id: ActiveValue::Set(user_id),
        content: ActiveValue::Set(content),
        starred: ActiveValue::Set(false),
        last_used_at: ActiveValue::Set(now),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_starred(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
    starred: bool,
) -> Result<UserSystemPrompt, AppError> {
    let row = UserSystemPromptEntity::find_by_id(id)
        .filter(user_system_prompts::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound)?;

    let mut am: user_system_prompts::ActiveModel = row.into();
    am.starred = ActiveValue::Set(starred);
    am.update(db).await.map_err(AppError::Database)
}

pub async fn delete_prompt(
    db: &DatabaseConnection,
    user_id: i64,
    id: i64,
) -> Result<(), AppError> {
    let result = UserSystemPromptEntity::delete_many()
        .filter(user_system_prompts::Column::Id.eq(id))
        .filter(user_system_prompts::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
