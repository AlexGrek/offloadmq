//! LLM compare job persistence (parallel multi-model runs).

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::llm_compare_jobs::{self, Entity as LlmCompareJobEntity},
    error::AppError,
};

pub type LlmCompareJob = llm_compare_jobs::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub system_prompt: &'a str,
    pub user_prompt: &'a str,
    pub slots_json: &'a str,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<LlmCompareJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = llm_compare_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("running".to_string()),
        system_prompt: ActiveValue::Set(input.system_prompt.to_string()),
        user_prompt: ActiveValue::Set(input.user_prompt.to_string()),
        slots_json: ActiveValue::Set(input.slots_json.to_string()),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<LlmCompareJob>, AppError> {
    LlmCompareJobEntity::find_by_id(job_id)
        .filter(llm_compare_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<LlmCompareJob>, AppError> {
    LlmCompareJobEntity::find()
        .filter(llm_compare_jobs::Column::UserId.eq(user_id))
        .order_by_desc(llm_compare_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_inflight_jobs(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<LlmCompareJob>, AppError> {
    LlmCompareJobEntity::find()
        .filter(
            llm_compare_jobs::Column::Status
                .is_in(["running", "submitted", "pending"].map(str::to_string)),
        )
        .order_by_asc(llm_compare_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn update_job(
    db: &DatabaseConnection,
    job_id: i64,
    status: &str,
    slots_json: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = llm_compare_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set(status.to_string()),
        slots_json: ActiveValue::Set(slots_json.to_string()),
        error: ActiveValue::Set(error.map(str::to_string)),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn delete_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let result = LlmCompareJobEntity::delete_many()
        .filter(llm_compare_jobs::Column::Id.eq(job_id))
        .filter(llm_compare_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
