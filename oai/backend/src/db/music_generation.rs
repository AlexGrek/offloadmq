//! Music-generation job persistence. Lifecycle columns are handled generically
//! via [`crate::db::offload_jobs`]; only the music-specific writes (`create_job`,
//! `set_audio_files`) and the framework trait impls live here.

use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::music_generation_jobs::{self, Entity as MusicJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type MusicJob = music_generation_jobs::Model;

impl OffloadJobModel for music_generation_jobs::Model {
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

impl OffloadJobEntity for MusicJobEntity {
    fn col_id() -> Self::Column {
        music_generation_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        music_generation_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        music_generation_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        music_generation_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        music_generation_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        music_generation_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        music_generation_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        music_generation_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        music_generation_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(music_generation_jobs::Column::OutputBucketUid)
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub capability: &'a str,
    pub tags: &'a str,
    pub lyrics: Option<&'a str>,
    pub bpm: Option<i32>,
    pub duration: i32,
    pub seed: Option<i32>,
    pub language: Option<&'a str>,
    pub keyscale: Option<&'a str>,
    pub cfg_scale: Option<f64>,
    pub temperature: Option<f64>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<MusicJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = music_generation_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        output_bucket_uid: ActiveValue::Set(None),
        tags: ActiveValue::Set(input.tags.to_string()),
        lyrics: ActiveValue::Set(input.lyrics.map(str::to_string)),
        bpm: ActiveValue::Set(input.bpm),
        duration: ActiveValue::Set(input.duration),
        seed: ActiveValue::Set(input.seed),
        language: ActiveValue::Set(input.language.map(str::to_string)),
        keyscale: ActiveValue::Set(input.keyscale.map(str::to_string)),
        cfg_scale: ActiveValue::Set(input.cfg_scale),
        temperature: ActiveValue::Set(input.temperature),
        result_seed: ActiveValue::Set(None),
        audio_files_json: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_audio_files(
    db: &DatabaseConnection,
    job_id: i64,
    audio_files_json: &str,
    result_seed: Option<i32>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = music_generation_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        audio_files_json: ActiveValue::Set(Some(audio_files_json.to_string())),
        result_seed: ActiveValue::Set(result_seed),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}
