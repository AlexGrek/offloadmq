//! Persona photos: a parent job that chains ordinary child jobs —
//! `generate` (imggen txt2img/img2img) → `face_swap` (img-utils, source = one of the
//! persona's faces) → `upscale` (img-utils, `scale_multiplier`). Each child keeps its
//! own lifecycle, worker, buckets and storage, so intermediates show up in Image
//! Generation / Image Tools history and My Files. Same engine shape as
//! `services::image_cycles`: the child id is persisted before any side effect, and an
//! advisory lock serializes advance/cancel/delete across tabs, workers and pods.

use serde::{Deserialize, Serialize};

use crate::{
    db::{
        image_generation,
        persona_photos::{self as db, Job, NewJob},
        personas::Persona,
    },
    error::AppError,
    offload::{base_capability, task_status::is_terminal},
    routes::job_common::parse_id,
    services::{
        image_job_names, image_jobs, img_utils, personas, prompt_expansion::PromptExpander,
        prompt_previews,
    },
    state::AppState,
};

pub const DEFAULT_SIZE: i32 = 1024;
const MIN_SIZE: i32 = 64;
const MAX_SIZE: i32 = 4096;
pub const DEFAULT_SCALE: f64 = 2.0;
pub const MAX_COUNT: u32 = 8;
const PROMPT_BUCKET: &str = "imggen-prompt";
const NEGATIVE_BUCKET: &str = "imggen-negative";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Generate,
    FaceSwap,
    Upscale,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolChoice {
    pub capability: String,
    pub workflow: String,
}

/// Everything resolved at start, so retry replays exactly the same chain.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Params {
    pub workflow: String,
    pub image_model: String,
    pub input_image_id: Option<String>,
    pub negative_prompt: Option<String>,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    /// The face swapped in; `None` = no face-swap step.
    pub face_image_id: Option<String>,
    pub face_swap: Option<ToolChoice>,
    pub upscale: Option<ToolChoice>,
    pub scale: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Step {
    pub kind: Kind,
    /// Child-job status, plus `pending` (not started), `submitting`, `skipped`.
    pub status: String,
    pub capability: String,
    pub workflow: String,
    pub child_job_id: Option<String>,
    pub input_image_id: Option<String>,
    pub output_image_id: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PhotoView {
    pub job_id: String,
    pub persona_id: String,
    pub status: String,
    pub prompt_template: String,
    pub prompt: String,
    pub params: Params,
    pub steps: Vec<Step>,
    pub final_image_id: Option<String>,
    pub final_image: Option<personas::ImageRef>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `POST /api/personas/{id}/photos` body (also used by the CLI and MCP).
#[derive(Debug, Default, Deserialize, Clone)]
pub struct StartPhotoRequest {
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    /// `txt2img` (default) or `img2img` (needs `input_image_id`).
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub input_image_id: Option<String>,
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
    #[serde(default)]
    pub seed: Option<i64>,
    /// Photos to make (one parent job each), 1–8.
    #[serde(default)]
    pub count: Option<u32>,
    /// One of the persona's faces; defaults to the primary (first) face.
    #[serde(default)]
    pub face_image_id: Option<String>,
    /// Default: on when the persona has faces.
    #[serde(default)]
    pub face_swap: Option<bool>,
    /// Default: on.
    #[serde(default)]
    pub upscale: Option<bool>,
    /// Upscale multiplier, 1–8 (default 2).
    #[serde(default)]
    pub scale: Option<f64>,
    /// Per-request overrides of the persona's preferences.
    #[serde(default)]
    pub image_model: Option<String>,
    #[serde(default)]
    pub face_swap_capability: Option<String>,
    #[serde(default)]
    pub upscaler_capability: Option<String>,
}

fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, AppError> {
    serde_json::from_str(json).map_err(|e| AppError::Internal(format!("persona photo data: {e}")))
}
fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|e| AppError::Internal(format!("persona photo data: {e}")))
}

