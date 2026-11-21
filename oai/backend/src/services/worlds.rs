//! VR Worlds: a library image becomes an explorable Gaussian-splat world.
//!
//! A job stages the stored image into an OffloadMQ input bucket and submits a
//! `world.splat` task (agent: `exec/world/`) with an output bucket. On
//! completion the scene PLY and its preview contact sheet are copied into OAI
//! storage; the SPA renders the PLY with Spark/WebXR, and [`share_link`] mints a
//! signed, login-free URL so a Quest browser can open it directly.
//!
//! Lifecycle (poll / cancel / reconcile / bucket release) is the generic
//! [`offload_job`] driver; this module supplies the feature-specific pieces.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    db::{entities::world_jobs::Entity as WorldJobEntity, image_generation, offload_jobs, worlds},
    error::{AppError, ResultExt},
    offload::task_status::{self, NormalizedPoll, OffloadPoller},
    services::{
        image_paths, offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
    state::AppState,
};

pub const CAPABILITY_PREFIX: &str = "world.";
pub const MODES: [&str; 3] = ["auto", "perspective", "pano"];
/// Hard cap on a stored scene. The agent's own budget (`max_width` ≤ 2048) keeps
/// real scenes far below it; this only guards against a misbehaving agent.
pub const MAX_PLY_BYTES: i64 = 512 * 1024 * 1024;
const MAX_PREVIEW_BYTES: i64 = 32 * 1024 * 1024;
/// Concurrent PLY downloads across the process (each buffers the file in memory).
static DOWNLOAD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
const LINK_PREFIX: &str = "vr-world";

/// One `world.*` capability advertised by an online agent.
#[derive(Debug, Serialize)]
pub struct WorldCapability {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
}

/// Normalized generation knobs. Stored as `params_json` and replayed by retry;
/// field names match the agent payload (docs/agent-capabilities.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorldParams {
    pub mode: String,
    pub max_width: u32,
    pub fill_lean: f64,
    pub hfov: f64,
    pub near: f64,
    pub far: f64,
}

/// Raw, optional request knobs — everything defaults.
#[derive(Debug, Default, Deserialize)]
pub struct WorldParamsInput {
    pub mode: Option<String>,
    pub max_width: Option<u32>,
    pub fill_lean: Option<f64>,
    pub hfov: Option<f64>,
    pub near: Option<f64>,
    pub far: Option<f64>,
}

fn in_range(name: &str, v: f64, lo: f64, hi: f64) -> Result<f64, AppError> {
    if v.is_finite() && (lo..=hi).contains(&v) {
        Ok(v)
    } else {
        Err(AppError::BadRequest(format!("{name} must be between {lo} and {hi}")))
    }
}

impl WorldParamsInput {
    /// Validate up front: a typo is a 400 on submit, not a job that fails on the agent.
    pub fn normalize(&self) -> Result<WorldParams, AppError> {
        let mode = self.mode.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or("auto");
        if !MODES.contains(&mode) {
            return Err(AppError::BadRequest(format!("mode must be one of {}", MODES.join(", "))));
        }
        let max_width = self.max_width.unwrap_or(1024);
        if !(256..=2048).contains(&max_width) {
            return Err(AppError::BadRequest("max_width must be between 256 and 2048".into()));
        }
        let near = in_range("near", self.near.unwrap_or(1.2), 0.1, 20.0)?;
        let far = in_range("far", self.far.unwrap_or(50.0), 1.0, 1000.0)?;
        if far < near + 0.5 {
            return Err(AppError::BadRequest("far must be at least 0.5 m beyond near".into()));
        }
        Ok(WorldParams {
            mode: mode.to_string(),
            max_width,
            fill_lean: in_range("fill_lean", self.fill_lean.unwrap_or(0.25), 0.0, 1.0)?,
            hfov: in_range("hfov", self.hfov.unwrap_or(70.0), 20.0, 150.0)?,
            near,
            far,
        })
    }
}

pub struct StartJobParams {
    pub capability: String,
    pub input_image_id: i64,
    pub params: WorldParamsInput,
}

struct WorldsReconciler;

