use sea_orm::{
    sea_query::Expr, ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Condition,
};

use crate::{
    db::entities::{
        image_files::{self, Entity as ImageFileEntity},
        image_generation_jobs::{self, Entity as ImageGenerationJobEntity},
        image_offload_tasks::{self, Entity as ImageOffloadTaskEntity},
        image_pipeline_events::{self, Entity as ImagePipelineEventEntity},
    },
    error::AppError,
};

pub type ImageGenerationJob = image_generation_jobs::Model;
pub type ImageFile = image_files::Model;
pub type ImagePipelineEvent = image_pipeline_events::Model;
pub type ImageOffloadTask = image_offload_tasks::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub display_name: &'a str,
    pub user_id: i64,
    pub prompt: &'a str,
    pub negative_prompt: Option<&'a str>,
    pub capability: &'a str,
    pub workflow: &'a str,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub input_image_id: Option<i64>,
    pub pipeline_params_json: &'a str,
}

pub struct NewImageFileInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub job_id: Option<i64>,
    pub direction: &'a str,
    pub source: &'a str,
    pub storage_path: &'a str,
    pub thumbnail_storage_path: &'a str,
    pub thumbnail_stored_bytes: i64,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub original_bytes: Option<i64>,
    pub stored_bytes: i64,
    pub original_width: Option<i32>,
    pub original_height: Option<i32>,
    pub stored_width: i32,
    pub stored_height: i32,
    pub exif_orientation: Option<i32>,
    pub rescaled: bool,
    pub reencoded: bool,
    pub sha256: &'a str,
    pub offload_bucket_uid: Option<&'a str>,
    pub offload_file_uid: Option<&'a str>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<ImageGenerationJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_generation_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        display_name: ActiveValue::Set(input.display_name.to_string()),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        prompt: ActiveValue::Set(input.prompt.to_string()),
        negative_prompt: ActiveValue::Set(input.negative_prompt.map(str::to_string)),
        capability: ActiveValue::Set(input.capability.to_string()),
        workflow: ActiveValue::Set(input.workflow.to_string()),
        width: ActiveValue::Set(input.width),
        height: ActiveValue::Set(input.height),
        seed: ActiveValue::Set(input.seed),
        input_image_id: ActiveValue::Set(input.input_image_id),
        error: ActiveValue::Set(None),
        pipeline_params_json: ActiveValue::Set(input.pipeline_params_json.to_string()),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find_by_id(job_id)
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find()
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
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
    let result = ImageGenerationJobEntity::delete_many()
        .filter(image_generation_jobs::Column::Id.eq(job_id))
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn update_job_status(
    db: &DatabaseConnection,
    job_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_generation_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set(status.to_string()),
        updated_at: ActiveValue::Set(now),
        error: ActiveValue::Set(error.map(str::to_string)),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn create_pipeline_event(
    db: &DatabaseConnection,
    id: i64,
    job_id: i64,
    step: &str,
    state: &str,
    details: Option<&str>,
) -> Result<ImagePipelineEvent, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_pipeline_events::ActiveModel {
        id: ActiveValue::Set(id),
        job_id: ActiveValue::Set(job_id),
        step: ActiveValue::Set(step.to_string()),
        state: ActiveValue::Set(state.to_string()),
        details: ActiveValue::Set(details.map(str::to_string)),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn list_pipeline_events(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Vec<ImagePipelineEvent>, AppError> {
    ImagePipelineEventEntity::find()
        .filter(image_pipeline_events::Column::JobId.eq(job_id))
        .order_by_asc(image_pipeline_events::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn create_offload_task(
    db: &DatabaseConnection,
    id: i64,
    job_id: i64,
    offload_cap: &str,
    offload_task_id: &str,
    submit_payload: &str,
) -> Result<ImageOffloadTask, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_offload_tasks::ActiveModel {
        id: ActiveValue::Set(id),
        job_id: ActiveValue::Set(job_id),
        offload_cap: ActiveValue::Set(offload_cap.to_string()),
        offload_task_id: ActiveValue::Set(offload_task_id.to_string()),
        submit_payload: ActiveValue::Set(submit_payload.to_string()),
        last_poll_status: ActiveValue::Set(None),
        last_poll_stage: ActiveValue::Set(None),
        last_poll_log: ActiveValue::Set(None),
        last_poll_output: ActiveValue::Set(None),
        submitted_at: ActiveValue::Set(now),
        started_at: ActiveValue::Set(None),
        typical_runtime_seconds: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Active image jobs for a user plus their linked OffloadMQ task rows (debug panel).
pub async fn list_user_active_offload_tasks(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<(ImageGenerationJob, ImageOffloadTask)>, AppError> {
    let jobs = list_jobs(db, user_id, 64).await?;
    let mut out = Vec::new();
    for job in jobs {
        if matches!(job.status.as_str(), "completed" | "failed" | "canceled") {
            continue;
        }
        if let Some(task) = get_offload_task_by_job(db, job.id).await? {
            out.push((job, task));
        }
    }
    Ok(out)
}

pub async fn get_offload_task_by_job(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Option<ImageOffloadTask>, AppError> {
    ImageOffloadTaskEntity::find()
        .filter(image_offload_tasks::Column::JobId.eq(job_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn update_offload_task_poll(
    db: &DatabaseConnection,
    id: i64,
    status: Option<&str>,
    stage: Option<&str>,
    log: Option<&str>,
    output: Option<&str>,
    typical_runtime_seconds: Option<f64>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let mut model = image_offload_tasks::ActiveModel {
        id: ActiveValue::Set(id),
        last_poll_status: ActiveValue::Set(status.map(str::to_string)),
        last_poll_stage: ActiveValue::Set(stage.map(str::to_string)),
        last_poll_log: ActiveValue::Set(log.map(str::to_string)),
        last_poll_output: ActiveValue::Set(output.map(str::to_string)),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    if let Some(secs) = typical_runtime_seconds.filter(|s| *s > 0.0) {
        model.typical_runtime_seconds = ActiveValue::Set(Some(secs));
    }
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

/// Stamp `started_at = now` the first time a task is observed executing on an
/// agent. The `IS NULL` filter makes this set-once and idempotent across polls.
pub async fn mark_offload_task_started(
    db: &DatabaseConnection,
    id: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    ImageOffloadTaskEntity::update_many()
        .col_expr(image_offload_tasks::Column::StartedAt, Expr::value(now))
        .filter(image_offload_tasks::Column::Id.eq(id))
        .filter(image_offload_tasks::Column::StartedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

pub async fn create_image_file(
    db: &DatabaseConnection,
    input: NewImageFileInput<'_>,
) -> Result<ImageFile, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_files::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        job_id: ActiveValue::Set(input.job_id),
        direction: ActiveValue::Set(input.direction.to_string()),
        source: ActiveValue::Set(input.source.to_string()),
        storage_path: ActiveValue::Set(input.storage_path.to_string()),
        thumbnail_storage_path: ActiveValue::Set(Some(input.thumbnail_storage_path.to_string())),
        thumbnail_stored_bytes: ActiveValue::Set(input.thumbnail_stored_bytes),
        filename: ActiveValue::Set(input.filename.to_string()),
        content_type: ActiveValue::Set(input.content_type.to_string()),
        original_bytes: ActiveValue::Set(input.original_bytes),
        stored_bytes: ActiveValue::Set(input.stored_bytes),
        original_width: ActiveValue::Set(input.original_width),
        original_height: ActiveValue::Set(input.original_height),
        stored_width: ActiveValue::Set(input.stored_width),
        stored_height: ActiveValue::Set(input.stored_height),
        exif_orientation: ActiveValue::Set(input.exif_orientation),
        rescaled: ActiveValue::Set(input.rescaled),
        reencoded: ActiveValue::Set(input.reencoded),
        sha256: ActiveValue::Set(input.sha256.to_string()),
        offload_bucket_uid: ActiveValue::Set(input.offload_bucket_uid.map(str::to_string)),
        offload_file_uid: ActiveValue::Set(input.offload_file_uid.map(str::to_string)),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn list_job_files(db: &DatabaseConnection, job_id: i64) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .filter(image_files::Column::JobId.eq(job_id))
        .order_by_asc(image_files::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn get_image_file(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<Option<ImageFile>, AppError> {
    ImageFileEntity::find_by_id(id)
        .filter(image_files::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn set_image_thumbnail_meta(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    thumbnail_storage_path: &str,
    thumbnail_stored_bytes: i64,
) -> Result<(), AppError> {
    let file = get_image_file(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut active: image_files::ActiveModel = file.into();
    active.thumbnail_storage_path = ActiveValue::Set(Some(thumbnail_storage_path.to_string()));
    active.thumbnail_stored_bytes = ActiveValue::Set(thumbnail_stored_bytes);
    active.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn delete_image_file(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let result = ImageFileEntity::delete_many()
        .filter(image_files::Column::Id.eq(id))
        .filter(image_files::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_image_file_job(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    job_id: i64,
) -> Result<(), AppError> {
    let file = get_image_file(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut active: image_files::ActiveModel = file.into();
    active.job_id = ActiveValue::Set(Some(job_id));
    active.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn list_jobs_for_background_worker(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find()
        .filter(
            Condition::any()
                .add(image_generation_jobs::Column::Status.eq("created"))
                .add(image_generation_jobs::Column::Status.eq("submitted"))
                .add(image_generation_jobs::Column::Status.eq("pending"))
                .add(image_generation_jobs::Column::Status.eq("running"))
                .add(image_generation_jobs::Column::Status.eq("cancelRequested"))
                .add(image_generation_jobs::Column::Status.eq("completed")),
        )
        .order_by_asc(image_generation_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find()
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn get_job_global(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Option<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find_by_id(job_id)
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// All files owned by a user, newest first — backs the user file browser.
pub async fn list_user_image_files(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .filter(image_files::Column::UserId.eq(user_id))
        .order_by_desc(image_files::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Sum of `stored_bytes` across all of a user's files — the source of truth for
/// the cached `users.used_storage_bytes` value.
pub async fn sum_user_stored_bytes(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<i64, AppError> {
    let rows: Vec<(i64, i64)> = ImageFileEntity::find()
        .select_only()
        .column(image_files::Column::StoredBytes)
        .column(image_files::Column::ThumbnailStoredBytes)
        .filter(image_files::Column::UserId.eq(user_id))
        .into_tuple()
        .all(db)
        .await
        .map_err(AppError::Database)?;
    Ok(rows.iter().map(|(main, thumb)| main + thumb).sum())
}

pub async fn list_image_files_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .order_by_desc(image_files::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_pipeline_events_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImagePipelineEvent>, AppError> {
    ImagePipelineEventEntity::find()
        .order_by_desc(image_pipeline_events::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_offload_tasks_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageOffloadTask>, AppError> {
    ImageOffloadTaskEntity::find()
        .order_by_desc(image_offload_tasks::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