fn blank_to_none(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The step list for a parameter set: generate, then the optional post-steps.
pub fn plan_steps(p: &Params) -> Vec<Step> {
    let step = |kind: Kind, capability: &str, workflow: &str| Step {
        kind,
        status: "pending".into(),
        capability: capability.to_string(),
        workflow: workflow.to_string(),
        child_job_id: None,
        input_image_id: None,
        output_image_id: None,
        stage: None,
        error: None,
    };
    let mut steps = vec![step(Kind::Generate, &p.image_model, &p.workflow)];
    if let (Some(t), Some(_)) = (&p.face_swap, &p.face_image_id) {
        steps.push(step(Kind::FaceSwap, &t.capability, &t.workflow));
    }
    if let Some(t) = &p.upscale {
        steps.push(step(Kind::Upscale, &t.capability, &t.workflow));
    }
    steps
}

// ── Start ───────────────────────────────────────────────────────────────────

/// Validates, resolves every model up front, and starts one parent job per photo.
/// Returns the new job ids.
pub async fn start(
    state: &AppState,
    user_id: i64,
    persona_id: i64,
    req: StartPhotoRequest,
) -> Result<Vec<i64>, AppError> {
    let persona = personas::get(state, user_id, persona_id).await?;
    let template = req.prompt.trim().to_string();
    if template.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    let count = req.count.unwrap_or(1);
    if !(1..=MAX_COUNT).contains(&count) {
        return Err(AppError::BadRequest(format!(
            "count must be between 1 and {MAX_COUNT}"
        )));
    }
    let params = resolve_params(state, &persona, &req).await?;

    let mut expander = match PromptExpander::for_user(&state.db, user_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("persona photos: custom placeholders unavailable: {e}");
            PromptExpander::new([])
        }
    };
    // Expand every prompt before creating anything, so a bad template is one 400.
    let mut prompts = Vec::new();
    for _ in 0..count {
        prompts.push(expand_prompt(&template, &persona, &mut expander)?);
    }

    prompt_previews::record_use(state, user_id, PROMPT_BUCKET, &template)
        .await
        .map(|_| ())
        .unwrap_or_else(|e| tracing::warn!("persona photos: record prompt: {e}"));
    if let Some(n) = &params.negative_prompt {
        prompt_previews::record_use(state, user_id, NEGATIVE_BUCKET, n)
            .await
            .map(|_| ())
            .unwrap_or_else(|e| tracing::warn!("persona photos: record negative: {e}"));
    }

    let mut ids = Vec::new();
    for (i, prompt) in prompts.into_iter().enumerate() {
        let mut p = params.clone();
        p.seed = params.seed.map(|s| s.wrapping_add(i as i64));
        ids.push(create_and_kick(state, user_id, persona.id, &template, prompt, p).await?);
    }
    Ok(ids)
}

/// Persona tokens first, then custom/builtin placeholders and `{a|b}` choices, then
/// `{?}` — so a look text may itself contain placeholders.
pub fn expand_prompt(
    template: &str,
    persona: &Persona,
    expander: &mut PromptExpander,
) -> Result<String, AppError> {
    let rendered = personas::render_tokens(template, persona, false);
    let expanded = expander.expand(&rendered)?;
    let expanded = image_job_names::expand_prompt_placeholders(expanded.trim());
    let expanded = expanded.trim().to_string();
    if expanded.is_empty() {
        return Err(AppError::BadRequest(
            "prompt is empty after placeholder substitution".into(),
        ));
    }
    Ok(expanded)
}