#[async_trait]
impl JobReconciler for WorldsReconciler {
    type Entity = WorldJobEntity;

    fn label(&self) -> &'static str {
        "worlds"
    }

    fn failure_fallback(&self) -> &'static str {
        "world generation failed"
    }

    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::image_client(state).await?))
    }

    async fn on_poll(&self, state: &AppState, job: &worlds::WorldJob, poll: &NormalizedPoll) -> Result<(), AppError> {
        worlds::record_progress(
            &state.db,
            job.id,
            task_status::is_executing(&poll.status),
            poll.typical_runtime_seconds,
        )
        .await
    }

    async fn on_completed(&self, state: &AppState, job: &worlds::WorldJob, poll: &NormalizedPoll) -> Result<(), AppError> {
        if job.ply_path.is_some() {
            return Ok(());
        }
        let _slot = DOWNLOAD_SLOTS
            .acquire()
            .await
            .map_err(|_| AppError::Internal("world download semaphore closed".into()))?;
        // The worker and a foreground poll can both see `completed`. Wait for the
        // other one rather than failing the user's poll request; it re-checks below.
        let lock = wait_for_download_lock(state, job.id).await?;
        let fresh = offload_jobs::get_job::<WorldJobEntity>(&state.db, job.id, job.user_id)
            .await?
            .ok_or(AppError::NotFound)?;
        if fresh.ply_path.is_some() {
            return Ok(());
        }
        let result = persist_world(state, &fresh, poll).await;
        lock.rollback().await.log_warn("release world download lock");
        result
    }
}

async fn wait_for_download_lock(state: &AppState, job_id: i64) -> Result<sea_orm::DatabaseTransaction, AppError> {
    for _ in 0..240 {
        if let Some(lock) = image_generation::try_lock_output_download(&state.db, job_id).await? {
            return Ok(lock);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(AppError::Internal(format!("world {job_id}: download lock held for over 2 minutes")))
}

/// A `{bucket_uid, file_uid}` reference from the task output, checked against the
/// job's own bucket so a crafted output can't make OAI fetch someone else's file.
fn file_ref<'a>(output: &'a serde_json::Value, key: &str, bucket: &str) -> Result<Option<(&'a str, i64)>, AppError> {
    let Some(entry) = output.get(key).filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let file_uid = entry
        .get("file_uid")
        .and_then(|v| v.as_str())
        .filter(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .ok_or_else(|| AppError::BadRequest(format!("world output `{key}` has no valid file_uid")))?;
    if entry.get("bucket_uid").and_then(|v| v.as_str()) != Some(bucket) {
        return Err(AppError::BadRequest(format!("world output `{key}` points outside the job's bucket")));
    }
    let bytes = entry.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(Some((file_uid, bytes)))
}

async fn persist_world(state: &AppState, job: &worlds::WorldJob, poll: &NormalizedPoll) -> Result<(), AppError> {
    let output = poll
        .output
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("world task returned no output".into()))?;
    let bucket = job
        .output_bucket_uid
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("world job has no output bucket".into()))?;
    let (ply_uid, declared) = file_ref(output, "ply", bucket)?
        .ok_or_else(|| AppError::BadRequest("world task output has no `ply` file".into()))?;
    if declared > MAX_PLY_BYTES {
        return Err(AppError::BadRequest(format!("world scene is {declared} bytes, over the {MAX_PLY_BYTES} limit")));
    }

    let client = offload_factory::image_client(state).await?;
    let op = storage::operator(state)?;
    let (ply, _) = client.download_bucket_file(bucket, ply_uid).await?;
    if ply.len() as i64 > MAX_PLY_BYTES {
        return Err(AppError::BadRequest("world scene exceeds the size limit".into()));
    }
    if !ply.starts_with(b"ply\n") {
        return Err(AppError::BadRequest("world scene is not a PLY file".into()));
    }
    let ply_bytes = ply.len() as i64;
    let ply_path = image_paths::world_ply_path(job.user_id, job.id);
    storage::write(op, &ply_path, ply).await?;

    // The preview is a nicety: a missing or oversized one never fails the world.
    let mut preview_path = None;
    if let Some((uid, size)) = file_ref(output, "preview", bucket).log_warn("world preview ref").flatten()
        && size <= MAX_PREVIEW_BYTES
        && let Some((bytes, _)) = client.download_bucket_file(bucket, uid).await.log_warn("world preview download")
        && bytes.len() as i64 <= MAX_PREVIEW_BYTES
    {
        let path = image_paths::world_preview_path(job.user_id, job.id);
        if storage::write(op, &path, bytes).await.log_warn("world preview write").is_some() {
            preview_path = Some(path);
        }
    }

    let mut summary = output.clone();
    if let Some(map) = summary.as_object_mut() {
        for key in ["ply", "preview", "depth", "output_bucket"] {
            map.remove(key);
        }
        if let Some(sha) = output.pointer("/ply/sha256").cloned() {
            map.insert("ply_sha256".into(), sha);
        }
    }
    let result_json = serde_json::to_string(&summary).map_err(|e| AppError::Internal(format!("serialize result: {e}")))?;
    worlds::set_result(
        &state.db,
        job.id,
        worlds::WorldResult { result_json: &result_json, ply_path: &ply_path, preview_path: preview_path.as_deref(), ply_bytes },
    )
    .await
}

