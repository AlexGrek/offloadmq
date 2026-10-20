//! Describe → txt2img chains built from the existing persistent child jobs.
//! This is a multi-job state machine, rather than a single offload-job driver.
use crate::{
    db::{image_cycles as db, image_generation},
    error::AppError,
    offload::{base_capability, task_status::is_terminal},
    services::{image_analysis, image_jobs, prompt_usage, storage},
    state::AppState,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Params {
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub expected_quality: Option<u32>,
    #[serde(default)]
    pub max_steps: Option<u32>,
    #[serde(default)]
    pub bootstrap_model: Option<String>,
    pub input_image_id: Option<String>,
    pub describe_prompt: String,
    pub vision_model: String,
    pub image_model: String,
    #[serde(default)]
    pub cycles: u32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Describe,
    Generate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Step {
    /// Zero denotes the optional text-to-image bootstrap, not a cycle.
    pub cycle: u32,
    pub kind: Kind,
    pub status: String,
    pub prompt: String,
    pub input_image_id: Option<String>,
    pub output_image_id: Option<String>,
    pub result: Option<String>,
    pub child_job_id: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
    #[serde(default)]
    pub improve_prompt: Option<String>,
}

#[derive(Serialize)]
pub struct View {
    pub job_id: String,
    pub app: String,
    pub stop_reason: Option<String>,
    pub status: String,
    pub params: Params,
    pub steps: Vec<Step>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, AppError> {
    serde_json::from_str(json).map_err(|e| AppError::Internal(format!("image cycle data: {e}")))
}
fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|e| AppError::Internal(format!("image cycle data: {e}")))
}
pub fn view(job: db::Job) -> Result<View, AppError> {
    Ok(View {
        job_id: job.id.to_string(),
        app: job.app,
        stop_reason: stop_reason(
            &job.status,
            &decode::<Params>(&job.params_json)?,
            &decode::<Vec<Step>>(&job.steps_json)?,
        ),
        status: job.status,
        params: decode(&job.params_json)?,
        steps: decode(&job.steps_json)?,
        error: job.error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}

fn validate(p: &mut Params) -> Result<(), AppError> {
    p.initial_prompt = p
        .initial_prompt
        .take()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    p.input_image_id = p
        .input_image_id
        .take()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    p.describe_prompt = p.describe_prompt.trim().to_owned();
    p.vision_model = base_capability(p.vision_model.trim()).to_owned();
    p.image_model = base_capability(p.image_model.trim()).to_owned();
    if p.initial_prompt.is_some() == p.input_image_id.is_some() {
        return Err(AppError::BadRequest(
            "provide either an input image or a text prompt".into(),
        ));
    }
    if p.describe_prompt.is_empty() {
        return Err(AppError::BadRequest("describe prompt is required".into()));
    }
    if !(1..=50).contains(&p.cycles) {
        return Err(AppError::BadRequest(
            "cycles must be between 1 and 50".into(),
        ));
    }
    if !(128..=2048).contains(&p.width) || !(128..=2048).contains(&p.height) {
        return Err(AppError::BadRequest(
            "image dimensions must be between 128 and 2048".into(),
        ));
    }
    if !p.vision_model.starts_with("llm.") || !p.image_model.starts_with("imggen.") {
        return Err(AppError::BadRequest(
            "choose a vision model and an image generation model".into(),
        ));
    }
    Ok(())
}

fn new_step(cycle: u32, kind: Kind, prompt: String) -> Step {
    Step {
        cycle,
        kind,
        status: "queued".into(),
        prompt,
        input_image_id: None,
        output_image_id: None,
        result: None,
        child_job_id: None,
        stage: None,
        error: None,
        quality: None,
        improve_prompt: None,
    }
}
fn plan(p: &Params) -> Vec<Step> {
    let mut steps = Vec::new();
    if let Some(prompt) = &p.initial_prompt {
        steps.push(new_step(0, Kind::Generate, prompt.clone()));
    }
    for cycle in 1..=p.cycles {
        steps.push(new_step(cycle, Kind::Describe, p.describe_prompt.clone()));
        steps.push(new_step(cycle, Kind::Generate, String::new()));
    }
    if p.expected_quality.is_some() {
        steps.push(new_step(p.cycles + 1, Kind::Describe, assessment_prompt(p)));
        for step in &mut steps {
            if step.kind == Kind::Describe {
                step.prompt = assessment_prompt(p);
            }
        }
    }
    steps
}

/// Strict structured output plus explicit instructions: model output is validated
/// again before it can control a generation or terminate the run.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assessment {
    quality: u32,
    improve_prompt: String,
}
fn parse_assessment(text: &str) -> Result<Assessment, AppError> {
    let a: Assessment = serde_json::from_str(text).map_err(|e| {
        AppError::BadRequest(format!(
            "vision must return JSON with quality (0–100) and improve_prompt: {e}"
        ))
    })?;
    if a.quality > 100 {
        return Err(AppError::BadRequest(
            "vision quality must be between 0 and 100".into(),
        ));
    }
    Ok(a)
}
fn assessment_schema() -> serde_json::Value {
    serde_json::json!({"type":"object", "properties": {
        "quality":{"type":"integer","minimum":0,"maximum":100},
        "improve_prompt":{"type":"string"}}, "required":["quality","improve_prompt"], "additionalProperties":false})
}
fn assessment_prompt(p: &Params) -> String {
    format!(
        "{}{}\n\nEvaluate the current image. Return only a JSON object with exactly two keys: quality (an integer from 0 to 100, e.g. 95, never 95/100) and improve_prompt (a concrete img2img instruction to improve this image while preserving its identity and composition). Be critical about defects and artifacts. No Markdown or other text.",
        p.describe_prompt,
        p.initial_prompt
            .as_deref()
            .map(|p| format!("\nDesired image: {p}"))
            .unwrap_or_default()
    )
}
fn stop_reason(status: &str, p: &Params, steps: &[Step]) -> Option<String> {
    if status != "completed" {
        return None;
    }
    p.expected_quality.map(|target| {
        if steps
            .iter()
            .filter_map(|s| s.quality)
            .last()
            .is_some_and(|q| q >= target)
        {
            "target_reached".into()
        } else {
            "max_steps_reached".into()
        }
    })
}

pub async fn start_for_app(
    state: &AppState,
    user: i64,
    mut p: Params,
    app: &str,
) -> Result<i64, AppError> {
    if app == "generator-improver" {
        let target = p
            .expected_quality
            .ok_or_else(|| AppError::BadRequest("expected_quality is required".into()))?;
        if !(1..=100).contains(&target) {
            return Err(AppError::BadRequest(
                "expected_quality must be between 1 and 100".into(),
            ));
        }
        p.cycles = p
            .max_steps
            .ok_or_else(|| AppError::BadRequest("max_steps is required".into()))?;
        if !(1..=50).contains(&p.cycles) {
            return Err(AppError::BadRequest(
                "max_steps must be between 1 and 50".into(),
            ));
        }
    } else {
        p.expected_quality = None;
        p.max_steps = None;
        p.bootstrap_model = None;
    }
    validate(&mut p)?;
    storage::operator(state)?;
    if let Some(id) = &p.input_image_id {
        let id = crate::routes::job_common::parse_id(id, "input_image_id")?;
        let input = image_generation::get_image_file(&state.db, id, user)
            .await?
            .ok_or(AppError::NotFound)?;
        if !input.content_type.starts_with("image/") {
            return Err(AppError::BadRequest("input must be an image".into()));
        }
    }
    let (vision, images) = tokio::try_join!(
        image_analysis::list_vision_capabilities(state, user),
        image_jobs::list_imggen_capabilities(state, user)
    )?;
    if !vision.iter().any(|c| c.base == p.vision_model) {
        return Err(AppError::BadRequest("choose a listed vision model".into()));
    }
    let workflow = if p.expected_quality.is_some() {
        "img2img"
    } else {
        "txt2img"
    };
    let listed = |model: &str, workflow: &str| {
        images
            .iter()
            .any(|c| c.base == model && (c.tags.is_empty() || c.tags.iter().any(|t| t == workflow)))
    };
    if !listed(&p.image_model, workflow) {
        return Err(AppError::BadRequest(format!(
            "choose a listed {workflow} model"
        )));
    }
    if p.expected_quality.is_some() && p.initial_prompt.is_some() {
        let bootstrap = p
            .bootstrap_model
            .as_deref()
            .map(base_capability)
            .filter(|m| listed(m, "txt2img"))
            .ok_or_else(|| {
                AppError::BadRequest("text starts require a listed txt2img bootstrap_model".into())
            })?;
        p.bootstrap_model = Some(bootstrap.to_owned());
    }
    let id = state.next_id();
    db::create(&state.db, id, user, app, encode(&p)?, encode(&plan(&p))?).await?;
    prompt_usage::note_use(state, user, "describe-image-user", &p.describe_prompt).await;
    if let Some(prompt) = &p.initial_prompt {
        prompt_usage::note_use(state, user, "imggen-prompt", prompt).await;
    }
    Ok(id)
}

pub async fn get(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    view(db::get(&state.db, id, user).await?)
}
pub async fn list(state: &AppState, user: i64, app: &str) -> Result<Vec<View>, AppError> {
    db::list(&state.db, user, app)
        .await?
        .into_iter()
        .map(view)
        .collect()
}

async fn save(state: &AppState, job: &mut db::Job, steps: &[Step]) -> Result<(), AppError> {
    db::save(&state.db, job, encode(&steps)?).await
}

/// Prepare inputs only from a completed predecessor. In particular generation
/// consumes the vision model's actual result, never the describe instruction.
fn prepare(p: &Params, steps: &mut [Step], i: usize) -> Result<(), AppError> {
    match steps[i].kind {
        Kind::Describe => {
            steps[i].input_image_id = if i == 0 {
                p.input_image_id.clone()
            } else {
                steps[i - 1].output_image_id.clone()
            };
            if steps[i].input_image_id.is_none() {
                return Err(AppError::BadRequest("previous step has no image".into()));
            }
        }
        Kind::Generate if steps[i].cycle > 0 => {
            steps[i].prompt = if p.expected_quality.is_some() {
                steps[i].input_image_id = steps[i - 1].input_image_id.clone();
                steps[i - 1].improve_prompt.clone()
            } else {
                steps[i - 1].result.clone()
            }
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::BadRequest(
                    "vision returned an empty improvement prompt or description".into(),
                )
            })?;
        }
        _ => {}
    }
    Ok(())
}