async fn resolve_params(
    state: &AppState,
    persona: &Persona,
    req: &StartPhotoRequest,
) -> Result<Params, AppError> {
    let workflow = blank_to_none(req.workflow.clone()).unwrap_or_else(|| "txt2img".into());
    if !matches!(workflow.as_str(), "txt2img" | "img2img") {
        return Err(AppError::BadRequest(
            "workflow must be txt2img or img2img".into(),
        ));
    }
    let input = match blank_to_none(req.input_image_id.clone()) {
        Some(raw) => {
            let id = parse_id(&raw, "input_image_id")?;
            Some(
                image_generation::get_image_file(&state.db, id, persona.user_id)
                    .await?
                    .ok_or_else(|| AppError::BadRequest(format!("input image {id} not found")))?,
            )
        }
        None => None,
    };
    if workflow == "img2img" && input.is_none() {
        return Err(AppError::BadRequest("img2img needs input_image_id".into()));
    }
    if workflow == "txt2img" && input.is_some() {
        return Err(AppError::BadRequest(
            "input_image_id is only used with workflow=img2img".into(),
        ));
    }
    let (dw, dh) = input
        .as_ref()
        .map(|f| (f.stored_width, f.stored_height))
        .unwrap_or((DEFAULT_SIZE, DEFAULT_SIZE));
    let width = req.width.unwrap_or(dw);
    let height = req.height.unwrap_or(dh);
    for (name, v) in [("width", width), ("height", height)] {
        if !(MIN_SIZE..=MAX_SIZE).contains(&v) {
            return Err(AppError::BadRequest(format!(
                "{name} must be between {MIN_SIZE} and {MAX_SIZE}"
            )));
        }
    }

    // Per-request overrides ride on a copy of the persona's preferences.
    let mut prefs = persona.clone();
    if let Some(m) = blank_to_none(req.image_model.clone()) {
        let m = base_capability(&m).to_string();
        if workflow == "img2img" {
            prefs.img2img_capability = Some(m);
        } else {
            prefs.txt2img_capability = Some(m);
        }
    }
    if let Some(c) = blank_to_none(req.face_swap_capability.clone()) {
        prefs.face_swap_capability = Some(base_capability(&c).to_string());
    }
    if let Some(c) = blank_to_none(req.upscaler_capability.clone()) {
        prefs.upscaler_capability = Some(base_capability(&c).to_string());
    }

    let image_model = personas::resolve_imggen(state, &prefs, &workflow)
        .await?
        .ok_or_else(|| AppError::BadRequest(format!("no {workflow} image model is online")))?
        .capability;
    if !image_model.starts_with("imggen.") {
        return Err(AppError::BadRequest(
            "image_model must be an imggen.* capability".into(),
        ));
    }

    let faces = personas::resolve_faces(state, persona).await?;
    let face_swap_on = req.face_swap.unwrap_or(!faces.is_empty());
    let (face_image_id, face_swap) = if face_swap_on {
        if faces.is_empty() {
            return Err(AppError::BadRequest(
                "this persona has no face images; add one or pass face_swap=false".into(),
            ));
        }
        let face = match blank_to_none(req.face_image_id.clone()) {
            Some(raw) => faces
                .iter()
                .find(|f| f.id.to_string() == raw)
                .ok_or_else(|| {
                    AppError::BadRequest(format!("{raw} is not one of this persona's faces"))
                })?,
            None => &faces[0],
        };
        let tool = personas::resolve_img_tool(state, &prefs, "face_swap")
            .await?
            .ok_or_else(|| {
                AppError::BadRequest("no face swap tool is online; pass face_swap=false".into())
            })?;
        (
            Some(face.id.to_string()),
            Some(ToolChoice {
                capability: tool.capability,
                workflow: tool.workflow.unwrap_or_else(|| "face_swap".into()),
            }),
        )
    } else {
        (None, None)
    };

    let scale = req.scale.unwrap_or(DEFAULT_SCALE);
    if !scale.is_finite() || !(1.0..=8.0).contains(&scale) {
        return Err(AppError::BadRequest("scale must be between 1 and 8".into()));
    }
    let upscale = if req.upscale.unwrap_or(true) {
        let tool = personas::resolve_img_tool(state, &prefs, "upscale")
            .await?
            .ok_or_else(|| {
                AppError::BadRequest("no upscale tool is online; pass upscale=false".into())
            })?;
        Some(ToolChoice {
            capability: tool.capability,
            workflow: tool.workflow.unwrap_or_else(|| "upscale".into()),
        })
    } else {
        None
    };

    Ok(Params {
        workflow,
        image_model,
        input_image_id: input.map(|f| f.id.to_string()),
        negative_prompt: blank_to_none(req.negative_prompt.clone()),
        width,
        height,
        seed: req.seed,
        face_image_id,
        face_swap,
        upscale,
        scale,
    })
}