/// Every `world.*` capability online right now.
pub async fn list_capabilities(state: &AppState) -> Result<Vec<WorldCapability>, AppError> {
    let raw = offload_factory::chat_client(state).await?.list_capabilities_raw().await?;
    Ok(crate::offload::parse_capabilities_with_prefix(&raw, CAPABILITY_PREFIX)
        .into_iter()
        .map(|c| WorldCapability { base: c.base, tags: c.tags, raw: c.raw })
        .collect())
}

fn input_extension(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    }
}

pub async fn start_job(state: &AppState, user_id: i64, params: StartJobParams) -> Result<i64, AppError> {
    let op = storage::operator(state)?;
    let capability = crate::offload::base_capability(&params.capability).to_string();
    if !capability.starts_with(CAPABILITY_PREFIX) || capability.len() == CAPABILITY_PREFIX.len() {
        return Err(AppError::BadRequest(format!("capability must start with `{CAPABILITY_PREFIX}`")));
    }
    let world_params = params.params.normalize()?;
    let input = image_generation::get_image_file(&state.db, params.input_image_id, user_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("input_image_id must reference an image in your library".into()))?;
    if !list_capabilities(state).await?.iter().any(|c| c.base == capability) {
        return Err(AppError::BadRequest(format!("no online agent provides `{capability}`")));
    }

    let client = offload_factory::image_client(state).await?;
    let job_id = state.next_id();
    let params_json =
        serde_json::to_string(&world_params).map_err(|e| AppError::Internal(format!("serialize params: {e}")))?;
    worlds::create_job(
        &state.db,
        worlds::NewJobInput {
            id: job_id,
            user_id,
            capability: &capability,
            mode: &world_params.mode,
            params_json: &params_json,
            input_image_id: input.id,
        },
    )
    .await?;

    let mut buckets: Vec<String> = Vec::new();
    let submitted: Result<(String, String, String), AppError> = async {
        let in_bucket = client.create_bucket(true).await?.bucket_uid;
        buckets.push(in_bucket.clone());
        let out_bucket = client.create_bucket(false).await?.bucket_uid;
        buckets.push(out_bucket.clone());
        // The stored original, not a re-encode: the agent fits it to `max_width`.
        let bytes = storage::read(op, &input.storage_path).await?;
        let name = format!("input_{}.{}", input.id, input_extension(&input.content_type));
        client.upload_bucket_file(&in_bucket, bytes, &name, &input.content_type).await?;
        let mut payload = serde_json::to_value(&world_params)
            .map_err(|e| AppError::Internal(format!("serialize payload: {e}")))?;
        payload["input_image"] = serde_json::Value::String(name);
        // Not used by the agent; lets the scheduler scale its runtime estimate.
        payload["resolution"] = serde_json::json!({ "width": input.stored_width, "height": input.stored_height });
        let (task, _) = client
            .submit_img_task(&capability, payload, Some(&in_bucket), &out_bucket, None)
            .await?;
        Ok((task.cap, task.id, out_bucket))
    }
    .await;

    let (cap, task_id, out_bucket) = match submitted {
        Ok(v) => v,
        Err(e) => {
            for uid in &buckets {
                client.delete_bucket(uid).await.log_warn("delete world bucket after failed submit");
            }
            offload_jobs::update_status::<WorldJobEntity>(&state.db, job_id, "failed", None, Some(&e.to_string()))
                .await
                .log_warn("mark world job failed");
            return Err(e);
        }
    };
    offload_jobs::set_offload_task::<WorldJobEntity>(&state.db, job_id, &cap, &task_id, Some(&out_bucket)).await?;
    state.watch.track(&cap, &task_id).await;
    Ok(job_id)
}