async fn submit(
    state: &AppState,
    user: i64,
    p: &Params,
    step: &Step,
    child: i64,
) -> Result<(), AppError> {
    match step.kind {
        Kind::Describe => {
            image_analysis::start_job_with_id(
                state,
                user,
                child,
                image_analysis::StartJobParams {
                    capability: p.vision_model.clone(),
                    prompt: step.prompt.clone(),
                    response_format: p.expected_quality.map(|_| assessment_schema()),
                    image_id: crate::routes::job_common::parse_id(
                        step.input_image_id.as_deref().unwrap_or(""),
                        "input_image_id",
                    )?,
                    data_preparation: Some(std::collections::HashMap::from([(
                        "*".into(),
                        "scale/max[px=1024]".into(),
                    )])),
                    external_resize: false,
                },
            )
            .await?;
        }
        Kind::Generate => {
            image_jobs::start_job_with_id(
                state,
                user,
                child,
                image_jobs::StartJobParams {
                    capability: if p.expected_quality.is_some() && step.cycle == 0 {
                        p.bootstrap_model
                            .clone()
                            .ok_or_else(|| AppError::Internal("missing bootstrap model".into()))?
                    } else {
                        p.image_model.clone()
                    },
                    prompt: step.prompt.clone(),
                    negative_prompt: None,
                    override_negative: false,
                    width: p.width,
                    height: p.height,
                    seed: None,
                    workflow: Some(
                        if p.expected_quality.is_some() && step.cycle > 0 {
                            "img2img"
                        } else {
                            "txt2img"
                        }
                        .into(),
                    ),
                    input_image_id: step.input_image_id.clone(),
                    data_preparation: None,
                    rescale: None,
                    video_length: None,
                    external_resize: false,
                    prompt_template: None,
                },
                true,
            )
            .await?;
        }
    }
    Ok(())
}

