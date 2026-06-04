//! Image-analysis (describe) job persistence. Lifecycle columns are handled
//! generically via [`crate::db::offload_jobs`]; only the analysis-specific writes
//! (`create_job`, `set_result`) and the framework trait impls live here.

use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::image_analysis_jobs::{self, Entity as ImageAnalysisJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type ImageAnalysisJob = image_analysis_jobs::Model;

impl OffloadJobModel for image_analysis_jobs::Model {
    fn id(&self) -> i64 {
        self.id
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn offload_cap(&self) -> Option<&str> {
        self.offload_cap.as_deref()
    }
    fn offload_task_id(&self) -> Option<&str> {
        self.offload_task_id.as_deref()
    }
}

impl OffloadJobEntity for ImageAnalysisJobEntity {
    fn col_id() -> Self::Column {
        image_analysis_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        image_analysis_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        image_analysis_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        image_analysis_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        image_analysis_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        image_analysis_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        image_analysis_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        image_analysis_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        image_analysis_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(image_analysis_jobs::Column::OffloadBucketUid)
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub prompt: &'a str,
    pub capability: &'a str,
    pub input_image_id: Option<i64>,
    /// JSON-serialized OffloadMQ `dataPreparation` map, or `None` for no preprocessing.
    pub data_preparation: Option<&'a str>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<ImageAnalysisJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_analysis_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        prompt: ActiveValue::Set(input.prompt.to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        input_image_id: ActiveValue::Set(input.input_image_id),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        offload_bucket_uid: ActiveValue::Set(None),
        result: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
        data_preparation: ActiveValue::Set(input.data_preparation.map(str::to_string)),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_result(
    db: &DatabaseConnection,
    job_id: i64,
    result: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_analysis_jobs::ActiveModel {
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
