use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};

use crate::{
    db::entities::nude_detect_jobs::{self, Entity as NudeDetectJobEntity},
    error::AppError,
};

pub type NudeDetectJob = nude_detect_jobs::Model;

pub struct NewJobInput {
    pub id: i64,
    pub user_id: i64,
    pub threshold: f64,
    pub input_image_id: Option<i64>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput,
) -> Result<NudeDetectJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = nude_detect_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        threshold: ActiveValue::Set(input.threshold),
        input_image_id: ActiveValue::Set(input.input_image_id),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        offload_bucket_uid: ActiveValue::Set(None),
        result: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<NudeDetectJob>, AppError> {
    NudeDetectJobEntity::find_by_id(job_id)
        .filter(nude_detect_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<NudeDetectJob>, AppError> {
    NudeDetectJobEntity::find()
        .filter(nude_detect_jobs::Column::UserId.eq(user_id))
        .order_by_desc(nude_detect_jobs::Column::CreatedAt)
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
    let result = NudeDetectJobEntity::delete_many()
        .filter(nude_detect_jobs::Column::Id.eq(job_id))
        .filter(nude_detect_jobs::Column::UserId.eq(user_id))
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
    offload_bucket_uid: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = nude_detect_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("submitted".to_string()),
        offload_cap: ActiveValue::Set(Some(offload_cap.to_string())),
        offload_task_id: ActiveValue::Set(Some(offload_task_id.to_string())),
        offload_bucket_uid: ActiveValue::Set(Some(offload_bucket_uid.to_string())),
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
    let model = nude_detect_jobs::ActiveModel {
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

pub async fn set_result(
    db: &DatabaseConnection,
    job_id: i64,
    result: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = nude_detect_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        result: ActiveValue::Set(Some(result.to_string())),
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
) -> Result<Vec<NudeDetectJob>, AppError> {
    NudeDetectJobEntity::find()
        .filter(
            Condition::any()
                .add(nude_detect_jobs::Column::Status.eq("submitted"))
                .add(nude_detect_jobs::Column::Status.eq("pending"))
                .add(nude_detect_jobs::Column::Status.eq("running"))
                .add(nude_detect_jobs::Column::Status.eq("cancelRequested")),
        )
        .order_by_asc(nude_detect_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
