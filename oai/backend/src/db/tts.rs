use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};

use crate::{
    db::entities::tts_jobs::{self, Entity as TtsJobEntity},
    error::AppError,
};

pub type TtsJob = tts_jobs::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub text: &'a str,
    pub capability: &'a str,
    pub voice: &'a str,
    pub model: &'a str,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<TtsJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        text: ActiveValue::Set(input.text.to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        voice: ActiveValue::Set(input.voice.to_string()),
        model: ActiveValue::Set(input.model.to_string()),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        audio_storage_path: ActiveValue::Set(None),
        audio_content_type: ActiveValue::Set(None),
        audio_size_bytes: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<TtsJob>, AppError> {
    TtsJobEntity::find_by_id(job_id)
        .filter(tts_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<TtsJob>, AppError> {
    TtsJobEntity::find()
        .filter(tts_jobs::Column::UserId.eq(user_id))
        .order_by_desc(tts_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn delete_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let result = TtsJobEntity::delete_many()
        .filter(tts_jobs::Column::Id.eq(job_id))
        .filter(tts_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_offload_task(
    db: &DatabaseConnection,
    job_id: i64,
    offload_cap: &str,
    offload_task_id: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("submitted".to_string()),
        offload_cap: ActiveValue::Set(Some(offload_cap.to_string())),
        offload_task_id: ActiveValue::Set(Some(offload_task_id.to_string())),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn update_status(
    db: &DatabaseConnection,
    job_id: i64,
    status: &str,
    stage: Option<&str>,
    error: Option<&str>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set(status.to_string()),
        stage: ActiveValue::Set(stage.map(str::to_string)),
        error: ActiveValue::Set(error.map(str::to_string)),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn set_audio(
    db: &DatabaseConnection,
    job_id: i64,
    storage_path: &str,
    content_type: &str,
    size_bytes: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        audio_storage_path: ActiveValue::Set(Some(storage_path.to_string())),
        audio_content_type: ActiveValue::Set(Some(content_type.to_string())),
        audio_size_bytes: ActiveValue::Set(Some(size_bytes)),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn list_jobs_for_background_worker(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<TtsJob>, AppError> {
    TtsJobEntity::find()
        .filter(
            Condition::any()
                .add(tts_jobs::Column::Status.eq("submitted"))
                .add(tts_jobs::Column::Status.eq("pending"))
                .add(tts_jobs::Column::Status.eq("running"))
                .add(tts_jobs::Column::Status.eq("cancelRequested")),
        )
        .order_by_asc(tts_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
