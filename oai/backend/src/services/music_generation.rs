//! Music generation job orchestration: persist txt2music jobs, submit to
//! OffloadMQ with an output bucket, and download the produced audio files on
//! completion. The poll/cancel/reconcile state machine is the shared
//! [`offload_job`] driver; this module supplies the music-specific pieces.
//!
//! Unlike the LLM/vision features, music gen polls and cancels via the image
//! client (its output arrives as bucket files, not inline data).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    db::{entities::music_generation_jobs::Entity as MusicJobEntity, music_generation, offload_jobs},
    error::AppError,
    offload::task_status::{NormalizedPoll, OffloadPoller},
    services::{
        offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
    state::AppState,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioFileRecord {
    pub storage_path: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct MusicCapability {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
    pub online: bool,
    pub last_available_at: String,
}

pub struct StartJobParams {
    pub capability: String,
    pub tags: String,
    pub lyrics: Option<String>,
    pub bpm: Option<i32>,
    pub duration: i32,
    pub seed: Option<i32>,
    pub language: Option<String>,
    pub keyscale: Option<String>,
    pub cfg_scale: Option<f64>,
    pub temperature: Option<f64>,
}

/// Drives the generic poll/cancel/reconcile lifecycle for music-gen jobs.
struct MusicGenReconciler;

#[async_trait]
impl JobReconciler for MusicGenReconciler {
    type Entity = MusicJobEntity;

    fn label(&self) -> &'static str {
        "music_gen"
    }

    fn failure_fallback(&self) -> &'static str {
        "music generation task failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::image_client(state).await?))
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &music_generation::MusicJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        let Some(output) = poll.output.as_ref() else {
            return offload_jobs::update_status::<MusicJobEntity>(
                &state.db,
                job.id,
                "failed",
                None,
                Some("music task returned no output"),
            )
            .await;
        };
        let audio_list = output
            .get("audio")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let result_seed = output.get("seed").and_then(|v| v.as_i64()).map(|s| s as i32);

        let image_client = offload_factory::image_client(state).await?;
        let op = storage::operator(state)?;
        let mut records: Vec<AudioFileRecord> = Vec::new();
        for (i, item) in audio_list.iter().enumerate() {
            let bucket_uid = item.get("bucket_uid").and_then(|v| v.as_str());
            let file_uid = item.get("file_uid").and_then(|v| v.as_str());
            let filename = item
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("audio.mp3")
                .to_string();
            let (Some(buid), Some(fuid)) = (bucket_uid, file_uid) else {
                continue;
            };
            match image_client.download_bucket_file(buid, fuid).await {
                Ok((bytes, content_type)) => {
                    let ext = audio_ext_from_content_type(&content_type);
                    let storage_path =
                        format!("users/{}/music/{}/track_{}.{}", job.user_id, job.id, i, ext);
                    match storage::write(op, &storage_path, bytes.clone()).await {
                        Ok(()) => {
                            records.push(AudioFileRecord {
                                storage_path,
                                filename,
                                content_type,
                                size_bytes: bytes.len() as i64,
                            });
                        }
                        Err(e) => {
                            tracing::warn!(
                                "music_gen: failed to write track {i} for job {}: {e}",
                                job.id
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "music_gen: failed to download track {i} for job {}: {e}",
                        job.id
                    );
                }
            }
        }

        let json = serde_json::to_string(&records).unwrap_or_else(|_| "[]".to_string());
        music_generation::set_audio_files(&state.db, job.id, &json, result_seed).await
    }
}

pub async fn list_capabilities(state: &AppState) -> Result<Vec<MusicCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let caps = client.list_capabilities_with_prefix("txt2music.").await?;
    Ok(caps
        .into_iter()
        .map(|c| MusicCapability {
            base: c.base,
            tags: c.tags,
            raw: c.raw,
            online: true,
            last_available_at: now.clone(),
        })
        .collect())
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    params: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let tags = params.tags.trim();
    if tags.is_empty() {
        return Err(AppError::BadRequest("tags is required".into()));
    }
    if params.capability.is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }
    if !params.capability.starts_with("txt2music.") {
        return Err(AppError::BadRequest(
            "capability must start with `txt2music.`".into(),
        ));
    }
    if params.duration < 1 || params.duration > 600 {
        return Err(AppError::BadRequest(
            "duration must be between 1 and 600 seconds".into(),
        ));
    }

    let job_id = state.next_id();
    let lyrics = params.lyrics.as_deref().filter(|s| !s.trim().is_empty());
    music_generation::create_job(
        &state.db,
        music_generation::NewJobInput {
            id: job_id,
            user_id,
            capability: &params.capability,
            tags,
            lyrics,
            bpm: params.bpm,
            duration: params.duration,
            seed: params.seed,
            language: params.language.as_deref().filter(|s| !s.trim().is_empty()),
            keyscale: params.keyscale.as_deref().filter(|s| !s.trim().is_empty()),
            cfg_scale: params.cfg_scale,
            temperature: params.temperature,
        },
    )
    .await?;

    let image_client = offload_factory::image_client(state).await?;
    let bucket = image_client.create_bucket(false).await?;

    let payload = build_task_payload(&params);
    let (task_id, _) = image_client
        .submit_img_task(&params.capability, payload, None, &bucket.bucket_uid, None)
        .await?;

    offload_jobs::set_offload_task::<MusicJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        Some(&bucket.bucket_uid),
    )
    .await?;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = offload_jobs::get_job::<MusicJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    start_job(
        state,
        user_id,
        StartJobParams {
            capability: job.capability.clone(),
            tags: job.tags.clone(),
            lyrics: job.lyrics.clone(),
            bpm: job.bpm,
            duration: job.duration,
            seed: job.seed,
            language: job.language.clone(),
            keyscale: job.keyscale.clone(),
            cfg_scale: job.cfg_scale,
            temperature: job.temperature,
        },
    )
    .await
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&MusicGenReconciler, state, user_id, job_id).await
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = offload_jobs::get_job::<MusicJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(json) = job.audio_files_json.as_deref() {
        if let Ok(tracks) = serde_json::from_str::<Vec<AudioFileRecord>>(json) {
            if let Ok(op) = storage::operator(state) {
                for track in &tracks {
                    let _ = storage::delete(op, &track.storage_path).await;
                }
            }
        }
    }
    offload_jobs::delete_job::<MusicJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<music_generation::MusicJob, AppError> {
    offload_job::poll_job(&MusicGenReconciler, state, user_id, job_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<music_generation::MusicJob>, AppError> {
    offload_jobs::list_jobs::<MusicJobEntity>(&state.db, user_id, limit).await
}

pub async fn audio_bytes(
    state: &AppState,
    user_id: i64,
    job_id: i64,
    track: usize,
) -> Result<(Vec<u8>, String, String), AppError> {
    let job = offload_jobs::get_job::<MusicJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let json = job.audio_files_json.as_deref().ok_or(AppError::NotFound)?;
    let tracks: Vec<AudioFileRecord> =
        serde_json::from_str(json).map_err(|_| AppError::NotFound)?;
    let record = tracks.into_iter().nth(track).ok_or(AppError::NotFound)?;
    let op = storage::operator(state)?;
    let bytes = storage::read(op, &record.storage_path).await?;
    Ok((bytes, record.content_type, record.filename))
}

/// Background worker pass: advances in-flight music generation jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&MusicGenReconciler, state, batch_size).await
}

fn build_task_payload(params: &StartJobParams) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "workflow": "txt2music",
        "tags": params.tags,
        "duration": params.duration,
    });
    if let Some(lyrics) = params.lyrics.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["lyrics"] = serde_json::Value::String(lyrics.to_string());
    }
    if let Some(bpm) = params.bpm {
        payload["bpm"] = serde_json::Value::Number(bpm.into());
    }
    if let Some(seed) = params.seed {
        payload["seed"] = serde_json::Value::Number(seed.into());
    }
    if let Some(lang) = params.language.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["language"] = serde_json::Value::String(lang.to_string());
    }
    if let Some(ks) = params.keyscale.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["keyscale"] = serde_json::Value::String(ks.to_string());
    }
    if let Some(cfg) = params.cfg_scale {
        if let Some(n) = serde_json::Number::from_f64(cfg) {
            payload["cfg_scale"] = serde_json::Value::Number(n);
        }
    }
    if let Some(temp) = params.temperature {
        if let Some(n) = serde_json::Number::from_f64(temp) {
            payload["temperature"] = serde_json::Value::Number(n);
        }
    }
    payload
}

fn audio_ext_from_content_type(ct: &str) -> &'static str {
    if ct.contains("mpeg") {
        "mp3"
    } else if ct.contains("ogg") {
        "ogg"
    } else if ct.contains("flac") {
        "flac"
    } else if ct.contains("aac") {
        "aac"
    } else if ct.contains("wav") {
        "wav"
    } else {
        "mp3"
    }
}

pub fn parse_audio_files(json: Option<&str>) -> Vec<AudioFileRecord> {
    json.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}