async fn create_and_kick(
    state: &AppState,
    user_id: i64,
    persona_id: i64,
    template: &str,
    prompt: String,
    params: Params,
) -> Result<i64, AppError> {
    let id = state.next_id();
    db::create(
        &state.db,
        NewJob {
            id,
            user_id,
            persona_id,
            prompt_template: template.to_string(),
            prompt,
            steps_json: encode(&plan_steps(&params))?,
            params_json: encode(&params)?,
        },
    )
    .await?;
    // Submit the first child now so a broken setup shows up immediately; the
    // worker picks it up otherwise.
    if let Err(e) = poll(state, user_id, id, false).await {
        tracing::warn!("persona photo {id}: first advance: {e}");
    }
    Ok(id)
}

// ── Views ───────────────────────────────────────────────────────────────────

pub async fn view(state: &AppState, job: Job, resolve_image: bool) -> Result<PhotoView, AppError> {
    let final_image = match (resolve_image, job.final_image_id) {
        (true, Some(id)) => image_generation::get_image_file(&state.db, id, job.user_id)
            .await?
            .map(|f| personas::ImageRef {
                image_id: f.id.to_string(),
                filename: f.filename,
                content_type: f.content_type,
                width: f.stored_width,
                height: f.stored_height,
            }),
        _ => None,
    };
    Ok(PhotoView {
        job_id: job.id.to_string(),
        persona_id: job.persona_id.to_string(),
        status: job.status,
        prompt_template: job.prompt_template,
        prompt: job.prompt,
        params: decode(&job.params_json)?,
        steps: decode(&job.steps_json)?,
        final_image_id: job.final_image_id.map(|i| i.to_string()),
        final_image,
        error: job.error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}

pub async fn get(state: &AppState, user: i64, id: i64) -> Result<PhotoView, AppError> {
    view(state, db::get(&state.db, id, user).await?, true).await
}

pub async fn list(
    state: &AppState,
    user: i64,
    persona_id: i64,
    limit: u64,
) -> Result<Vec<PhotoView>, AppError> {
    personas::get(state, user, persona_id).await?;
    let mut out = Vec::new();
    for job in db::list_for_persona(&state.db, user, persona_id, limit).await? {
        out.push(view(state, job, false).await?);
    }
    Ok(out)
}

// ── Driver ──────────────────────────────────────────────────────────────────

static ADVANCE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn save(state: &AppState, job: &mut Job, steps: &[Step]) -> Result<(), AppError> {
    db::save(&state.db, job, encode(&steps)?).await
}

/// Advances the chain as far as it can go right now. `foreground` callers (the
/// page, CLI, MCP) also poll the active child upstream instead of waiting for its
/// worker, so a watched photo finishes promptly.
pub async fn poll(
    state: &AppState,
    user: i64,
    id: i64,
    foreground: bool,
) -> Result<PhotoView, AppError> {
    db::get(&state.db, id, user).await?;
    let Ok(_slot) = ADVANCE_SLOTS.try_acquire() else {
        return get(state, user, id).await;
    };
    let Some(lock) = db::lock(&state.db, id).await? else {
        return get(state, user, id).await;
    };
    let mut job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        let p: Params = decode(&job.params_json)?;
        let mut steps: Vec<Step> = decode(&job.steps_json)?;
        if job.status == "cancelRequested" {
            cancel_steps(state, &mut job, &mut steps).await?;
        } else {
            drive(state, &mut job, &p, &mut steps, foreground).await?;
        }
        save(state, &mut job, &steps).await?;
    }
    lock.commit().await?;
    view(state, job, true).await
}

async fn drive(
    state: &AppState,
    job: &mut Job,
    p: &Params,
    steps: &mut [Step],
    foreground: bool,
) -> Result<(), AppError> {
    loop {
        let Some(i) = steps
            .iter()
            .position(|s| !matches!(s.status.as_str(), "completed" | "skipped"))
        else {
            job.status = "completed".into();
            job.final_image_id = steps
                .iter()
                .rev()
                .find_map(|s| s.output_image_id.as_deref())
                .and_then(|s| s.parse().ok());
            job.error = None;
            return Ok(());
        };
        let result = advance(state, job, p, steps, i, foreground).await;
        if let Err(e @ AppError::BadRequest(_)) = result {
            steps[i].status = "failed".into();
            steps[i].error = Some(e.to_string());
            job.status = "failed".into();
            job.error = steps[i].error.clone();
            return Ok(());
        }
        result?;
        match steps[i].status.as_str() {
            "completed" => continue,
            "failed" | "canceled" => {
                job.status = steps[i].status.clone();
                job.error = steps[i]
                    .error
                    .clone()
                    .or_else(|| Some(format!("{} step stopped", step_label(&steps[i].kind))));
                return Ok(());
            }
            _ => return Ok(()),
        }
    }
}

fn step_label(kind: &Kind) -> &'static str {
    match kind {
        Kind::Generate => "generate",
        Kind::FaceSwap => "face swap",
        Kind::Upscale => "upscale",
    }
}

