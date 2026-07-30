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

/// WS watch loop poll cadence — matches `llm_debate`'s.
const WS_POLL_INTERVAL: Duration = Duration::from_secs(1);

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

pub async fn list_capabilities_ws(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    match list_capabilities(state, user_id).await {
        Ok(caps) => {
            let _ = tx.send(ServerEvent::MovieCapabilities {
                req_id,
                llm: caps.llm,
                video: caps.video,
            });
        }
        Err(e) => send_ws_error(tx, Some(&req_id), &e.to_string()),
    }
}

pub async fn watch_job_ws(
    req_id: String,
    job_id_str: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    let job_id = match job_id_str.parse::<i64>() {
        Ok(id) => id,
        Err(_) => {
            send_ws_error(tx, Some(&req_id), "invalid job_id");
            return;
        }
    };

    loop {
        let mut job = match movie::get_job(&state.db, job_id, user_id).await {
            Ok(Some(j)) => j,
            Ok(None) => {
                send_ws_error(tx, Some(&req_id), "job not found");
                return;
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        };

        if !task_status::is_terminal(&job.status) {
            if let Err(e) = reconcile_job(state, &mut job).await {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        let terminal = task_status::is_terminal(&job.status);
        match job_view(job) {
            Ok(view) => {
                let _ = tx.send(ServerEvent::MovieUpdate {
                    req_id: req_id.clone(),
                    job: view,
                    terminal,
                });
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        if terminal {
            return;
        }
        tokio::time::sleep(WS_POLL_INTERVAL).await;
    }
}

fn send_ws_error(tx: &UnboundedSender<ServerEvent>, req_id: Option<&str>, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: req_id.map(str::to_string),
        message: message.to_string(),
    });
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
                    let _ = image_jobs::cancel_job(state, user_id, imggen_job_id).await;
                }
            }
        }
        return;
    }
    if let (Some(cap), Some(id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) {
        if let Ok(client) = offload_factory::chat_client(state).await {
            let _ = client.cancel_task(&TaskId { cap, id }).await;
        }
    }
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = movie::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(file_id) = job.movie_file_id {
        if let Some(file) = image_generation::get_image_file(&state.db, file_id, user_id).await? {
            if let Ok(op) = storage::operator(state) {
                let _ = storage::delete(op, &file.storage_path).await;
                if let Some(thumb) = file.thumbnail_storage_path.clone() {
                    let _ = storage::delete(op, &thumb).await;
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

pub async fn run_background_reconcile_pass(state: &AppState, batch: u64) -> Result<(), AppError> {
    let jobs = movie::list_inflight_jobs(&state.db, batch).await?;
    for mut job in jobs {
        let _ = reconcile_job(state, &mut job).await;
    }
    Ok(())
}

async fn recalc_user_storage(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let total = image_generation::sum_user_stored_bytes(&state.db, user_id).await?;
    users::update_used_storage(&state.db, user_id, total).await
}

// ── The state machine ───────────────────────────────────────────────────────

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

/// Replace the outline + scene records. Caller decides the resulting phase/status.
fn set_outline(job: &mut movie::MovieJob, outline: &[String]) -> Result<(), AppError> {
    job.outline_json = serde_json::to_string(outline).map_err(json_err)?;
    let scenes: Vec<SceneRecord> = outline
        .iter()
        .enumerate()
        .map(|(i, o)| SceneRecord {
            index: i as i32,
            outline: o.clone(),
            prompt: None,
            workflow: String::new(),
            input_image_id: None,
            imggen_job_id: None,
            video_file_id: None,
            last_frame_image_id: None,
            status: "pending".into(),
            error: None,
            submitted_at: None,
            started_at: None,
            typical_runtime_seconds: None,
            execution_seconds: None,
        })
        .collect();
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    job.current_scene = 0;
    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    job.stage = None;
    Ok(())
}

/// Land on `scene_prompt`/running when auto-approve is on, else park at the
/// approval gate.
fn apply_outline_and_gate(job: &mut movie::MovieJob, outline: &[String]) -> Result<(), AppError> {
    set_outline(job, outline)?;
    if job.auto_approve {
        job.phase = "scene_prompt".into();
        job.status = "running".into();
    } else {
        job.status = "awaitingApproval".into();
    }
    Ok(())
}

fn split_or_repeat_idea(idea: &str, n: usize) -> Vec<String> {
    let lines: Vec<String> = idea
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() == n {
        lines
    } else {
        vec![idea.trim().to_string(); n]
    }
}

fn strip_list_marker(line: &str) -> String {
    let trimmed = line.trim();
    for prefix in ["- ", "* ", "\u{2022} "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        if let Some(sep) = trimmed.as_bytes().get(digits) {
            if *sep == b'.' || *sep == b')' {
                return trimmed[digits + 1..].trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn parse_outline(text: &str, n: usize) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .map(strip_list_marker)
        .filter(|l| !l.is_empty())
        .collect();
    lines.truncate(n);
    while lines.len() < n {
        lines.push(format!("Scene {}", lines.len() + 1));
    }
    lines
}

async fn reconcile_director(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    if job.offload_cap.is_none() && job.offload_task_id.is_none() {
        if !job.expand_prompt {
            let outline = split_or_repeat_idea(&job.idea, job.scene_count as usize);
            job.raw_outline = None;
            apply_outline_and_gate(job, &outline)?;
            return movie::update_job_state(&state.db, job).await;
        }

        let client = offload_factory::chat_client(state).await?;
        let user_content = format!(
            "{}\n\nProduce exactly {} scenes as a numbered list, one line each. Do not include any other text.",
            job.idea.trim(),
            job.scene_count
        );
        let messages = vec![
            ChatMessage { role: "system".into(), content: job.director_system.clone() },
            ChatMessage { role: "user".into(), content: user_content },
        ];
        let task_id = client.submit_chat(&job.director_model, messages, None, None, None, None).await?;
        job.offload_cap = Some(task_id.cap);
        job.offload_task_id = Some(task_id.id);
        job.active_log = None;
        job.stage = None;
        job.status = "running".into();
        return movie::update_job_state(&state.db, job).await;
    }

    let (Some(cap), Some(id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) else {
        return Ok(());
    };
    let client = offload_factory::chat_client(state).await?;
    let poll = match client.poll_task(&TaskId { cap, id }).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = task_status::offload_task_missing_message(&e) {
                job.status = "failed".into();
                job.error = Some(reason);
                job.offload_cap = None;
                job.offload_task_id = None;
                return movie::update_job_state(&state.db, job).await;
            }
            return Err(e);
        }
    };
    if let Some(log) = poll.log.filter(|l| !l.is_empty()) {
        job.active_log = Some(log);
    }
    if let Some(stage) = poll.stage {
        job.stage = Some(stage);
    }

    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            if text.trim().is_empty() {
                job.status = "failed".into();
                job.error = Some("director returned an empty outline".into());
                job.offload_cap = None;
                job.offload_task_id = None;
            } else {
                let outline = parse_outline(&text, job.scene_count as usize);
                job.raw_outline = Some(text);
                apply_outline_and_gate(job, &outline)?;
            }
        }
        "failed" => {
            job.status = "failed".into();
            job.error = Some(task_status::extract_error_text(&poll.output, "director task failed"));
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        "canceled" => {
            job.status = "canceled".into();
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        other => {
            job.status = other.to_string();
        }
    }
    movie::update_job_state(&state.db, job).await
}

/// The frame to seed the scene's vision prompt (and, if long-shot, its
/// `img2video` input): the user-supplied first frame for scene 0, or the
/// previous scene's last frame in long-shot mode. `None` otherwise.
fn scene_frame_source(job: &movie::MovieJob, scenes: &[SceneRecord], idx: usize) -> Option<i64> {
    if idx == 0 {
        return job.initial_image_id;
    }
    if job.long_shot {
        return scenes.get(idx - 1).and_then(|s| s.last_frame_image_id);
    }
    None
}

fn build_scene_prompt_request(outline: &[String], scenes: &[SceneRecord], idx: usize) -> String {
    let full_outline = outline
        .iter()
        .enumerate()
        .map(|(i, o)| format!("{}. {}", i + 1, o))
        .collect::<Vec<_>>()
        .join("\n");
    let this_line = outline.get(idx).cloned().unwrap_or_default();
    let prev_prompt = scenes.get(idx.wrapping_sub(1)).and_then(|s| s.prompt.clone()).filter(|_| idx > 0);

    let mut parts = vec![
        format!("Full film outline ({} scenes):\n{}", outline.len(), full_outline),
        format!("You are writing the video-generation prompt for scene {} of {}.", idx + 1, outline.len()),
        format!("This scene's outline entry: {}", this_line),
    ];
    if let Some(prev) = prev_prompt.filter(|p| !p.is_empty()) {
        parts.push(format!("Previous scene's video prompt (for continuity): {prev}"));
    }
    parts.push("Respond with the video generation prompt only, no other text.".into());
    parts.join("\n\n")
}

async fn reconcile_scene_prompt(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let mut scenes = parse_scenes(job)?;
    let idx = job.current_scene as usize;
    if idx >= scenes.len() {
        job.phase = "assemble".into();
        return movie::update_job_state(&state.db, job).await;
    }

    if job.offload_cap.is_none() && job.offload_task_id.is_none() {
        let outline = parse_job_outline(job)?;
        let user_text = build_scene_prompt_request(&outline, &scenes, idx);
        let frame_id = scene_frame_source(job, &scenes, idx);

        let task_id = if let Some(frame_id) = frame_id {
            let input = image_generation::get_image_file(&state.db, frame_id, job.user_id)
                .await?
                .ok_or(AppError::NotFound)?;
            let op = storage::operator(state)?;
            let bytes = storage::read(op, &input.storage_path).await?;
            let processed = image_processing::process_image(bytes, Some(input.content_type.clone()))?;
            let img_client = offload_factory::image_client(state).await?;
            let bucket = img_client.create_bucket(true).await?;
            img_client
                .upload_bucket_file(&bucket.bucket_uid, processed.bytes, &input.filename, &processed.content_type)
                .await?;
            let chat_client = offload_factory::chat_client(state).await?;
            let messages = vec![
                serde_json::json!({ "role": "system", "content": job.scene_system }),
                serde_json::json!({ "role": "user", "content": user_text }),
            ];
            chat_client
                .submit_vision_task(&job.scene_model, messages, &bucket.bucket_uid, None)
                .await?
        } else {
            let chat_client = offload_factory::chat_client(state).await?;
            let messages = vec![
                ChatMessage { role: "system".into(), content: job.scene_system.clone() },
                ChatMessage { role: "user".into(), content: user_text },
            ];
            chat_client.submit_chat(&job.scene_model, messages, None, None, None, None).await?
        };

        job.offload_cap = Some(task_id.cap);
        job.offload_task_id = Some(task_id.id);
        job.active_log = None;
        job.stage = None;
        job.status = "running".into();
        scenes[idx].status = "prompting".into();
        scenes[idx].submitted_at = Some(chrono::Utc::now().fixed_offset());
        scenes[idx].started_at = None;
        scenes[idx].typical_runtime_seconds = None;
        scenes[idx].execution_seconds = None;
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
        return movie::update_job_state(&state.db, job).await;
    }

    let (Some(cap), Some(id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) else {
        return Ok(());
    };
    let client = offload_factory::chat_client(state).await?;
    let poll = match client.poll_task(&TaskId { cap, id }).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = task_status::offload_task_missing_message(&e) {
                job.status = "failed".into();
                job.error = Some(reason);
                job.offload_cap = None;
                job.offload_task_id = None;
                return movie::update_job_state(&state.db, job).await;
            }
            return Err(e);
        }
    };
    if let Some(log) = poll.log.filter(|l| !l.is_empty()) {
        job.active_log = Some(log);
    }
    if let Some(stage) = poll.stage {
        job.stage = Some(stage);
    }
    if scenes[idx].started_at.is_none() && matches!(poll.status.as_str(), "starting" | "running") {
        scenes[idx].started_at = Some(chrono::Utc::now().fixed_offset());
    }
    if let Some(typical) = poll.typical_runtime_seconds {
        scenes[idx].typical_runtime_seconds = Some(typical.as_secs_f64());
    }

    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            if text.trim().is_empty() {
                scenes[idx].status = "failed".into();
                scenes[idx].error = Some("scene director returned an empty prompt".into());
                job.status = "failed".into();
                job.error = Some(format!("scene {}: empty prompt from scene director", idx + 1));
                job.offload_cap = None;
                job.offload_task_id = None;
            } else {
                scenes[idx].prompt = Some(text.trim().to_string());
                scenes[idx].status = "rendering".into();
                job.phase = "video".into();
                job.offload_cap = None;
                job.offload_task_id = None;
                job.active_log = None;
                job.stage = None;
            }
        }
        "failed" => {
            let reason = task_status::extract_error_text(&poll.output, "scene director task failed");
            scenes[idx].status = "failed".into();
            scenes[idx].error = Some(reason.clone());
            job.status = "failed".into();
            job.error = Some(format!("scene {}: {reason}", idx + 1));
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        "canceled" => {
            job.status = "canceled".into();
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        other => {
            job.status = other.to_string();
        }
    }
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    movie::update_job_state(&state.db, job).await
}

async fn reconcile_video(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let mut scenes = parse_scenes(job)?;
    let idx = job.current_scene as usize;
    if idx >= scenes.len() {
        job.phase = "assemble".into();
        return movie::update_job_state(&state.db, job).await;
    }

    if scenes[idx].imggen_job_id.is_none() {
        let prompt = scenes[idx].prompt.clone().unwrap_or_default();
        if prompt.trim().is_empty() {
            job.status = "failed".into();
            job.error = Some(format!("scene {} has no prompt to render", idx + 1));
            return movie::update_job_state(&state.db, job).await;
        }
        let frame_id = scene_frame_source(job, &scenes, idx);
        let workflow = if frame_id.is_some() { "img2video" } else { "txt2video" };
        let capability = if workflow == "img2video" {
            job.img2video_capability.clone().ok_or_else(|| {
                AppError::Internal("scene requires img2video_capability but none is set".into())
            })?
        } else {
            job.txt2video_capability.clone()
        };

        let imggen_job_id = image_jobs::start_job(
            state,
            job.user_id,
            image_jobs::StartJobParams {
                capability,
                prompt,
                negative_prompt: None,
                override_negative: false,
                width: job.width,
                height: job.height,
                seed: None,
                workflow: Some(workflow.to_string()),
                input_image_id: frame_id.map(|id| id.to_string()),
                data_preparation: None,
                rescale: None,
                video_length: Some(job.scene_length),
            },
        )
        .await?;

        scenes[idx].workflow = workflow.to_string();
        scenes[idx].input_image_id = frame_id;
        scenes[idx].imggen_job_id = Some(imggen_job_id);
        // Timings belong to the imggen job now — drop the scene-director's
        // prompting-phase values so the progress bar doesn't show stale numbers.
        scenes[idx].submitted_at = None;
        scenes[idx].started_at = None;
        scenes[idx].typical_runtime_seconds = None;
        scenes[idx].execution_seconds = None;
        job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
        return movie::update_job_state(&state.db, job).await;
    }

    let imggen_job_id = scenes[idx].imggen_job_id.expect("checked above");
    let polled = image_jobs::poll_job(state, job.user_id, imggen_job_id).await?;
    scenes[idx].submitted_at = polled.submitted_at;
    scenes[idx].started_at = polled.started_at;
    scenes[idx].typical_runtime_seconds = polled.typical_runtime_seconds;

    match polled.status.as_str() {
        "completed" => {
            let Some(video_file) = polled.output_files.iter().find(|f| f.content_type.starts_with("video/")) else {
                // Output not persisted yet (race with the imggen worker's own
                // download step) — retry on the next reconcile pass.
                job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
                return movie::update_job_state(&state.db, job).await;
            };
            let video_file_id = video_file.id;
            let video_storage_path = video_file.storage_path.clone();
            scenes[idx].video_file_id = Some(video_file_id);
            scenes[idx].status = "completed".into();
            scenes[idx].execution_seconds = polled.execution_seconds;

            let is_last = idx + 1 >= scenes.len();
            if job.long_shot && !is_last {
                let op = storage::operator(state)?;
                let bytes = storage::read(op, &video_storage_path).await?;
                let frame_bytes = movie_ffmpeg::last_frame_jpeg(&bytes)?;
                let uploaded = image_jobs::upload_input_image(
                    state,
                    job.user_id,
                    format!("scene-{}-lastframe.jpg", idx + 1),
                    frame_bytes,
                    "image/jpeg".to_string(),
                )
                .await?;
                scenes[idx].last_frame_image_id = Some(uploaded.id);
            }

            if is_last {
                job.phase = "assemble".into();
            } else {
                job.current_scene += 1;
                job.phase = "scene_prompt".into();
            }
        }
        "failed" | "canceled" => {
            let reason = polled.error.clone().unwrap_or_else(|| "video generation failed".into());
            scenes[idx].status = "failed".into();
            scenes[idx].error = Some(reason.clone());
            job.status = "failed".into();
            job.error = Some(format!("scene {}: {reason}", idx + 1));
        }
        _ => {
            // Still in flight — timings above already captured this pass's
            // progress snapshot; nothing else to do until it's terminal.
        }
    }
    job.scenes_json = serde_json::to_string(&scenes).map_err(json_err)?;
    movie::update_job_state(&state.db, job).await
}

async fn reconcile_assemble(state: &AppState, job: &mut movie::MovieJob) -> Result<(), AppError> {
    let scenes = parse_scenes(job)?;
    let op = storage::operator(state)?;
    let mut clips = Vec::with_capacity(scenes.len());
    for scene in &scenes {
        let Some(file_id) = scene.video_file_id else {
            job.status = "failed".into();
            job.error = Some(format!("scene {} is missing its rendered clip", scene.index + 1));
            return movie::update_job_state(&state.db, job).await;
        };
        let file = image_generation::get_image_file(&state.db, file_id, job.user_id)
            .await?
            .ok_or(AppError::NotFound)?;
        clips.push(storage::read(op, &file.storage_path).await?);
    }

    let movie_bytes = movie_ffmpeg::concat_videos(&clips)?;
    let thumbnail_bytes = image_processing::thumbnail_from_video(&movie_bytes)?;

    let file_id = state.next_id();
    let storage_path = image_paths::movie_output_path(job.user_id, job.id, file_id);
    let thumbnail_storage_path = image_paths::thumbnail_path(job.user_id, file_id);
    storage::write(op, &storage_path, movie_bytes.clone()).await?;
    storage::write(op, &thumbnail_storage_path, thumbnail_bytes.clone()).await?;

    let sha256 = image_processing::sha256_hex(&movie_bytes);
    image_generation::create_image_file(
        &state.db,
        image_generation::NewImageFileInput {
            id: file_id,
            user_id: job.user_id,
            job_id: None,
            direction: "output",
            source: "movie",
            storage_path: &storage_path,
            thumbnail_storage_path: &thumbnail_storage_path,
            thumbnail_stored_bytes: thumbnail_bytes.len() as i64,
            filename: "movie.mp4",
            content_type: "video/mp4",
            original_bytes: None,
            stored_bytes: movie_bytes.len() as i64,
            original_width: None,
            original_height: None,
            stored_width: 0,
            stored_height: 0,
            exif_orientation: None,
            rescaled: false,
            reencoded: false,
            sha256: &sha256,
            offload_bucket_uid: None,
            offload_file_uid: None,
        },
    )
    .await?;
    recalc_user_storage(state, job.user_id).await?;

    job.movie_file_id = Some(file_id);
    job.status = "completed".into();
    job.phase = "done".into();
    movie::update_job_state(&state.db, job).await
}
