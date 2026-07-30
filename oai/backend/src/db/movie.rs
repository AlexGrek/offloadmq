//! Movie Studio job persistence (multi-scene director → scene-director →
//! video state machine).

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::movie_jobs::{self, Entity as MovieJobEntity},
    error::AppError,
};

pub type MovieJob = movie_jobs::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub idea: &'a str,
    pub width: i32,
    pub height: i32,
    pub scene_count: i32,
    pub scene_length: i32,
    pub long_shot: bool,
    pub auto_approve: bool,
    pub expand_prompt: bool,
    pub director_model: &'a str,
    pub scene_model: &'a str,
    pub video_capability: &'a str,
    pub director_system: &'a str,
    pub scene_system: &'a str,
    pub initial_image_id: Option<i64>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<MovieJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = movie_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("running".to_string()),
        idea: ActiveValue::Set(input.idea.to_string()),
        width: ActiveValue::Set(input.width),
        height: ActiveValue::Set(input.height),
        scene_count: ActiveValue::Set(input.scene_count),
        scene_length: ActiveValue::Set(input.scene_length),
        long_shot: ActiveValue::Set(input.long_shot),
        auto_approve: ActiveValue::Set(input.auto_approve),
        expand_prompt: ActiveValue::Set(input.expand_prompt),
        director_model: ActiveValue::Set(input.director_model.to_string()),
        scene_model: ActiveValue::Set(input.scene_model.to_string()),
        video_capability: ActiveValue::Set(input.video_capability.to_string()),
        director_system: ActiveValue::Set(input.director_system.to_string()),
        scene_system: ActiveValue::Set(input.scene_system.to_string()),
        initial_image_id: ActiveValue::Set(input.initial_image_id),
        phase: ActiveValue::Set("director".to_string()),
        outline_json: ActiveValue::Set("[]".to_string()),
        scenes_json: ActiveValue::Set("[]".to_string()),
        current_scene: ActiveValue::Set(0),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        active_log: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
        movie_file_id: ActiveValue::Set(None),
        raw_outline: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<MovieJob>, AppError> {
    MovieJobEntity::find_by_id(job_id)
        .filter(movie_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<MovieJob>, AppError> {
    MovieJobEntity::find()
        .filter(movie_jobs::Column::UserId.eq(user_id))
        .order_by_desc(movie_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Only `running` jobs are eligible for background reconciliation —
/// `awaitingApproval` and `paused` jobs must be invisible to the worker so it
/// never advances a job the user is holding.
pub async fn list_inflight_jobs(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<MovieJob>, AppError> {
    MovieJobEntity::find()
        .filter(movie_jobs::Column::Status.eq("running"))
        .order_by_asc(movie_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn update_job_state(db: &DatabaseConnection, job: &MovieJob) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = movie_jobs::ActiveModel {
        id: ActiveValue::Set(job.id),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set(job.status.clone()),
        phase: ActiveValue::Set(job.phase.clone()),
        outline_json: ActiveValue::Set(job.outline_json.clone()),
        scenes_json: ActiveValue::Set(job.scenes_json.clone()),
        current_scene: ActiveValue::Set(job.current_scene),
        offload_cap: ActiveValue::Set(job.offload_cap.clone()),
        offload_task_id: ActiveValue::Set(job.offload_task_id.clone()),
        active_log: ActiveValue::Set(job.active_log.clone()),
        stage: ActiveValue::Set(job.stage.clone()),
        error: ActiveValue::Set(job.error.clone()),
        movie_file_id: ActiveValue::Set(job.movie_file_id),
        raw_outline: ActiveValue::Set(job.raw_outline.clone()),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn delete_job(db: &DatabaseConnection, job_id: i64, user_id: i64) -> Result<(), AppError> {
    let result = MovieJobEntity::delete_many()
        .filter(movie_jobs::Column::Id.eq(job_id))
        .filter(movie_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
