//! Img Model Wars: render one prompt with several `imggen.*` models side by side.
//!
//! A run is a thin parent over ordinary image-generation child jobs — one per
//! model, all txt2img with identical prompt, negative prompt, size and seed. The
//! children keep their whole lifecycle (offload task, buckets, polling by the
//! image pipeline worker and the SPA's progress loop, output storage) and show up
//! in Image Generation history like Image Cycles children do. The parent stores
//! only the shared request and the model → child-id mapping; its view and status
//! are derived from the children on every read, so there is no parent worker and
//! nothing to keep in sync.
//!
//! The frontend expands `{color}`/custom placeholders once and sends the same
//! text for every model. `{?}` is left to the image service, which expands it per
//! child job exactly as it does for any other image job.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    db::{image_generation, img_model_wars as db},
    error::{AppError, ResultExt},
    offload::{base_capability, task_status::is_terminal},
    services::image_jobs,
    state::AppState,
};

pub const MIN_MODELS: usize = 2;
pub const MAX_MODELS: usize = 8;
const MIN_EDGE: i32 = 128;
/// Generated outputs are stored up to `MAX_GENERATED_EDGE` (4096 px).
const MAX_EDGE: i32 = 4096;
const LIST_LIMIT: u64 = 100;
/// A run still `submitting` after this long was interrupted mid-creation.
const SUBMIT_GRACE_SECS: i64 = 300;

