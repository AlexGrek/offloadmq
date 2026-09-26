//! Movie Studio: a "director" LLM expands an idea into N scenes; a "scene
//! director" (vision) LLM turns each outline item into a concrete video
//! prompt; each prompt renders a clip via the imggen video pipeline; in
//! long-shot mode the last frame of clip *i* seeds clip *i+1*; ffmpeg
//! concatenates the finished clips into one movie.
//!
//! The job is a DB-persisted state machine, modeled directly on
//! `services::llm_debate::reconcile_job` — `reconcile_job` here is the single
//! entry point, called by the WS watcher, the background worker, and
//! `poll_job`. Unlike debate (one offload task per turn), a movie job cycles
//! through two different kinds of offload task (LLM, then imggen video) across
//! four phases, so `phase` tracks which kind of work `offload_cap`/
//! `offload_task_id` (or the current scene's `imggen_job_id`) refers to.

use crate::error::ResultExt;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

use crate::{
    db::{image_generation, movie, users},
    error::AppError,
    offload::{base_capability, task_status, ChatMessage, LlmCapabilityInfo, TaskId},
    services::{
        image_jobs, image_paths, image_processing, llm_text_capabilities, offload_factory,
        offload_job::CancelOutcome, storage, movie_ffmpeg,
    },
    state::AppState,
    ws::events::ServerEvent,
};

mod assemble;
mod outline;
mod scenes;
mod watch;

use assemble::*;
use outline::*;
use scenes::*;
pub use watch::*;

pub const DEFAULT_DIRECTOR_SYSTEM: &str = "You are a film director breaking a short film idea into a sequence of distinct scenes. Given an idea, respond with a numbered list of scenes that together tell a coherent, visually varied story. Each line must describe one scene in one or two sentences. Respond with the numbered list only — no other commentary.";

pub const DEFAULT_SCENE_SYSTEM: &str = "You are a cinematographer writing prompts for an AI video generator. You will be given a film's full scene outline, which scene number you are writing for, that scene's outline entry, the previous scene's finished video prompt (for continuity), and sometimes a frame image showing where the previous scene left off. Write the video-generation prompt for the requested scene only: describe the subjects, action, and camera framing in one paragraph. Respond with the prompt only — no scene numbers, no explanations, no other text.";

const MAX_SCENE_COUNT: i32 = 50;

const MAX_SCENE_LENGTH: i32 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneRecord {
    pub index: i32,
    pub outline: String,
    pub prompt: Option<String>,
    pub workflow: String,
    pub input_image_id: Option<i64>,
    pub imggen_job_id: Option<i64>,
    pub video_file_id: Option<i64>,
    pub last_frame_image_id: Option<i64>,
    /// `pending | prompting | rendering | completed | failed`
    pub status: String,
    pub error: Option<String>,
    /// When this scene's current offload task (LLM or imggen) was submitted —
    /// queue-wait anchor. `#[serde(default)]` since older `scenes_json` rows
    /// predate these timing fields.
    #[serde(default)]
    pub submitted_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    /// When this scene's current offload task began executing on an agent.
    #[serde(default)]
    pub started_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    /// Execution-time estimate for this scene's current task (seconds).
    #[serde(default)]
    pub typical_runtime_seconds: Option<f64>,
    /// Time actually spent executing, set once this scene's render completes.
    #[serde(default)]
    pub execution_seconds: Option<f64>,
}

/// API view of a [`SceneRecord`] — snowflake ids as strings (JS numbers lose
/// precision above 2^53; every other id in this API is already a string).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneView {
    pub index: i32,
    pub outline: String,
    pub prompt: Option<String>,
    pub workflow: String,
    pub input_image_id: Option<String>,
    pub imggen_job_id: Option<String>,
    pub video_file_id: Option<String>,
    pub last_frame_image_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub submitted_at: Option<String>,
    pub started_at: Option<String>,
    pub typical_runtime_seconds: Option<f64>,
    pub execution_seconds: Option<f64>,
}