async fn advance(
    state: &AppState,
    job: &mut Job,
    p: &Params,
    steps: &mut [Step],
    i: usize,
    foreground: bool,
) -> Result<(), AppError> {
    let fresh = steps[i].child_job_id.is_none();
    if fresh {
        steps[i].input_image_id =
            if i == 0 {
                p.input_image_id.clone()
            } else {
                Some(steps[i - 1].output_image_id.clone().ok_or_else(|| {
                    AppError::BadRequest("previous step produced no image".into())
                })?)
            };
        steps[i].child_job_id = Some(state.next_id().to_string());
        steps[i].status = "submitting".into();
        // Durable link BEFORE side effects, so a restart cannot submit twice.
        save(state, job, steps).await?;
    }
    let child = parse_id(
        steps[i].child_job_id.as_deref().unwrap_or(""),
        "child_job_id",
    )?;
    let exists = if fresh {
        false
    } else {
        if foreground && steps[i].status != "submitting" && !is_terminal(&steps[i].status) {
            poll_child(state, job.user_id, &steps[i].kind, child).await;
        }
        refresh_step(state, job.user_id, &mut steps[i], child).await?
    };
    if !exists {
        // A missing row is only legitimate mid-submission; a child deleted later
        // fails the chain instead of silently re-running it.
        if !fresh && steps[i].status != "submitting" {
            return Err(AppError::BadRequest(format!(
                "the {} job was deleted",
                step_label(&steps[i].kind)
            )));
        }
        if let Err(e) = submit(state, job, p, &steps[i], child).await {
            steps[i].status = "failed".into();
            steps[i].error = Some(format!("submission failed: {e}"));
            return Ok(());
        }
        refresh_step(state, job.user_id, &mut steps[i], child).await?;
    }
    Ok(())
}

async fn submit(
    state: &AppState,
    job: &Job,
    p: &Params,
    step: &Step,
    child: i64,
) -> Result<(), AppError> {
    match step.kind {
        Kind::Generate => {
            image_jobs::start_job_with_id(
                state,
                job.user_id,
                child,
                image_jobs::StartJobParams {
                    capability: step.capability.clone(),
                    prompt: job.prompt.clone(),
                    negative_prompt: p.negative_prompt.clone(),
                    override_negative: p.negative_prompt.is_some(),
                    width: p.width,
                    height: p.height,
                    seed: p.seed,
                    workflow: Some(p.workflow.clone()),
                    input_image_id: step.input_image_id.clone(),
                    data_preparation: None,
                    rescale: None,
                    video_length: None,
                    external_resize: false,
                    high_priority: false,
                    priority: Default::default(),
                    prompt_template: Some(job.prompt_template.clone()),
                },
                true,
            )
            .await?;
        }
        Kind::FaceSwap | Kind::Upscale => {
            let input = parse_id(
                step.input_image_id.as_deref().unwrap_or(""),
                "input_image_id",
            )?;
            let (source_image_id, options) = if step.kind == Kind::FaceSwap {
                let face = parse_id(p.face_image_id.as_deref().unwrap_or(""), "face_image_id")?;
                (Some(face), None)
            } else {
                let mut m = serde_json::Map::new();
                m.insert("scale_multiplier".into(), scale_value(p.scale));
                (None, Some(m))
            };
            img_utils::start_job_with_id(
                state,
                job.user_id,
                child,
                img_utils::StartJobParams {
                    priority: Default::default(),
                    capability: step.capability.clone(),
                    workflow: Some(step.workflow.clone()),
                    input_image_id: input,
                    source_image_id,
                    options,
                },
            )
            .await?;
        }
    }
    Ok(())
}