/// Shared request for every model in the run (also the API request body).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Params {
    pub models: Vec<String>,
    /// Prompt as sent to every model: frontend placeholders already expanded.
    pub prompt: String,
    /// Raw textarea text before expansion; keys saved-prompt previews.
    #[serde(default)]
    pub prompt_template: Option<String>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub override_negative: bool,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub seed: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Slot {
    model: String,
    child_job_id: i64,
    #[serde(default)]
    submit_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SlotView {
    pub model: String,
    pub child_job_id: String,
    pub status: String,
    pub stage: Option<String>,
    /// Prompt the child actually received (`{?}` expanded); null until created.
    pub prompt: Option<String>,
    pub error: Option<String>,
    pub output_image_id: Option<String>,
    pub output_width: Option<i32>,
    pub output_height: Option<i32>,
    pub submitted_at: Option<String>,
    pub started_at: Option<String>,
    pub typical_runtime_seconds: Option<f64>,
    /// Time spent executing on the agent, once finished.
    pub execution_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct View {
    pub job_id: String,
    pub status: String,
    pub params: Params,
    pub slots: Vec<SlotView>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn decode<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, AppError> {
    serde_json::from_str(json).map_err(|e| AppError::Internal(format!("img model war json: {e}")))
}

fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|e| AppError::Internal(format!("img model war json: {e}")))
}

/// Trims, strips `[attrs]` and validates the request. Returns normalized params.
fn normalize(mut p: Params) -> Result<Params, AppError> {
    p.prompt = p.prompt.trim().to_owned();
    if p.prompt.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    p.prompt_template = p
        .prompt_template
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    p.negative_prompt = p
        .negative_prompt
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    if !p.override_negative {
        p.negative_prompt = None;
    }
    for (name, edge) in [("width", p.width), ("height", p.height)] {
        if !(MIN_EDGE..=MAX_EDGE).contains(&edge) {
            return Err(AppError::BadRequest(format!(
                "{name} must be between {MIN_EDGE} and {MAX_EDGE}"
            )));
        }
    }
    let mut seen = HashSet::new();
    let mut models = Vec::with_capacity(p.models.len());
    for model in &p.models {
        let base = base_capability(model.trim()).to_owned();
        if !base.starts_with("imggen.") || base.len() == "imggen.".len() {
            return Err(AppError::BadRequest(format!(
                "{model:?} is not an imggen model"
            )));
        }
        if !seen.insert(base.clone()) {
            return Err(AppError::BadRequest(format!(
                "model {base} is listed twice"
            )));
        }
        models.push(base);
    }
    if !(MIN_MODELS..=MAX_MODELS).contains(&models.len()) {
        return Err(AppError::BadRequest(format!(
            "pick between {MIN_MODELS} and {MAX_MODELS} models"
        )));
    }
    p.models = models;
    Ok(p)
}

pub async fn start(state: &AppState, user: i64, params: Params) -> Result<i64, AppError> {
    let params = normalize(params)?;
    let id = state.next_id();
    let mut slots: Vec<Slot> = params
        .models
        .iter()
        .map(|model| Slot {
            model: model.clone(),
            child_job_id: state.next_id(),
            submit_error: None,
        })
        .collect();
    // Child IDs are durable before anything is submitted, so a crash mid-way
    // leaves a run whose missing children are reported, never orphaned silently.
    db::create(&state.db, id, user, encode(&params)?, encode(&slots)?).await?;

    let submissions = slots.iter().map(|slot| {
        image_jobs::start_job_with_id(
            state,
            user,
            slot.child_job_id,
            image_jobs::StartJobParams {
                capability: slot.model.clone(),
                prompt: params.prompt.clone(),
                negative_prompt: params.negative_prompt.clone(),
                override_negative: params.override_negative,
                width: params.width,
                height: params.height,
                seed: params.seed,
                workflow: Some("txt2img".into()),
                input_image_id: None,
                data_preparation: None,
                rescale: None,
                video_length: None,
                external_resize: false,
                prompt_template: params.prompt_template.clone(),
            },
            false,
        )
    });
    let results = futures::future::join_all(submissions).await;
    for (slot, result) in slots.iter_mut().zip(results) {
        if let Err(e) = result {
            let message = e.to_string();
            // A child row may exist without a task; don't leave it in-flight in
            // Image Generation history.
            image_generation::update_job_status(
                &state.db,
                slot.child_job_id,
                "failed",
                Some(&message),
            )
            .await
            .log_warn("mark failed img model war child");
            slot.submit_error = Some(message);
        }
    }
    db::update(&state.db, id, "submitted", encode(&slots)?).await?;
    Ok(id)
}

/// Child snapshot used to derive a slot; `None` fields mean "not created".
#[derive(Default)]
struct ChildSnapshot {
    status: String,
    error: Option<String>,
    prompt: String,
    has_task: bool,
    stage: Option<String>,
    output: Option<image_generation::ImageFile>,
    submitted_at: Option<DateTime<FixedOffset>>,
    started_at: Option<DateTime<FixedOffset>>,
    finished_at: Option<DateTime<FixedOffset>>,
    typical_runtime_seconds: Option<f64>,
}

/// Whether children of this run may legitimately still be getting created.
fn still_submitting(job: &db::Job, now: DateTime<Utc>) -> bool {
    job.status == "submitting"
        && (now - job.created_at.with_timezone(&Utc)).num_seconds() < SUBMIT_GRACE_SECS
}

fn slot_view(slot: &Slot, child: Option<&ChildSnapshot>, submitting: bool) -> SlotView {
    let mut view = SlotView {
        model: slot.model.clone(),
        child_job_id: slot.child_job_id.to_string(),
        status: "failed".into(),
        stage: None,
        prompt: None,
        error: None,
        output_image_id: None,
        output_width: None,
        output_height: None,
        submitted_at: None,
        started_at: None,
        typical_runtime_seconds: None,
        execution_seconds: None,
    };
    if let Some(child) = child {
        view.status = child.status.clone();
        view.error = child.error.clone();
        view.prompt = Some(child.prompt.clone());
        view.stage = child.stage.clone();
        view.submitted_at = child.submitted_at.map(|t| t.to_rfc3339());
        view.started_at = child.started_at.map(|t| t.to_rfc3339());
        view.typical_runtime_seconds = child.typical_runtime_seconds;
        if let (Some(start), Some(end)) = (child.started_at, child.finished_at) {
            view.execution_seconds = Some((end - start).num_milliseconds().max(0) as f64 / 1000.0);
        }
        if let Some(file) = &child.output {
            view.output_image_id = Some(file.id.to_string());
            view.output_width = Some(file.stored_width);
            view.output_height = Some(file.stored_height);
        }
        if !is_terminal(&view.status) && !child.has_task && !submitting {
            view.status = "failed".into();
            view.error = Some("submission was interrupted; run again".into());
        }
    } else if submitting && slot.submit_error.is_none() {
        view.status = "submitting".into();
    } else {
        view.error = Some(
            slot.submit_error
                .clone()
                .unwrap_or_else(|| "image job was deleted or never created".into()),
        );
    }
    if let Some(error) = &slot.submit_error {
        view.status = "failed".into();
        view.error = Some(error.clone());
    }
    view
}

/// Run status from its slots: in flight until every slot is terminal, then
/// `completed` if any model produced an image.
fn run_status(slots: &[SlotView], submitting: bool) -> (String, Option<String>) {
    if slots.iter().any(|s| !is_terminal(&s.status)) {
        return (
            if submitting { "submitting" } else { "running" }.into(),
            None,
        );
    }
    if slots.iter().any(|s| s.status == "completed") {
        return ("completed".into(), None);
    }
    if !slots.is_empty() && slots.iter().all(|s| s.status == "canceled") {
        return ("canceled".into(), None);
    }
    let error = slots
        .iter()
        .find_map(|s| s.error.clone())
        .unwrap_or_else(|| "every model failed".into());
    ("failed".into(), Some(error))
}

/// Builds views for many runs with one query per child table.
async fn views(state: &AppState, user: i64, jobs: Vec<db::Job>) -> Result<Vec<View>, AppError> {
    let mut decoded = Vec::with_capacity(jobs.len());
    for job in jobs {
        let params: Params = decode(&job.params_json)?;
        let slots: Vec<Slot> = decode(&job.slots_json)?;
        decoded.push((job, params, slots));
    }
    let child_ids: Vec<i64> = decoded
        .iter()
        .flat_map(|(_, _, slots)| slots.iter().map(|s| s.child_job_id))
        .collect();
    let children = image_generation::jobs_by_ids(&state.db, user, child_ids).await?;
    let existing: Vec<i64> = children.keys().copied().collect();
    let mut tasks: HashMap<i64, image_generation::ImageOffloadTask> =
        image_generation::list_offload_tasks_for_jobs(&state.db, &existing)
            .await?
            .into_iter()
            .map(|t| (t.job_id, t))
            .collect();
    let mut outputs: HashMap<i64, image_generation::ImageFile> = HashMap::new();
    for file in image_generation::list_job_files_for_jobs(&state.db, &existing).await? {
        if file.direction == "output"
            && file.content_type.starts_with("image/")
            && let Some(job_id) = file.job_id
        {
            outputs.entry(job_id).or_insert(file);
        }
    }
    let mut snapshots: HashMap<i64, ChildSnapshot> = HashMap::new();
    for (id, child) in children {
        let task = tasks.remove(&id);
        snapshots.insert(
            id,
            ChildSnapshot {
                status: child.status,
                error: child.error,
                prompt: child.prompt,
                has_task: task.is_some(),
                stage: task.as_ref().and_then(|t| t.last_poll_stage.clone()),
                submitted_at: task.as_ref().map(|t| t.submitted_at),
                started_at: task.as_ref().and_then(|t| t.started_at),
                finished_at: task.as_ref().and_then(|t| t.finished_at),
                typical_runtime_seconds: task.as_ref().and_then(|t| t.typical_runtime_seconds),
                output: outputs.remove(&id),
            },
        );
    }

    let now = Utc::now();
    Ok(decoded
        .into_iter()
        .map(|(job, params, slots)| {
            let submitting = still_submitting(&job, now);
            let slots: Vec<SlotView> = slots
                .iter()
                .map(|slot| slot_view(slot, snapshots.get(&slot.child_job_id), submitting))
                .collect();
            let (status, error) = run_status(&slots, submitting);
            View {
                job_id: job.id.to_string(),
                status,
                params,
                slots,
                error,
                created_at: job.created_at.to_rfc3339(),
                updated_at: job.updated_at.to_rfc3339(),
            }
        })
        .collect())
}

pub async fn get(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    let job = db::get(&state.db, id, user).await?;
    views(state, user, vec![job])
        .await?
        .pop()
        .ok_or(AppError::NotFound)
}

pub async fn list(state: &AppState, user: i64) -> Result<Vec<View>, AppError> {
    let jobs = db::list(&state.db, user, LIST_LIMIT).await?;
    views(state, user, jobs).await
}

/// Cancels every in-flight model. Tries them all; reports the first failure.
pub async fn cancel(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    let view = get(state, user, id).await?;
    if is_terminal(&view.status) {
        return Err(AppError::BadRequest(format!(
            "run is already {}",
            view.status
        )));
    }
    let mut first_error = None;
    for slot in view.slots.iter().filter(|s| !is_terminal(&s.status)) {
        let Ok(child) = slot.child_job_id.parse::<i64>() else {
            continue;
        };
        match image_jobs::cancel_job(state, user, child).await {
            // Gone or finished in the meantime — nothing left to cancel.
            Ok(_) | Err(AppError::NotFound) => {}
            Err(AppError::BadRequest(m)) if m.contains("terminal state") => {}
            Err(e) => {
                tracing::warn!(run = id, child, error = ?e, "cancel img model war child");
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => get(state, user, id).await,
    }
}

/// New run with the same prompt, settings and models (terminal runs only).
pub async fn retry(state: &AppState, user: i64, id: i64) -> Result<i64, AppError> {
    let view = get(state, user, id).await?;
    if !is_terminal(&view.status) {
        return Err(AppError::BadRequest("run is still in progress".into()));
    }
    start(state, user, view.params).await
}

/// Deletes a finished run together with its child jobs and generated images.
pub async fn delete(state: &AppState, user: i64, id: i64) -> Result<(), AppError> {
    let job = db::get(&state.db, id, user).await?;
    let view = views(state, user, vec![job.clone()])
        .await?
        .pop()
        .ok_or(AppError::NotFound)?;
    if !is_terminal(&view.status) {
        return Err(AppError::BadRequest(
            "stop the run before deleting it".into(),
        ));
    }
    let slots: Vec<Slot> = decode(&job.slots_json)?;
    for slot in slots {
        match image_jobs::delete_job(state, user, slot.child_job_id).await {
            Ok(()) | Err(AppError::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    db::delete(&state.db, id, user).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(models: &[&str]) -> Params {
        Params {
            models: models.iter().map(|m| m.to_string()).collect(),
            prompt: "  a {?} cat ".into(),
            prompt_template: Some(" ".into()),
            negative_prompt: Some("blurry".into()),
            override_negative: false,
            width: 1024,
            height: 768,
            seed: Some(7),
        }
    }

    fn slot(error: Option<&str>) -> Slot {
        Slot {
            model: "imggen.flux".into(),
            child_job_id: 42,
            submit_error: error.map(Into::into),
        }
    }

    fn child(status: &str, has_task: bool) -> ChildSnapshot {
        ChildSnapshot {
            status: status.into(),
            prompt: "a cat".into(),
            has_task,
            ..Default::default()
        }
    }

    fn view_with(status: &str, error: Option<&str>) -> SlotView {
        let mut v = slot_view(&slot(None), Some(&child(status, true)), false);
        v.error = error.map(Into::into);
        v
    }

    #[test]
    fn normalize_strips_attrs_and_keeps_placeholders() {
        let p = normalize(params(&["imggen.flux[txt2img;img2img]", " imggen.sdxl "])).unwrap();
        assert_eq!(p.models, ["imggen.flux", "imggen.sdxl"]);
        assert_eq!(
            p.prompt, "a {?} cat",
            "{{?}} is expanded per child, not here"
        );
        assert_eq!(p.prompt_template, None);
        assert_eq!(
            p.negative_prompt, None,
            "negative only sent when overridden"
        );
    }

    #[test]
    fn normalize_rejects_bad_requests() {
        for models in [
            &["imggen.flux"][..],
            &["imggen.a", "imggen.a[x]"],
            &["imggen.a", "llm.b"],
            &["imggen.a", "imggen."],
        ] {
            assert!(
                matches!(normalize(params(models)), Err(AppError::BadRequest(_))),
                "{models:?}"
            );
        }
        let too_many: Vec<String> = (0..=MAX_MODELS).map(|i| format!("imggen.m{i}")).collect();
        let refs: Vec<&str> = too_many.iter().map(String::as_str).collect();
        assert!(normalize(params(&refs)).is_err());
        let mut p = params(&["imggen.a", "imggen.b"]);
        p.width = 64;
        assert!(normalize(p).is_err());
        let mut p = params(&["imggen.a", "imggen.b"]);
        p.prompt = "  ".into();
        assert!(normalize(p).is_err());
    }

    #[test]
    fn slot_view_covers_missing_and_interrupted_children() {
        assert_eq!(slot_view(&slot(None), None, true).status, "submitting");
        let gone = slot_view(&slot(None), None, false);
        assert_eq!(gone.status, "failed");
        assert!(gone.error.unwrap().contains("deleted"));
        let failed = slot_view(
            &slot(Some("no bucket")),
            Some(&child("created", false)),
            false,
        );
        assert_eq!(
            (failed.status.as_str(), failed.error.as_deref()),
            ("failed", Some("no bucket"))
        );
        assert_eq!(
            slot_view(&slot(None), Some(&child("created", false)), true).status,
            "created"
        );
        let interrupted = slot_view(&slot(None), Some(&child("created", false)), false);
        assert_eq!(interrupted.status, "failed");
        assert_eq!(
            slot_view(&slot(None), Some(&child("running", true)), false).status,
            "running"
        );
    }

    #[test]
    fn slot_view_reports_execution_time() {
        let start = DateTime::parse_from_rfc3339("2026-11-06T10:00:00Z").unwrap();
        let mut c = child("completed", true);
        c.started_at = Some(start);
        c.finished_at = Some(start + chrono::Duration::milliseconds(12_500));
        assert_eq!(
            slot_view(&slot(None), Some(&c), false).execution_seconds,
            Some(12.5)
        );
    }

    #[test]
    fn run_status_waits_for_every_model() {
        let running = [view_with("completed", None), view_with("running", None)];
        assert_eq!(run_status(&running, false).0, "running");
        assert_eq!(run_status(&running, true).0, "submitting");
        let mixed = [
            view_with("completed", None),
            view_with("failed", Some("oom")),
        ];
        assert_eq!(run_status(&mixed, false), ("completed".into(), None));
        let canceled = [view_with("canceled", None), view_with("canceled", None)];
        assert_eq!(run_status(&canceled, false).0, "canceled");
        let failed = [
            view_with("canceled", None),
            view_with("failed", Some("oom")),
        ];
        assert_eq!(
            run_status(&failed, false),
            ("failed".into(), Some("oom".into()))
        );
    }
}