fn scene_view(scene: &SceneRecord) -> SceneView {
    SceneView {
        index: scene.index,
        outline: scene.outline.clone(),
        prompt: scene.prompt.clone(),
        workflow: scene.workflow.clone(),
        input_image_id: scene.input_image_id.map(|i| i.to_string()),
        imggen_job_id: scene.imggen_job_id.map(|i| i.to_string()),
        video_file_id: scene.video_file_id.map(|i| i.to_string()),
        last_frame_image_id: scene.last_frame_image_id.map(|i| i.to_string()),
        status: scene.status.clone(),
        error: scene.error.clone(),
        submitted_at: scene.submitted_at.map(|t| t.to_rfc3339()),
        started_at: scene.started_at.map(|t| t.to_rfc3339()),
        typical_runtime_seconds: scene.typical_runtime_seconds,
        execution_seconds: scene.execution_seconds,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieJobView {
    pub job_id: String,
    pub status: String,
    pub phase: String,
    pub idea: String,
    pub width: i32,
    pub height: i32,
    pub scene_count: i32,
    pub scene_length: i32,
    pub long_shot: bool,
    pub auto_approve: bool,
    pub expand_prompt: bool,
    pub director_model: String,
    pub scene_model: String,
    pub txt2video_capability: String,
    pub img2video_capability: Option<String>,
    pub director_system: String,
    pub scene_system: String,
    pub initial_image_id: Option<String>,
    pub outline: Vec<String>,
    pub scenes: Vec<SceneView>,
    pub current_scene: i32,
    pub active_log: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub movie_file_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct MovieCapabilities {
    pub llm: Vec<LlmCapabilityInfo>,
    pub video: Vec<LlmCapabilityInfo>,
}

pub struct StartJobParams {
    pub idea: String,
    pub width: i32,
    pub height: i32,
    pub scene_count: i32,
    pub scene_length: i32,
    pub long_shot: bool,
    pub auto_approve: bool,
    pub expand_prompt: bool,
    pub director_model: String,
    pub scene_model: String,
    pub txt2video_capability: String,
    pub img2video_capability: Option<String>,
    pub director_system: String,
    pub scene_system: String,
    pub initial_image_id: Option<String>,
}

pub struct ApproveParams {
    pub outline: Option<Vec<String>>,
}

fn json_err(e: serde_json::Error) -> AppError {
    AppError::Internal(format!("invalid movie job json: {e}"))
}

fn parse_job_outline(job: &movie::MovieJob) -> Result<Vec<String>, AppError> {
    serde_json::from_str(&job.outline_json).map_err(json_err)
}

fn parse_scenes(job: &movie::MovieJob) -> Result<Vec<SceneRecord>, AppError> {
    serde_json::from_str(&job.scenes_json).map_err(json_err)
}

fn normalize_llm_capability(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.starts_with("llm.") {
        base_capability(trimmed).to_string()
    } else {
        format!("llm.{}", base_capability(trimmed))
    }
}

fn normalize_video_capability(cap: &str) -> String {
    let trimmed = cap.trim();
    if trimmed.starts_with("imggen.") {
        base_capability(trimmed).to_string()
    } else {
        format!("imggen.{}", base_capability(trimmed))
    }
}

pub fn job_view(job: movie::MovieJob) -> Result<MovieJobView, AppError> {
    let outline = parse_job_outline(&job)?;
    let scenes = parse_scenes(&job)?;
    Ok(MovieJobView {
        job_id: job.id.to_string(),
        status: job.status,
        phase: job.phase,
        idea: job.idea,
        width: job.width,
        height: job.height,
        scene_count: job.scene_count,
        scene_length: job.scene_length,
        long_shot: job.long_shot,
        auto_approve: job.auto_approve,
        expand_prompt: job.expand_prompt,
        director_model: job.director_model,
        scene_model: job.scene_model,
        txt2video_capability: job.txt2video_capability,
        img2video_capability: job.img2video_capability,
        director_system: job.director_system,
        scene_system: job.scene_system,
        initial_image_id: job.initial_image_id.map(|i| i.to_string()),
        outline,
        scenes: scenes.iter().map(scene_view).collect(),
        current_scene: job.current_scene,
        active_log: job.active_log,
        stage: job.stage,
        error: job.error,
        movie_file_id: job.movie_file_id.map(|i| i.to_string()),
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}

pub async fn list_capabilities(
    state: &AppState,
    user_id: i64,
) -> Result<MovieCapabilities, AppError> {
    let llm = llm_text_capabilities::list_text_llm_capabilities(state).await?;
    let video = image_jobs::list_imggen_capabilities(state, user_id).await?;
    Ok(MovieCapabilities { llm, video })
}

pub async fn start_job(state: &AppState, user_id: i64, req: StartJobParams) -> Result<i64, AppError> {
    let idea = req.idea.trim();
    if idea.is_empty() {
        return Err(AppError::BadRequest("idea is required".into()));
    }
    if req.width <= 0 || req.height <= 0 {
        return Err(AppError::BadRequest("width and height are required".into()));
    }
    let scene_count = req.scene_count.clamp(1, MAX_SCENE_COUNT);
    let scene_length = req.scene_length.clamp(1, MAX_SCENE_LENGTH);

    let director_model = normalize_llm_capability(&req.director_model);
    if director_model == "llm." {
        return Err(AppError::BadRequest("director_model is required".into()));
    }
    let scene_model = normalize_llm_capability(&req.scene_model);
    if scene_model == "llm." {
        return Err(AppError::BadRequest("scene_model is required".into()));
    }
    let txt2video_capability = normalize_video_capability(&req.txt2video_capability);
    if txt2video_capability == "imggen." {
        return Err(AppError::BadRequest("txt2video_capability is required".into()));
    }

    let initial_image_id = req
        .initial_image_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.parse::<i64>().map_err(|_| AppError::BadRequest("invalid initial_image_id".into())))
        .transpose()?;
    if let Some(id) = initial_image_id {
        image_generation::get_image_file(&state.db, id, user_id)
            .await?
            .ok_or(AppError::NotFound)?;
    }

    let img2video_capability = req
        .img2video_capability
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(normalize_video_capability);
    if img2video_capability.is_none() && (req.long_shot || initial_image_id.is_some()) {
        return Err(AppError::BadRequest(
            "img2video_capability is required when long_shot is enabled or an initial image is supplied".into(),
        ));
    }

    let director_system = req.director_system.trim();
    let director_system = if director_system.is_empty() { DEFAULT_DIRECTOR_SYSTEM } else { director_system };
    let scene_system = req.scene_system.trim();
    let scene_system = if scene_system.is_empty() { DEFAULT_SCENE_SYSTEM } else { scene_system };

    let job_id = state.next_id();
    let mut job = movie::create_job(
        &state.db,
        movie::NewJobInput {
            id: job_id,
            user_id,
            idea,
            width: req.width,
            height: req.height,
            scene_count,
            scene_length,
            long_shot: req.long_shot,
            auto_approve: req.auto_approve,
            expand_prompt: req.expand_prompt,
            director_model: &director_model,
            scene_model: &scene_model,
            txt2video_capability: &txt2video_capability,
            img2video_capability: img2video_capability.as_deref(),
            director_system,
            scene_system,
            initial_image_id,
        },
    )
    .await?;

    reconcile_job(state, &mut job).await?;
    Ok(job_id)
}

pub async fn poll_job(state: &AppState, user_id: i64, job_id: i64) -> Result<movie::MovieJob, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    reconcile_job(state, &mut job).await?;
    movie::get_job(&state.db, job_id, user_id).await?.ok_or(AppError::NotFound)
}

pub async fn approve(
    state: &AppState,
    user_id: i64,
    job_id: i64,
    params: ApproveParams,
) -> Result<movie::MovieJob, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if job.status != "awaitingApproval" {
        return Err(AppError::BadRequest(format!(
            "job is not awaiting approval (status={})",
            job.status
        )));
    }
    if let Some(outline) = params.outline {
        if outline.len() != job.scene_count as usize {
            return Err(AppError::BadRequest(format!(
                "outline must have exactly {} scenes",
                job.scene_count
            )));
        }
        set_outline(&mut job, &outline)?;
    }
    job.phase = "scene_prompt".into();
    job.current_scene = 0;
    job.status = "running".into();
    movie::update_job_state(&state.db, &job).await?;
    Ok(job)
}

pub async fn stop(state: &AppState, user_id: i64, job_id: i64) -> Result<movie::MovieJob, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }
    if matches!(job.status.as_str(), "awaitingApproval" | "paused") {
        return Err(AppError::BadRequest(format!(
            "job is not running (status={})",
            job.status
        )));
    }

    cancel_inflight_task(state, user_id, &job).await;

    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.stage = None;
    job.status = "paused".into();
    movie::update_job_state(&state.db, &job).await?;
    Ok(job)
}