/// Whole multipliers go out as integers (`2`, not `2.0`), like the web UI.
fn scale_value(scale: f64) -> serde_json::Value {
    if scale.fract() == 0.0 {
        serde_json::json!(scale as i64)
    } else {
        serde_json::json!(scale)
    }
}

/// Foreground nudge: poll the child upstream (best-effort — its own worker
/// reconciles it anyway).
async fn poll_child(state: &AppState, user: i64, kind: &Kind, child: i64) {
    let result = match kind {
        Kind::Generate => image_jobs::poll_job(state, user, child).await.map(|_| ()),
        Kind::FaceSwap | Kind::Upscale => img_utils::poll_job(state, user, child).await.map(|_| ()),
    };
    if let Err(e) = result {
        tracing::debug!("persona photo: child {child} poll: {e}");
    }
}

/// Copies the child's persisted state into the step. `Ok(false)` = no child row.
async fn refresh_step(
    state: &AppState,
    user: i64,
    step: &mut Step,
    child: i64,
) -> Result<bool, AppError> {
    match step.kind {
        Kind::Generate => {
            let Some(job) = image_generation::get_job(&state.db, child, user).await? else {
                return Ok(false);
            };
            step.status = job.status;
            step.error = job.error;
            let task = image_generation::get_offload_task_by_job(&state.db, child).await?;
            step.stage = task.as_ref().and_then(|t| t.last_poll_stage.clone());
            if !is_terminal(&step.status) && task.is_none() {
                step.status = "failed".into();
                step.error = Some("submission was interrupted; retry this photo".into());
            }
            if step.status == "completed" {
                step.output_image_id = image_generation::list_job_files(&state.db, child)
                    .await?
                    .into_iter()
                    .find(|f| f.direction == "output" && f.content_type.starts_with("image/"))
                    .map(|f| f.id.to_string());
                if step.output_image_id.is_none() {
                    step.status = "failed".into();
                    step.error = Some("generation completed without an image".into());
                }
            }
        }
        Kind::FaceSwap | Kind::Upscale => {
            let job = match img_utils::get_user_job(state, user, child).await {
                Ok(job) => job,
                Err(AppError::NotFound) => return Ok(false),
                Err(e) => return Err(e),
            };
            step.status = job.status;
            step.stage = job.stage;
            step.error = job.error;
            if !is_terminal(&step.status) && job.offload_task_id.is_none() {
                step.status = "failed".into();
                step.error = Some("submission was interrupted; retry this photo".into());
            }
            if step.status == "completed" {
                step.output_image_id = job.output_image_id.map(|i| i.to_string());
                if step.output_image_id.is_none() {
                    step.status = "failed".into();
                    step.error = Some(format!(
                        "{} completed without an image",
                        step_label(&step.kind)
                    ));
                }
            }
        }
    }
    Ok(true)
}

