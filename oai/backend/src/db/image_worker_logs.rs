use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{db::entities::image_worker_logs, error::AppError};

pub type ImageWorkerLog = image_worker_logs::Model;

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    run_id: &str,
    level: &str,
    message: &str,
    data_json: &str,
) -> Result<ImageWorkerLog, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_worker_logs::ActiveModel {
        id: ActiveValue::Set(id),
        run_id: ActiveValue::Set(run_id.to_string()),
        level: ActiveValue::Set(level.to_string()),
        message: ActiveValue::Set(message.to_string()),
        data_json: ActiveValue::Set(data_json.to_string()),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn list_latest(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageWorkerLog>, AppError> {
    image_worker_logs::Entity::find()
        .order_by_desc(image_worker_logs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Deletes worker-log rows older than `max_age_days`. The worker writes one row
/// per pass (every 20s by default) and nothing else ever removes them, so
/// without this the table grows without bound. Returns rows deleted.
pub async fn delete_older_than(
    db: &DatabaseConnection,
    max_age_days: u64,
) -> Result<u64, AppError> {
    let cutoff = chrono::Utc::now().fixed_offset() - chrono::Duration::days(max_age_days as i64);
    image_worker_logs::Entity::delete_many()
        .filter(image_worker_logs::Column::CreatedAt.lt(cutoff))
        .exec(db)
        .await
        .map(|r| r.rows_affected)
        .map_err(AppError::Database)
}