pub fn parse_params(json: &str) -> Option<WorldParams> {
    serde_json::from_str(json).ok()
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = get_user_job(state, user_id, job_id).await?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    let input_image_id = job
        .input_image_id
        .ok_or_else(|| AppError::BadRequest("retry requires the original input image".into()))?;
    let p = parse_params(&job.params_json);
    start_job(
        state,
        user_id,
        StartJobParams {
            capability: job.capability,
            input_image_id,
            params: WorldParamsInput {
                mode: p.as_ref().map(|p| p.mode.clone()),
                max_width: p.as_ref().map(|p| p.max_width),
                fill_lean: p.as_ref().map(|p| p.fill_lean),
                hfov: p.as_ref().map(|p| p.hfov),
                near: p.as_ref().map(|p| p.near),
                far: p.as_ref().map(|p| p.far),
            },
        },
    )
    .await
}

/// Delete a finished job and its stored scene. In-flight jobs must be canceled
/// first, so a late completion can't write blobs for a row that no longer exists.
pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = get_user_job(state, user_id, job_id).await?;
    if !task_status::is_terminal(&job.status) {
        return Err(AppError::BadRequest("cancel the job before deleting it".into()));
    }
    if let Ok(op) = storage::operator(state) {
        // Deterministic paths, so a half-written download is cleaned up too.
        for path in [image_paths::world_ply_path(user_id, job_id), image_paths::world_preview_path(user_id, job_id)] {
            storage::delete(op, &path).await.log_warn("delete world blob");
        }
    }
    offload_jobs::delete_job::<WorldJobEntity>(&state.db, job_id, user_id).await
}

pub async fn cancel_job(state: &AppState, user_id: i64, job_id: i64) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&WorldsReconciler, state, user_id, job_id).await
}

pub async fn poll_job(state: &AppState, user_id: i64, job_id: i64) -> Result<worlds::WorldJob, AppError> {
    offload_job::poll_job(&WorldsReconciler, state, user_id, job_id).await
}