async fn cancel_steps(state: &AppState, job: &mut Job, steps: &mut [Step]) -> Result<(), AppError> {
    let mut waiting = false;
    for step in steps
        .iter_mut()
        .filter(|s| !is_terminal(&s.status) && s.status != "skipped")
    {
        let Some(id) = step.child_job_id.clone() else {
            step.status = "canceled".into();
            continue;
        };
        let child = parse_id(&id, "child_job_id")?;
        if !refresh_step(state, job.user_id, step, child).await? {
            step.status = "canceled".into();
        } else if !is_terminal(&step.status) {
            step.status = match step.kind {
                Kind::Generate => {
                    image_jobs::cancel_job(state, job.user_id, child)
                        .await?
                        .status
                }
                Kind::FaceSwap | Kind::Upscale => {
                    img_utils::cancel_job(state, job.user_id, child)
                        .await?
                        .status
                }
            };
            waiting |= !is_terminal(&step.status);
        }
    }
    if !waiting {
        job.status = "canceled".into();
    }
    Ok(())
}

pub async fn cancel(state: &AppState, user: i64, id: i64) -> Result<PhotoView, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock_wait(&state.db, id).await?;
    let mut job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        job.status = "cancelRequested".into();
        let mut steps: Vec<Step> = decode(&job.steps_json)?;
        save(state, &mut job, &steps).await?;
        if let Err(e) = cancel_steps(state, &mut job, &mut steps).await {
            tracing::warn!("persona photo cancel {id}: {e}");
        }
        save(state, &mut job, &steps).await?;
    }
    lock.commit().await?;
    get(state, user, id).await
}

/// A fresh run of the same resolved chain and prompt.
pub async fn retry(state: &AppState, user: i64, id: i64) -> Result<i64, AppError> {
    let job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        return Err(AppError::BadRequest(
            "cancel the photo before retrying".into(),
        ));
    }
    let params: Params = decode(&job.params_json)?;
    create_and_kick(
        state,
        user,
        job.persona_id,
        &job.prompt_template,
        job.prompt,
        params,
    )
    .await
}

/// Deletes the photo run and its child jobs (and with them their images).
pub async fn delete(state: &AppState, user: i64, id: i64) -> Result<(), AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock_wait(&state.db, id).await?;
    let job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        return Err(AppError::BadRequest(
            "cancel the photo before deleting it".into(),
        ));
    }
    let steps: Vec<Step> = decode(&job.steps_json)?;
    for step in steps {
        let Some(child) = step.child_job_id else {
            continue;
        };
        let child = parse_id(&child, "child_job_id")?;
        let result = match step.kind {
            Kind::Generate => image_jobs::delete_job(state, user, child).await,
            Kind::FaceSwap | Kind::Upscale => img_utils::delete_job(state, user, child).await,
        };
        match result {
            Ok(()) | Err(AppError::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    db::delete(&state.db, id, user).await?;
    lock.commit().await?;
    Ok(())
}

/// Worker pass: advance in-flight runs from their children's persisted state.
pub async fn reconcile(state: &AppState, batch: u64) -> Result<(), AppError> {
    for job in db::inflight(&state.db, batch).await? {
        if let Err(e) = poll(state, job.user_id, job.id, false).await {
            tracing::warn!("persona photos worker {}: {e}", job.id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            workflow: "txt2img".into(),
            image_model: "imggen.flux".into(),
            input_image_id: None,
            negative_prompt: None,
            width: 1024,
            height: 1024,
            seed: None,
            face_image_id: Some("7".into()),
            face_swap: Some(ToolChoice {
                capability: "img-utils.reactor".into(),
                workflow: "face_swap".into(),
            }),
            upscale: Some(ToolChoice {
                capability: "img-utils.seedvr2".into(),
                workflow: "upscale".into(),
            }),
            scale: 2.0,
        }
    }

    #[test]
    fn default_chain_is_generate_faceswap_upscale() {
        let kinds: Vec<Kind> = plan_steps(&params()).into_iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec![Kind::Generate, Kind::FaceSwap, Kind::Upscale]);
    }

    #[test]
    fn optional_steps_drop_out() {
        let mut p = params();
        p.face_image_id = None;
        p.upscale = None;
        let steps = plan_steps(&p);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].capability, "imggen.flux");
        assert_eq!(steps[0].status, "pending");
    }

    #[test]
    fn scale_goes_out_as_int_when_whole() {
        assert_eq!(scale_value(2.0), serde_json::json!(2));
        assert_eq!(scale_value(1.5), serde_json::json!(1.5));
    }
}
