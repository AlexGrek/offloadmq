//! LLM debate job persistence (sequential multi-model dialog).

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::llm_debate_jobs::{self, Entity as LlmDebateJobEntity},
    error::AppError,
};

pub type LlmDebateJob = llm_debate_jobs::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub model_a: &'a str,
    pub model_b: &'a str,
    pub system_a: &'a str,
    pub system_b: &'a str,
    pub initial_prompt: &'a str,
    pub referee_enabled: bool,
    pub model_ref: Option<&'a str>,
    pub system_ref: Option<&'a str>,
    pub command_ref: Option<&'a str>,
    pub referee_turns: i32,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<LlmDebateJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = llm_debate_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("running".to_string()),
        model_a: ActiveValue::Set(input.model_a.to_string()),
        model_b: ActiveValue::Set(input.model_b.to_string()),
        system_a: ActiveValue::Set(input.system_a.to_string()),
        system_b: ActiveValue::Set(input.system_b.to_string()),
        initial_prompt: ActiveValue::Set(input.initial_prompt.to_string()),
        referee_enabled: ActiveValue::Set(input.referee_enabled),
        model_ref: ActiveValue::Set(input.model_ref.map(str::to_string)),
        system_ref: ActiveValue::Set(input.system_ref.map(str::to_string)),
        command_ref: ActiveValue::Set(input.command_ref.map(str::to_string)),
        referee_turns: ActiveValue::Set(input.referee_turns),
        messages_json: ActiveValue::Set("[]".to_string()),
        phase: ActiveValue::Set("debate".to_string()),
        current_turn: ActiveValue::Set(Some("A".to_string())),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        active_log: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<LlmDebateJob>, AppError> {
    LlmDebateJobEntity::find_by_id(job_id)
        .filter(llm_debate_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<LlmDebateJob>, AppError> {
    LlmDebateJobEntity::find()
        .filter(llm_debate_jobs::Column::UserId.eq(user_id))
        .order_by_desc(llm_debate_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_inflight_jobs(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<LlmDebateJob>, AppError> {
    LlmDebateJobEntity::find()
        .filter(
            llm_debate_jobs::Column::Status
                .is_in(["running", "submitted", "pending"].map(str::to_string)),
        )
        .order_by_asc(llm_debate_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn update_job_state(
    db: &DatabaseConnection,
    job: &LlmDebateJob,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = llm_debate_jobs::ActiveModel {
        id: ActiveValue::Set(job.id),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set(job.status.clone()),
        messages_json: ActiveValue::Set(job.messages_json.clone()),
        phase: ActiveValue::Set(job.phase.clone()),
        current_turn: ActiveValue::Set(job.current_turn.clone()),
        offload_cap: ActiveValue::Set(job.offload_cap.clone()),
        offload_task_id: ActiveValue::Set(job.offload_task_id.clone()),
        active_log: ActiveValue::Set(job.active_log.clone()),
        stage: ActiveValue::Set(job.stage.clone()),
        error: ActiveValue::Set(job.error.clone()),
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
    let result = LlmDebateJobEntity::delete_many()
        .filter(llm_debate_jobs::Column::Id.eq(job_id))
        .filter(llm_debate_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
