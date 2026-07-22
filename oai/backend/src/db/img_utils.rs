//! `img-utils` job persistence. Lifecycle columns are handled generically via
//! [`crate::db::offload_jobs`]; only the feature-specific writes (`create_job`,
//! `set_output_image`) and the framework trait impls live here.

use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::img_utils_jobs::{self, Entity as ImgUtilsJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type ImgUtilsJob = img_utils_jobs::Model;

impl OffloadJobModel for img_utils_jobs::Model {
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

impl OffloadJobEntity for ImgUtilsJobEntity {
    fn col_id() -> Self::Column {
        img_utils_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        img_utils_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        img_utils_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        img_utils_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        img_utils_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        img_utils_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        img_utils_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        img_utils_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        img_utils_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(img_utils_jobs::Column::OutputBucketUid)
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub capability: &'a str,
    pub utility: &'a str,
    pub workflow: &'a str,
    pub input_image_id: Option<i64>,
    pub source_image_id: Option<i64>,
    pub options_json: Option<&'a str>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<ImgUtilsJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = img_utils_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        utility: ActiveValue::Set(input.utility.to_string()),
        workflow: ActiveValue::Set(input.workflow.to_string()),
        input_image_id: ActiveValue::Set(input.input_image_id),
        source_image_id: ActiveValue::Set(input.source_image_id),
        options_json: ActiveValue::Set(input.options_json.map(str::to_string)),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        output_bucket_uid: ActiveValue::Set(None),
        output_image_id: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Attach the produced image and flip the job to `completed`.
pub async fn set_output_image(
    db: &DatabaseConnection,
    job_id: i64,
    output_image_id: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = img_utils_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        output_image_id: ActiveValue::Set(Some(output_image_id)),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}