pub async fn resume(state: &AppState, user_id: i64, job_id: i64) -> Result<movie::MovieJob, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if job.status != "paused" {
        return Err(AppError::BadRequest(format!(
            "job is not paused (status={})",
            job.status
        )));
    }

    // Clear stale task links for the current phase so it re-submits cleanly.
    // Finished scenes are untouched, so nothing already-rendered regenerates.
    if job.phase == "video" {
        let mut scenes = parse_scenes(&job)?;
        let idx = job.current_scene as usize;
        if let Some(scene) = scenes.get_mut(idx) {
            if scene.status != "completed" {
                scene.imggen_job_id = None;
                scene.status = "pending".into();
                scene.error = None;
            }
        }
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    }

    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.stage = None;
    job.status = "running".into();
    movie::update_job_state(&state.db, &job).await?;
    Ok(job)
}

/// Resubmit whatever stage failed, instead of restarting the whole movie.
/// Unlike `resume` (which only needs to clear stale task links left by a
/// user-initiated `stop`), a `director`/`scene_prompt` failure also leaves the
/// current scene's own `status`/`error` set to `"failed"` — those must be
/// reset too so the resubmitted work isn't shadowed by stale failure state.
pub async fn retry(state: &AppState, user_id: i64, job_id: i64) -> Result<movie::MovieJob, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if job.status != "failed" {
        return Err(AppError::BadRequest(format!(
            "job is not failed (status={})",
            job.status
        )));
    }

    // `assemble` never advances `current_scene` past a real index, and its own
    // failure isn't scene-specific — only reset per-scene state for the two
    // phases that key work off `current_scene`.
    if matches!(job.phase.as_str(), "video" | "scene_prompt") {
        let mut scenes = parse_scenes(&job)?;
        let idx = job.current_scene as usize;
        if let Some(scene) = scenes.get_mut(idx) {
            scene.imggen_job_id = None;
            scene.status = "pending".into();
            scene.error = None;
        }
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    }

    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.stage = None;
    job.error = None;
    job.status = "running".into();
    movie::update_job_state(&state.db, &job).await?;
    Ok(job)
}