pub async fn get_user_job(state: &AppState, user_id: i64, job_id: i64) -> Result<worlds::WorldJob, AppError> {
    offload_jobs::get_job::<WorldJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list_user_jobs(state: &AppState, user_id: i64, limit: u64) -> Result<Vec<worlds::WorldJob>, AppError> {
    offload_jobs::list_jobs::<WorldJobEntity>(&state.db, user_id, limit).await
}

pub async fn run_background_reconcile_pass(state: &AppState, batch_size: u64) -> Result<(), AppError> {
    offload_job::reconcile_pass(&WorldsReconciler, state, batch_size).await
}

// --------------------------------------------------------------------------- share links

fn link_ttl() -> chrono::Duration {
    let hours = std::env::var("WORLD_LINK_TTL_HOURS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|h| (1..=24 * 30).contains(h))
        .unwrap_or(24);
    chrono::Duration::hours(hours)
}

fn link_message(job_id: i64, user_id: i64, exp: i64) -> String {
    format!("{LINK_PREFIX}:{job_id}.{user_id}.{exp}")
}

#[derive(Debug, Serialize)]
pub struct ShareLink {
    /// SPA page that opens the world full-screen with an Enter VR button.
    pub viewer_url: String,
    pub ply_url: String,
    pub preview_url: Option<String>,
    pub expires_at: String,
}

/// Login-free links to a completed world, valid for `WORLD_LINK_TTL_HOURS` (24).
/// The signature covers job, owner and expiry, so it can't be re-pointed.
pub async fn share_link(state: &AppState, base: &str, user_id: i64, job_id: i64) -> Result<ShareLink, AppError> {
    let job = get_user_job(state, user_id, job_id).await?;
    if job.status != "completed" || job.ply_path.is_none() {
        return Err(AppError::BadRequest("only completed worlds can be shared".into()));
    }
    let expires = chrono::Utc::now() + link_ttl();
    let exp = expires.timestamp();
    let sig = state.auth.sign_link(&link_message(job_id, user_id, exp));
    let query = format!("u={user_id}&exp={exp}&sig={sig}");
    Ok(ShareLink {
        viewer_url: format!("{base}/worlds/view/{job_id}?{query}"),
        ply_url: format!("{base}/api/worlds/public/{job_id}/scene.ply?{query}"),
        preview_url: job
            .preview_path
            .as_ref()
            .map(|_| format!("{base}/api/worlds/public/{job_id}/preview.png?{query}")),
        expires_at: expires.to_rfc3339(),
    })
}

/// Resolve a signed public request to its (completed) job. Every failure is 403 so
/// the endpoint doesn't reveal which job ids exist.
pub async fn verify_public(state: &AppState, job_id: i64, user_id: i64, exp: i64, sig: &str) -> Result<worlds::WorldJob, AppError> {
    if exp <= chrono::Utc::now().timestamp() || !state.auth.verify_link(&link_message(job_id, user_id, exp), sig) {
        return Err(AppError::Forbidden);
    }
    let job = offload_jobs::get_job::<WorldJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if job.status != "completed" {
        return Err(AppError::Forbidden);
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_default_and_validate() {
        let p = WorldParamsInput::default().normalize().unwrap();
        assert_eq!(
            p,
            WorldParams { mode: "auto".into(), max_width: 1024, fill_lean: 0.25, hfov: 70.0, near: 1.2, far: 50.0 }
        );
        let bad = |i: WorldParamsInput| assert!(matches!(i.normalize(), Err(AppError::BadRequest(_))));
        bad(WorldParamsInput { mode: Some("cubemap".into()), ..Default::default() });
        bad(WorldParamsInput { max_width: Some(4096), ..Default::default() });
        bad(WorldParamsInput { fill_lean: Some(f64::NAN), ..Default::default() });
        bad(WorldParamsInput { near: Some(10.0), far: Some(10.2), ..Default::default() });
        let pano = WorldParamsInput { mode: Some(" pano ".into()), ..Default::default() }.normalize().unwrap();
        assert_eq!(pano.mode, "pano");
    }

    #[test]
    fn file_refs_must_stay_in_the_job_bucket() {
        let out = serde_json::json!({
            "ply": {"file_uid": "abc-123", "bucket_uid": "b1", "bytes": 42},
            "evil": {"file_uid": "../x", "bucket_uid": "b1"},
            "other": {"file_uid": "abc", "bucket_uid": "b2"},
            "unscoped": {"file_uid": "abc"},
        });
        assert_eq!(file_ref(&out, "ply", "b1").unwrap(), Some(("abc-123", 42)));
        assert_eq!(file_ref(&out, "missing", "b1").unwrap(), None);
        assert!(file_ref(&out, "evil", "b1").is_err());
        assert!(file_ref(&out, "other", "b1").is_err());
        assert!(file_ref(&out, "unscoped", "b1").is_err());
    }

    #[test]
    fn link_message_binds_job_user_and_expiry() {
        assert_eq!(link_message(5, 7, 99), "vr-world:5.7.99");
        assert_ne!(link_message(5, 7, 99), link_message(5, 8, 99));
        let auth = crate::middleware::auth::Auth::new(b"test-world-signatures", 1);
        let sig = auth.sign_link(&link_message(5, 7, 99));
        assert!(auth.verify_link(&link_message(5, 7, 99), &sig));
        for message in [link_message(6, 7, 99), link_message(5, 8, 99), link_message(5, 7, 100)] {
            assert!(!auth.verify_link(&message, &sig));
        }
    }
}