/// Existing workers own polling the children. Reading their persisted snapshots
/// avoids a second concurrent downloader/vision reconciler for the same child.
async fn refresh_step(
    state: &AppState,
    user: i64,
    step: &mut Step,
    child: i64,
) -> Result<bool, AppError> {
    match step.kind {
        Kind::Describe => {
            let job = match image_analysis::user_job_detail(state, child, user).await {
                Ok(detail) => detail.job,
                Err(AppError::NotFound) => return Ok(false),
                Err(e) => return Err(e),
            };
            step.status = job.status;
            step.result = job.result;
            step.stage = job.stage;
            step.error = job.error;
            if !is_terminal(&step.status) && job.offload_task_id.is_none() {
                step.status = "failed".into();
                step.error = Some("submission was interrupted; retry this run".into());
            }
        }
        Kind::Generate => {
            let job = match image_generation::get_job(&state.db, child, user).await? {
                Some(job) => job,
                None => return Ok(false),
            };
            step.status = job.status;
            step.prompt = job.prompt;
            step.error = job.error;
            let task = image_generation::get_offload_task_by_job(&state.db, child).await?;
            step.stage = task.as_ref().and_then(|t| t.last_poll_stage.clone());
            if !is_terminal(&step.status) && task.is_none() {
                step.status = "failed".into();
                step.error = Some("submission was interrupted; retry this run".into());
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
    }
    Ok(true)
}

static ADVANCE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

pub async fn poll(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    // Check ownership before locking, so foreign IDs cannot contend with a run.
    db::get(&state.db, id, user).await?;
    let Ok(_slot) = ADVANCE_SLOTS.try_acquire() else {
        return get(state, user, id).await;
    };
    let Some(lock) = db::lock(&state.db, id, false).await? else {
        return get(state, user, id).await;
    };
    let mut job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        let p: Params = decode(&job.params_json)?;
        let mut steps: Vec<Step> = decode(&job.steps_json)?;
        if job.status == "cancelRequested" {
            cancel_steps(state, &mut job, &mut steps).await?;
        } else if let Some(i) = steps.iter().position(|s| s.status != "completed") {
            let result = advance(state, &mut job, &p, &mut steps, i).await;
            if let Err(e @ AppError::BadRequest(_)) = result {
                steps[i].status = "failed".into();
                steps[i].error = Some(e.to_string());
                job.status = "failed".into();
                job.error = steps[i].error.clone();
            } else {
                result?;
            }
        } else {
            job.status = "completed".into();
        }
        save(state, &mut job, &steps).await?;
    }
    lock.commit().await?;
    view(job)
}

async fn advance(
    state: &AppState,
    job: &mut db::Job,
    p: &Params,
    steps: &mut [Step],
    i: usize,
) -> Result<(), AppError> {
    let fresh = steps[i].child_job_id.is_none();
    if fresh {
        prepare(p, steps, i)?;
        steps[i].child_job_id = Some(state.next_id().to_string());
        steps[i].status = "submitting".into();
        // Durable link BEFORE side effects, so a restart cannot submit a second
        // task for this step. The same reserved ID is used if no row exists yet.
        save(state, job, steps).await?;
    }
    let child = crate::routes::job_common::parse_id(
        steps[i].child_job_id.as_deref().unwrap_or(""),
        "child_job_id",
    )?;
    let exists = if fresh {
        false
    } else {
        refresh_step(state, job.user_id, &mut steps[i], child).await?
    };
    if !exists {
        // A missing row is safe to create only during submission; deletion of
        // an already-submitted child must fail the chain instead of restarting it.
        if !fresh && steps[i].status != "submitting" {
            return Err(AppError::BadRequest("a child job was deleted".into()));
        }
        if let Err(e) = submit(state, job.user_id, p, &steps[i], child).await {
            steps[i].status = "failed".into();
            steps[i].error = Some(format!("submission failed: {e}"));
            job.status = "failed".into();
            job.error = steps[i].error.clone();
            return Ok(());
        }
        refresh_step(state, job.user_id, &mut steps[i], child).await?;
    }
    if steps[i].status == "completed"
        && steps[i].kind == Kind::Describe
        && p.expected_quality.is_some()
    {
        let a = parse_assessment(steps[i].result.as_deref().unwrap_or(""))?;
        steps[i].quality = Some(a.quality);
        steps[i].improve_prompt = Some(a.improve_prompt);
        if a.quality >= p.expected_quality.unwrap_or(100) || i + 1 == steps.len() {
            for unused in &mut steps[i + 1..] {
                unused.status = "skipped".into();
            }
            job.status = "completed".into();
            return Ok(());
        }
        if steps[i]
            .improve_prompt
            .as_deref()
            .is_none_or(|p| p.trim().is_empty())
        {
            return Err(AppError::BadRequest(
                "vision returned empty improve_prompt below the target quality".into(),
            ));
        }
    }
    match steps[i].status.as_str() {
        "failed" | "canceled" => {
            job.status = steps[i].status.clone();
            job.error = steps[i]
                .error
                .clone()
                .or_else(|| Some("cycle stopped by a child job".into()));
        }
        "completed" if i + 1 == steps.len() => job.status = "completed".into(),
        _ => {}
    }
    Ok(())
}

async fn cancel_steps(
    state: &AppState,
    job: &mut db::Job,
    steps: &mut [Step],
) -> Result<(), AppError> {
    let mut waiting = false;
    for step in steps.iter_mut().filter(|s| !is_terminal(&s.status)) {
        if let Some(id) = &step.child_job_id {
            let child = crate::routes::job_common::parse_id(id, "child_job_id")?;
            let exists = refresh_step(state, job.user_id, step, child).await?;
            if !exists {
                step.status = "canceled".into();
            } else if !is_terminal(&step.status) {
                step.status = match step.kind {
                    Kind::Describe => {
                        image_analysis::cancel_job(state, job.user_id, child)
                            .await?
                            .status
                    }
                    Kind::Generate => {
                        image_jobs::cancel_job(state, job.user_id, child)
                            .await?
                            .status
                    }
                };
                waiting |= !is_terminal(&step.status);
            }
        } else {
            step.status = "canceled".into();
        }
    }
    if !waiting {
        job.status = "canceled".into();
    }
    save(state, job, steps).await
}

pub async fn cancel(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        job.status = "cancelRequested".into();
        let mut steps: Vec<Step> = decode(&job.steps_json)?;
        // Even if upstream cancellation is temporarily unavailable, the worker
        // retries it and can never start another cycle.
        save(state, &mut job, &steps).await?;
        if let Err(e) = cancel_steps(state, &mut job, &mut steps).await {
            tracing::warn!("image cycles cancel {id}: {e}");
        }
    }
    lock.commit().await?;
    get(state, user, id).await
}