pub async fn cancel_job(state: &AppState, user_id: i64, job_id: i64) -> Result<CancelOutcome, AppError> {
    let mut job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }

    cancel_inflight_task(state, user_id, &job).await;

    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.status = "canceled".into();
    movie::update_job_state(&state.db, &job).await?;

    Ok(CancelOutcome {
        job_id,
        status: job.status.clone(),
        message: "Movie canceled".into(),
    })
}

/// Best-effort cancel of whatever offload work is currently in flight for a
/// job: an LLM turn (director/scene_prompt phase) or the current scene's
/// imggen video job (video phase).
async fn cancel_inflight_task(state: &AppState, user_id: i64, job: &movie::MovieJob) {
    if job.phase == "video" {
        if let Ok(scenes) = parse_scenes(job) {
            if let Some(scene) = scenes.get(job.current_scene as usize) {
                if let Some(imggen_job_id) = scene.imggen_job_id {
                    image_jobs::cancel_job(state, user_id, imggen_job_id)
                        .await
                        .log_warn("cancel movie scene render");
                }
            }
        }
        return;
    }
    if let (Some(cap), Some(id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) {
        if let Ok(client) = offload_factory::chat_client(state).await {
            client
                .cancel_task(&TaskId { cap: cap.clone(), id: id.clone() })
                .await
                .log_warn("cancel movie offload task");
        }
        state.watch.untrack(&cap, &id).await;
    }
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(file_id) = job.movie_file_id {
        if let Some(file) = image_generation::get_image_file(&state.db, file_id, user_id).await? {
            if let Ok(op) = storage::operator(state) {
                storage::delete(op, &file.storage_path).await.log_warn("delete movie scene clip");
                if let Some(thumb) = file.thumbnail_storage_path.clone() {
                    storage::delete(op, &thumb).await.log_warn("delete movie scene thumbnail");
                }
            }
            image_generation::delete_image_file(&state.db, file.id, user_id).await?;
            recalc_user_storage(state, user_id).await?;
        }
    }
    movie::delete_job(&state.db, job_id, user_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<movie::MovieJob>, AppError> {
    movie::list_jobs(&state.db, user_id, limit).await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<movie::MovieJob, AppError> {
    movie::get_job(&state.db, job_id, user_id).await?.ok_or(AppError::NotFound)
}

/// A job's structural position — changes only on a real state-machine
/// transition, never on a poll that comes back "still queued/running". Used to
/// detect when a job has stalled on external work so the drain loop below can
/// stop without wasting iterations re-polling it.
type JobFingerprint = (String, String, i32, Option<String>);

fn job_fingerprint(job: &movie::MovieJob) -> JobFingerprint {
    (
        job.status.clone(),
        job.phase.clone(),
        job.current_scene,
        job.offload_task_id.clone(),
    )
}

/// Cap on structural transitions drained per job per tick, so a job cycling
/// through several no-op phases can't loop indefinitely within one pass.
const MAX_DRAIN_STEPS: u32 = 8;

pub async fn run_background_reconcile_pass(state: &AppState, batch: u64) -> Result<(), AppError> {
    let jobs = movie::list_inflight_jobs(&state.db, batch).await?;
    for mut job in jobs {
        let job_id = job.id;
        for _ in 0..MAX_DRAIN_STEPS {
            let before = job_fingerprint(&job);
            if let Err(e) = reconcile_job(state, &mut job).await {
                tracing::warn!("movie worker: job {job_id} reconcile failed: {e}");
                break;
            }
            if job_fingerprint(&job) == before {
                break;
            }
        }
    }
    Ok(())
}

async fn recalc_user_storage(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let total = image_generation::sum_user_stored_bytes(&state.db, user_id).await?;
    users::update_used_storage(&state.db, user_id, total).await
}

async fn reconcile_job(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    if task_status::is_terminal(&job.status) {
        return Ok(());
    }
    if matches!(job.status.as_str(), "awaitingApproval" | "paused") {
        return Ok(());
    }
    match job.phase.as_str() {
        "director" => reconcile_director(state, job).await,
        "scene_prompt" => reconcile_scene_prompt(state, job).await,
        "video" => reconcile_video(state, job).await,
        "assemble" => reconcile_assemble(state, job).await,
        _ => Ok(()),
    }
}