pub async fn retry(state: &AppState, user: i64, id: i64) -> Result<i64, AppError> {
    let job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        return Err(AppError::BadRequest("stop the run before retrying".into()));
    }
    start_for_app(state, user, decode(&job.params_json)?, &job.app).await
}

pub async fn delete(state: &AppState, user: i64, id: i64) -> Result<(), AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let job = db::get(&state.db, id, user).await?;
    if !is_terminal(&job.status) {
        return Err(AppError::BadRequest("stop the run before deleting".into()));
    }
    let steps: Vec<Step> = decode(&job.steps_json)?;
    for step in steps {
        if let Some(child) = step.child_job_id {
            let child = crate::routes::job_common::parse_id(&child, "child_job_id")?;
            let result = match step.kind {
                Kind::Describe => image_analysis::delete_job(state, user, child).await,
                Kind::Generate => image_jobs::delete_job(state, user, child).await,
            };
            match result {
                Ok(()) | Err(AppError::NotFound) => {}
                Err(e) => return Err(e),
            }
        }
    }
    db::delete(&state.db, id, user).await?;
    lock.commit().await?;
    Ok(())
}

pub async fn reconcile(state: &AppState, batch: u64) -> Result<(), AppError> {
    for job in db::inflight(&state.db, batch).await? {
        if let Err(e) = poll(state, job.user_id, job.id).await {
            tracing::warn!("image cycles worker {}: {e}", job.id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Params {
        Params {
            expected_quality: None,
            max_steps: None,
            bootstrap_model: None,
            initial_prompt: None,
            input_image_id: Some("42".into()),
            describe_prompt: "Describe".into(),
            vision_model: "llm.vision[vision]".into(),
            image_model: "imggen.paint[txt2img]".into(),
            cycles: 2,
            width: 1024,
            height: 1024,
        }
    }
    #[test]
    fn image_runs_exactly_n_cycles_and_chains_real_results() {
        let p = params();
        let mut s = plan(&p);
        assert_eq!(s.len(), 4);
        prepare(&p, &mut s, 0).unwrap();
        assert_eq!(s[0].input_image_id.as_deref(), Some("42"));
        assert!(prepare(&p, &mut s, 1).is_err());
        s[0].result = Some("A red fox".into());
        prepare(&p, &mut s, 1).unwrap();
        assert_eq!(s[1].prompt, "A red fox");
        s[1].output_image_id = Some("99".into());
        prepare(&p, &mut s, 2).unwrap();
        assert_eq!(s[2].input_image_id.as_deref(), Some("99"));
    }
    #[test]
    fn text_bootstrap_does_not_consume_a_cycle() {
        let mut p = params();
        p.input_image_id = None;
        p.initial_prompt = Some("A fox".into());
        let s = plan(&p);
        assert_eq!(s.len(), 5);
        assert_eq!(s[0].cycle, 0);
        assert_eq!(s[0].kind, Kind::Generate);
        assert_eq!(s[0].prompt, "A fox");
        assert_eq!(s[4].cycle, 2);
    }
    #[test]
    fn improvement_uses_current_image_and_structured_prompt_and_checks_last_output() {
        let mut p = params();
        p.expected_quality = Some(95);
        p.max_steps = Some(2);
        let mut steps = plan(&p);
        assert_eq!(steps.len(), 5); // two improvements plus three quality checks
        prepare(&p, &mut steps, 0).unwrap();
        let a = parse_assessment(r#"{"quality":60,"improve_prompt":"Fix lighting"}"#).unwrap();
        steps[0].quality = Some(a.quality);
        steps[0].improve_prompt = Some(a.improve_prompt);
        prepare(&p, &mut steps, 1).unwrap();
        assert_eq!(steps[1].input_image_id.as_deref(), Some("42"));
        assert_eq!(steps[1].prompt, "Fix lighting");
        steps[1].output_image_id = Some("88".into());
        prepare(&p, &mut steps, 2).unwrap();
        assert_eq!(steps[2].input_image_id.as_deref(), Some("88"));
        steps[2].quality = Some(96);
        assert_eq!(
            stop_reason("completed", &p, &steps).as_deref(),
            Some("target_reached")
        );
        steps[2].quality = Some(90);
        assert_eq!(
            stop_reason("completed", &p, &steps).as_deref(),
            Some("max_steps_reached")
        );
    }
    #[test]
    fn malformed_or_out_of_range_quality_cannot_control_the_run() {
        for invalid in [
            r#"{"quality":"95/100","improve_prompt":"fix"}"#,
            r#"{"quality":101,"improve_prompt":"fix"}"#,
            r#"{"quality":-1,"improve_prompt":"fix"}"#,
            r#"{"quality":95}"#,
            "not JSON",
        ] {
            assert!(parse_assessment(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            parse_assessment(r#"{"quality":0,"improve_prompt":"rebuild"}"#)
                .unwrap()
                .quality,
            0
        );
        assert_eq!(
            parse_assessment(r#"{"quality":100,"improve_prompt":""}"#)
                .unwrap()
                .quality,
            100
        );
        assert_eq!(
            assessment_schema()["required"],
            serde_json::json!(["quality", "improve_prompt"])
        );
    }
    #[test]
    fn validation_rejects_ambiguous_inputs_and_bounds_and_normalizes_models() {
        let mut p = params();
        validate(&mut p).unwrap();
        assert_eq!(p.vision_model, "llm.vision");
        p.initial_prompt = Some("fox".into());
        assert!(validate(&mut p).is_err());
        p.initial_prompt = None;
        p.cycles = 0;
        assert!(validate(&mut p).is_err());
        p.cycles = 51;
        assert!(validate(&mut p).is_err());
        p.cycles = 1;
        p.width = -1;
        assert!(validate(&mut p).is_err());
        p.width = 1024;
        p.input_image_id = None;
        assert!(validate(&mut p).is_err());
    }
}
