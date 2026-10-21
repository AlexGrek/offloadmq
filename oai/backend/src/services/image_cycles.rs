//! Describe → txt2img chains built from the existing persistent child jobs.
//! This is a multi-job state machine, rather than a single offload-job driver.
use crate::{
    db::{image_cycles as db, image_generation},
    error::AppError,
    offload::{base_capability, task_status::is_terminal},
    services::{
        image_analysis, image_job_names, image_jobs, prompt_expansion::PromptExpander,
        prompt_usage, storage,
    },
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
    /// Snapshot of the model used for this step, independent of future edits.
    #[serde(default)]
    pub model: Option<String>,
    /// A checkpoint snapshot borrowed from an earlier run, without child ownership.
    #[serde(default)]
    pub reused: bool,
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
        model: None,
        reused: false,
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
fn validate_assessment(value: serde_json::Value) -> Result<Assessment, AppError> {
    let assessment: Assessment = serde_json::from_value(value).map_err(|e| {
        AppError::BadRequest(format!(
            "vision must return JSON with quality (0–100) and improve_prompt: {e}"
        ))
    })?;
    if assessment.quality > 100 {
        return Err(AppError::BadRequest(
            "vision quality must be between 0 and 100".into(),
        ));
    }
    Ok(assessment)
}

fn parse_assessment(text: &str) -> Result<Assessment, AppError> {
    let text = text.trim().trim_start_matches('\u{feff}').trim();
    // Some serving layers return a JSON-encoded string instead of the object.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        return match value {
            serde_json::Value::String(inner) => parse_assessment_object(&inner),
            object => validate_assessment(object),
        };
    }
    parse_assessment_object(text)
}

/// Markdown rendering hides ```json fences, so a response can look like a bare
/// object in the UI while failing at column 1. Extract one complete JSON object
/// from fences/preamble; serde still enforces the schema and numeric bounds.
fn parse_assessment_object(text: &str) -> Result<Assessment, AppError> {
    let mut cleaned = text.to_owned();
    for (open, close) in [("<think>", "</think>"), ("<analysis>", "</analysis>")] {
        while let Some(start) = cleaned
            .find(open)
            .filter(|i| *i < cleaned.find('{').unwrap_or(cleaned.len()))
        {
            let Some(end) = cleaned[start + open.len()..].find(close) else {
                break;
            };
            cleaned.replace_range(start..start + open.len() + end + close.len(), "");
        }
    }
    let text = cleaned.as_str();
    let mut cursor = 0;
    let mut found = None;
    let mut error = None;
    // Bound failed parses of pathological output containing many unmatched braces.
    for _ in 0..128 {
        let Some(offset) = text[cursor..].find('{') else {
            break;
        };
        let start = cursor + offset;
        let mut stream =
            serde_json::Deserializer::from_str(&text[start..]).into_iter::<serde_json::Value>();
        match stream.next() {
            Some(Ok(value)) => {
                cursor = start + stream.byte_offset();
                match validate_assessment(value) {
                    Ok(value) => {
                        if found.is_some() {
                            return Err(AppError::BadRequest("vision returned multiple assessment objects; expected one quality/improve_prompt object".into()));
                        }
                        found = Some(value);
                    }
                    Err(e) => error = Some(e),
                }
            }
            Some(Err(e)) => {
                error = Some(AppError::BadRequest(format!("invalid vision JSON: {e}")));
                cursor = start + 1;
            }
            None => break,
        }
    }
    found.ok_or_else(|| error.unwrap_or_else(|| AppError::BadRequest(format!(
        "vision must return JSON with quality (0–100) and improve_prompt; no JSON object found (response starts with {:?})",
        text.chars().take(80).collect::<String>()
    ))))
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
fn vision_prompt(p: &Params) -> String {
    if p.expected_quality.is_some() {
        assessment_prompt(p)
    } else {
        p.describe_prompt.clone()
    }
}

fn change_vision_prompt(p: &mut Params, steps: &mut [Step], prompt: &str) -> Result<(), AppError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::BadRequest("vision prompt is required".into()));
    }
    p.describe_prompt = prompt.to_owned();
    let prompt = vision_prompt(p);
    for step in steps {
        if step.kind == Kind::Describe && step.status == "queued" && step.child_job_id.is_none() {
            step.prompt.clone_from(&prompt);
        }
    }
    Ok(())
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
    validate_models(state, user, &mut p).await?;
    let id = state.next_id();
    db::create(&state.db, id, user, app, encode(&p)?, encode(&plan(&p))?).await?;
    prompt_usage::note_use(state, user, "describe-image-user", &p.describe_prompt).await;
    if let Some(prompt) = &p.initial_prompt {
        prompt_usage::note_use(state, user, "imggen-prompt", prompt).await;
    }
    Ok(id)
}

async fn validate_models(state: &AppState, user: i64, p: &mut Params) -> Result<(), AppError> {
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
    Ok(())
}

fn model_for_step(p: &Params, step: &Step) -> String {
    match step.kind {
        Kind::Describe => p.vision_model.clone(),
        Kind::Generate if p.expected_quality.is_some() && step.cycle == 0 => {
            p.bootstrap_model.clone().unwrap_or_default()
        }
        Kind::Generate => p.image_model.clone(),
    }
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
            // Judge the concrete bootstrap image's intent, rather than drawing new
            // random values from its template on every assessment.
            let mut instructions = p.clone();
            if p.initial_prompt.is_some() && i > 0 {
                instructions.initial_prompt = Some(steps[0].prompt.clone());
            }
            steps[i].prompt = vision_prompt(&instructions);
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

/// Resolve only fresh work, before its durable child reservation. Parameters and
/// vision results remain templates/raw output; the step records exactly what is
/// sent. Recovery of a reserved submission must reuse this persisted expansion.
fn expand_step_prompt(step: &mut Step, expander: &mut PromptExpander) -> Result<(), AppError> {
    let expanded = expander.expand(&step.prompt)?;
    let expanded = image_job_names::expand_prompt_placeholders(expanded.trim());
    if expanded.trim().is_empty() {
        return Err(AppError::BadRequest(
            "prompt is empty after placeholder substitution".into(),
        ));
    }
    step.prompt = expanded.trim().to_owned();
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
                    capability: step
                        .model
                        .clone()
                        .unwrap_or_else(|| model_for_step(p, step)),
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
                    capability: step
                        .model
                        .clone()
                        .unwrap_or_else(|| model_for_step(p, step)),
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
            step.model = Some(job.capability);
            step.prompt = job.prompt;
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
            step.model = Some(job.capability);
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
            let allow_submit = job.status == "running";
            let result = advance(state, &mut job, &p, &mut steps, i, allow_submit).await;
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
    allow_submit: bool,
) -> Result<(), AppError> {
    if !allow_submit && steps[i].child_job_id.is_none() {
        return Ok(());
    }
    let fresh = steps[i].child_job_id.is_none();
    if fresh {
        prepare(p, steps, i)?;
        let mut expander = if steps[i].prompt.contains('{') {
            PromptExpander::for_user(&state.db, job.user_id).await?
        } else {
            PromptExpander::new([])
        };
        expand_step_prompt(&mut steps[i], &mut expander)?;
        steps[i].model = Some(model_for_step(p, &steps[i]));
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
        if !allow_submit {
            return Ok(());
        }
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

/// Pausing holds future submissions; an already-running child can finish and
/// its result is reconciled when viewed or resumed.
pub async fn pause(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut job = db::get(&state.db, id, user).await?;
    if !matches!(job.status.as_str(), "running" | "paused") {
        return Err(AppError::BadRequest(
            "only an active run can be paused".into(),
        ));
    }
    job.status = "paused".into();
    let steps: Vec<Step> = decode(&job.steps_json)?;
    save(state, &mut job, &steps).await?;
    lock.commit().await?;
    view(job)
}

pub async fn resume(state: &AppState, user: i64, id: i64) -> Result<View, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut job = db::get(&state.db, id, user).await?;
    let mut steps: Vec<Step> = decode(&job.steps_json)?;
    if job.status == "failed" {
        // Reuse a completed vision result after a parser fix. Never rerun an
        // already-paid inference just to remove its Markdown fences.
        let step = steps
            .iter_mut()
            .find(|s| s.status == "failed")
            .filter(|s| s.kind == Kind::Describe && s.result.is_some())
            .ok_or_else(|| {
                AppError::BadRequest("this failure requires restarting the run".into())
            })?;
        let child = crate::routes::job_common::parse_id(
            step.child_job_id.as_deref().unwrap_or(""),
            "child_job_id",
        )?;
        if image_analysis::user_job_detail(state, child, user)
            .await?
            .job
            .status
            != "completed"
        {
            return Err(AppError::BadRequest(
                "this failure requires restarting the run".into(),
            ));
        }
        step.status = "submitted".into();
        step.error = None;
    } else if job.status != "paused" {
        return Err(AppError::BadRequest(
            "only a paused run or failed assessment can be resumed".into(),
        ));
    }
    job.status = "running".into();
    job.error = None;
    save(state, &mut job, &steps).await?;
    lock.commit().await?;
    view(job)
}

#[derive(Deserialize)]
pub struct ModelChanges {
    pub vision_model: Option<String>,
    pub image_model: Option<String>,
    pub bootstrap_model: Option<String>,
}

/// Editing instructions never depends on model availability or resubmits work.
pub async fn update_vision_prompt(
    state: &AppState,
    user: i64,
    id: i64,
    prompt: &str,
) -> Result<View, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut job = db::get(&state.db, id, user).await?;
    let mut p: Params = decode(&job.params_json)?;
    let mut steps: Vec<Step> = decode(&job.steps_json)?;
    change_vision_prompt(&mut p, &mut steps, prompt)?;
    job.params_json = encode(&p)?;
    save(state, &mut job, &steps).await?;
    lock.commit().await?;
    prompt_usage::note_use(state, user, "describe-image-user", &p.describe_prompt).await;
    view(job)
}

pub async fn update_models(
    state: &AppState,
    user: i64,
    id: i64,
    changes: ModelChanges,
) -> Result<View, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut job = db::get(&state.db, id, user).await?;
    let old: Params = decode(&job.params_json)?;
    let mut p = old.clone();
    if let Some(model) = changes.vision_model {
        p.vision_model = base_capability(model.trim()).to_owned();
    }
    if let Some(model) = changes.image_model {
        p.image_model = base_capability(model.trim()).to_owned();
    }
    if let Some(model) = changes.bootstrap_model {
        if job.app != "generator-improver" {
            return Err(AppError::BadRequest(
                "bootstrap_model is only used by Generator Improver".into(),
            ));
        }
        p.bootstrap_model = Some(base_capability(model.trim()).to_owned());
    }
    validate_models(state, user, &mut p).await?;
    let mut steps: Vec<Step> = decode(&job.steps_json)?;
    // Backfill old steps from their child records before changing defaults, so
    // existing history never appears to have used the newly selected model.
    for step in &mut steps {
        if step.model.is_some() {
            continue;
        }
        if let Some(child) = &step.child_job_id {
            let id = crate::routes::job_common::parse_id(child, "child_job_id")?;
            step.model = match step.kind {
                Kind::Describe => match image_analysis::user_job_detail(state, id, user).await {
                    Ok(detail) => Some(detail.job.capability),
                    Err(AppError::NotFound) => None,
                    Err(e) => return Err(e),
                },
                Kind::Generate => image_generation::get_job(&state.db, id, user)
                    .await?
                    .map(|j| j.capability),
            }
            .or_else(|| Some(model_for_step(&old, step)));
        }
    }
    job.params_json = encode(&p)?;
    save(state, &mut job, &steps).await?;
    lock.commit().await?;
    view(job)
}

/// Keep the old history and cancel its remaining work, then start from the seed
/// using the latest selected models. Works for active, paused and terminal runs.
pub async fn restart(state: &AppState, user: i64, id: i64) -> Result<i64, AppError> {
    let source = db::get(&state.db, id, user).await?;
    let mut params: Params = decode(&source.params_json)?;
    validate_models(state, user, &mut params).await?;
    let source = cancel(state, user, id).await?;
    start_for_app(state, user, source.params, &source.app).await
}

/// Retain completed checkpoints without sharing ownership of their child jobs.
/// The selected step and all successors are fresh work with the current models.
fn restart_plan(p: &Params, source: &[Step], index: usize) -> Result<Vec<Step>, AppError> {
    if index >= source.len() {
        return Err(AppError::BadRequest("step index is out of range".into()));
    }
    if source[..index]
        .iter()
        .any(|step| step.status != "completed")
    {
        return Err(AppError::BadRequest(
            "earlier steps must finish before restarting from this step".into(),
        ));
    }
    let mut steps = plan(p);
    if steps.len() != source.len() {
        return Err(AppError::BadRequest(
            "step plan does not match run settings".into(),
        ));
    }
    for (step, original) in steps[..index].iter_mut().zip(source) {
        *step = original.clone();
        step.child_job_id = None;
        step.reused = true;
    }
    prepare(p, &mut steps, index)?;
    Ok(steps)
}

pub async fn restart_from_step(
    state: &AppState,
    user: i64,
    id: i64,
    index: usize,
) -> Result<i64, AppError> {
    db::get(&state.db, id, user).await?;
    let _slot = ADVANCE_SLOTS
        .acquire()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let lock = db::lock(&state.db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing cycle lock".into()))?;
    let mut source = db::get(&state.db, id, user).await?;
    let mut p: Params = decode(&source.params_json)?;
    let mut original: Vec<Step> = decode(&source.steps_json)?;
    let steps = restart_plan(&p, &original, index)?;
    let op = storage::operator(state)?;
    if let Some(input) = &steps[index].input_image_id {
        let input = crate::routes::job_common::parse_id(input, "input_image_id")?;
        let file = image_generation::get_image_file(&state.db, input, user)
            .await?
            .ok_or_else(|| AppError::BadRequest("the step's input image was deleted".into()))?;
        if !storage::exists(op, &file.storage_path).await? {
            return Err(AppError::BadRequest(
                "the step's input image was deleted".into(),
            ));
        }
    }
    validate_models(state, user, &mut p).await?;
    if !is_terminal(&source.status) {
        source.status = "cancelRequested".into();
        save(state, &mut source, &original).await?;
        if let Err(e) = cancel_steps(state, &mut source, &mut original).await {
            tracing::warn!("image cycles restart from step {id}/{index}: {e}");
        }
    }
    let next = state.next_id();
    db::create(
        &state.db,
        next,
        user,
        &source.app,
        encode(&p)?,
        encode(&steps)?,
    )
    .await?;
    lock.commit().await?;
    Ok(next)
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
    fn completed_plan(p: &Params) -> Vec<Step> {
        let mut steps = plan(p);
        for i in 0..steps.len() {
            prepare(p, &mut steps, i).unwrap();
            steps[i].status = "completed".into();
            steps[i].model = Some(model_for_step(p, &steps[i]));
            steps[i].child_job_id = Some((100 + i).to_string());
            if steps[i].kind == Kind::Generate {
                steps[i].output_image_id = Some((200 + i).to_string());
            } else {
                steps[i].result = Some("A vivid fox".into());
                steps[i].quality = p.expected_quality.map(|_| 60);
                steps[i].improve_prompt = p.expected_quality.map(|_| "Improve lighting".into());
            }
        }
        steps
    }

    fn placeholder_expander() -> PromptExpander {
        PromptExpander::new([
            (".subject".into(), vec!["{color} {animal}".into()]),
            ("style".into(), vec!["cinematic".into()]),
        ])
    }

    #[test]
    fn substitutions_cover_every_prompt_in_both_apps_with_image_or_text_seeds() {
        for improver in [false, true] {
            for text_seed in [false, true] {
                let mut p = params();
                p.expected_quality = improver.then_some(95);
                p.describe_prompt = "Use {STYLE} lighting for {?}; keep {unknown}.".into();
                if text_seed {
                    p.input_image_id = None;
                    p.initial_prompt = Some("A {.subject} named {?}".into());
                }
                let original = encode(&p).unwrap();
                let mut steps = plan(&p);
                let mut bootstrap = None;
                for i in 0..steps.len() {
                    prepare(&p, &mut steps, i).unwrap();
                    expand_step_prompt(&mut steps[i], &mut placeholder_expander()).unwrap();
                    let prompt = &steps[i].prompt;
                    assert!(!prompt.contains("{?}"), "{prompt}");
                    assert!(!prompt.contains("{.subject}"), "{prompt}");
                    assert!(!prompt.contains("{color}"), "{prompt}");
                    assert!(!prompt.contains("{animal}"), "{prompt}");
                    assert!(!prompt.contains("{STYLE}"), "{prompt}");
                    if steps[i].kind == Kind::Describe {
                        assert!(prompt.starts_with("Use cinematic lighting for "));
                        assert!(prompt.contains("{unknown}"));
                        if improver {
                            assert!(prompt.contains("Return only a JSON object"));
                            if let Some(seed) = &bootstrap {
                                assert!(prompt.contains(&format!("Desired image: {seed}\n")));
                            }
                        }
                        steps[i].result = Some("A {.subject} in {style} light, called {?}".into());
                        steps[i].improve_prompt =
                            improver.then(|| "Add {color} {style} light to {?}".into());
                    } else {
                        steps[i].output_image_id = Some((200 + i).to_string());
                        if steps[i].cycle == 0 {
                            bootstrap = Some(steps[i].prompt.clone());
                        } else {
                            assert!(steps[i].prompt.contains("cinematic"));
                            // The model's raw result is kept independently of expansion.
                            assert!(steps[i - 1].result.as_ref().unwrap().contains("{.subject}"));
                        }
                    }
                    steps[i].status = "completed".into();
                }
                assert_eq!(encode(&p).unwrap(), original, "templates must survive");
            }
        }
    }

    #[test]
    fn edited_prompts_and_step_restarts_expand_fresh_work_preserving_checkpoints() {
        for improver in [false, true] {
            let mut p = params();
            p.expected_quality = improver.then_some(95);
            let source = completed_plan(&p);
            let original = encode(&source).unwrap();
            let mut steps = restart_plan(&p, &source, 2).unwrap();
            change_vision_prompt(
                &mut p,
                &mut steps,
                "Use {style}; example: {\"quality\":95,\"improve_prompt\":\"sharpen\"}",
            )
            .unwrap();
            prepare(&p, &mut steps, 2).unwrap();
            expand_step_prompt(&mut steps[2], &mut placeholder_expander()).unwrap();
            assert!(steps[2].prompt.starts_with("Use cinematic; example:"));
            assert!(
                steps[2]
                    .prompt
                    .contains(r#"{"quality":95,"improve_prompt":"sharpen"}"#)
            );
            for i in 0..2 {
                assert_eq!(steps[i].prompt, source[i].prompt);
                assert_eq!(steps[i].result, source[i].result);
            }
            assert_eq!(encode(&source).unwrap(), original);
            assert!(p.describe_prompt.contains("{style}"));
        }
    }

    #[test]
    fn invalid_expansions_fail_before_replacing_the_step_prompt() {
        let mut step = new_step(1, Kind::Describe, "{blank}".into());
        let mut expander = PromptExpander::new([("blank".into(), vec!["  ".into()])]);
        assert!(expand_step_prompt(&mut step, &mut expander).is_err());
        assert_eq!(step.prompt, "{blank}");
        assert!(step.child_job_id.is_none());
        step.prompt = "{large}".into();
        let mut expander = PromptExpander::new([("large".into(), vec!["x".repeat(32_001)])]);
        assert!(expand_step_prompt(&mut step, &mut expander).is_err());
        assert_eq!(step.prompt, "{large}");
    }

    #[test]
    fn vision_prompt_edits_preserve_history_and_update_only_unsubmitted_assessments() {
        for improver in [false, true] {
            let mut p = params();
            p.expected_quality = improver.then_some(95);
            let mut steps = plan(&p);
            steps[0].status = "submitted".into();
            steps[0].child_job_id = Some("100".into());
            let original = steps[0].prompt.clone();
            let generation = encode(&steps[1]).unwrap();
            change_vision_prompt(&mut p, &mut steps, "  Prioritize texture and lighting.  ")
                .unwrap();
            assert_eq!(p.describe_prompt, "Prioritize texture and lighting.");
            assert_eq!(steps[0].prompt, original);
            assert_eq!(encode(&steps[1]).unwrap(), generation);
            assert!(steps[2].prompt.starts_with(&p.describe_prompt));
            if improver {
                assert!(
                    steps
                        .last()
                        .unwrap()
                        .prompt
                        .contains("Return only a JSON object")
                );
                assert!(steps[2].prompt.contains("improve_prompt"));
                assert!(steps[2].prompt.contains("quality"));
            } else {
                assert_eq!(steps[2].prompt, p.describe_prompt);
            }
            let restarted = restart_plan(&p, &steps, 0).unwrap();
            assert!(restarted[0].prompt.starts_with(&p.describe_prompt));
            assert_eq!(steps[0].prompt, original);
            // Reserved submissions and reused history must also remain immutable.
            steps[2].child_job_id = Some("101".into());
            steps[0].status = "completed".into();
            steps[0].reused = true;
            steps[0].child_job_id = None;
            let reserved = steps[2].prompt.clone();
            change_vision_prompt(&mut p, &mut steps, "Another instruction").unwrap();
            assert_eq!(steps[0].prompt, original);
            assert_eq!(steps[2].prompt, reserved);
            let before = (encode(&p).unwrap(), encode(&steps).unwrap());
            assert!(change_vision_prompt(&mut p, &mut steps, " \n ").is_err());
            assert_eq!((encode(&p).unwrap(), encode(&steps).unwrap()), before);
        }
    }

    #[test]
    fn step_restart_reuses_checkpoints_without_owning_their_children() {
        for text in [false, true] {
            for improver in [false, true] {
                let mut p = params();
                if text {
                    p.input_image_id = None;
                    p.initial_prompt = Some("A fox".into());
                    p.bootstrap_model = Some("imggen.bootstrap".into());
                }
                if improver {
                    p.expected_quality = Some(95);
                    p.max_steps = Some(2);
                }
                let source = completed_plan(&p);
                let before = encode(&source).unwrap();
                p.vision_model = "llm.new".into();
                p.image_model = "imggen.new".into();
                for index in 0..source.len() {
                    let restarted = restart_plan(&p, &source, index).unwrap();
                    assert_eq!(restarted.len(), source.len());
                    for (i, step) in restarted.iter().enumerate() {
                        assert!(step.child_job_id.is_none());
                        if i < index {
                            assert!(step.reused);
                            assert_eq!(step.status, "completed");
                            assert_eq!(step.output_image_id, source[i].output_image_id);
                            assert_eq!(step.result, source[i].result);
                            assert_eq!(step.model, source[i].model);
                        } else {
                            assert!(!step.reused);
                            assert_eq!(step.status, "queued");
                            assert!(step.model.is_none());
                            assert!(step.output_image_id.is_none());
                            assert!(step.result.is_none());
                            assert!(step.quality.is_none());
                            assert!(step.error.is_none());
                        }
                    }
                    assert_eq!(
                        restarted[index].input_image_id,
                        source[index].input_image_id
                    );
                    assert_eq!(restarted[index].prompt, source[index].prompt);
                    assert_eq!(
                        model_for_step(&p, &restarted[index]),
                        match restarted[index].kind {
                            Kind::Describe => "llm.new",
                            Kind::Generate if improver && restarted[index].cycle == 0 =>
                                "imggen.bootstrap",
                            Kind::Generate => "imggen.new",
                        }
                    );
                }
                assert_eq!(encode(&source).unwrap(), before);
            }
        }
    }

    #[test]
    fn step_restart_rejects_invalid_or_unavailable_checkpoints() {
        let p = params();
        let mut source = completed_plan(&p);
        assert!(restart_plan(&p, &source, source.len()).is_err());
        source[0].status = "failed".into();
        assert!(restart_plan(&p, &source, 1).is_err());
        assert!(restart_plan(&p, &source, 0).is_ok());
        source[0].status = "completed".into();
        source[0].result = None;
        assert!(restart_plan(&p, &source, 1).is_err());
        source[1].output_image_id = None;
        assert!(restart_plan(&p, &source, 2).is_err());
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
    fn reported_quality_85_parses_raw_fenced_prefixed_and_encoded() {
        let raw = r#"{
  "quality": 85,
  "improve_prompt": "Improve sharpness and reduce noise in the background walls, enhance the vividness and consistency of the orange beam, ensure anatomical accuracy of the figure, remove any visible artifacts or distortions, maintain the monochrome brutalist aesthetic with the single vivid color beam, preserve the symmetrical composition and high-end cinematic editorial quality."
}"#;
        let fenced = format!("```json\n{raw}\n```");
        // Reproduce the old error: MarkdownContent hides these fences on screen.
        let old = serde_json::from_str::<Assessment>(&fenced).unwrap_err();
        assert_eq!((old.line(), old.column()), (1, 1));
        for output in [
            raw.to_owned(),
            fenced,
            format!("\u{feff}{raw}"),
            format!("Here is the assessment:\n{raw}\nDone."),
            format!(
                "<think>Example: {{\"quality\":10,\"improve_prompt\":\"example\"}}</think>\n{raw}"
            ),
            serde_json::to_string(raw).unwrap(),
        ] {
            let a = parse_assessment(&output).unwrap();
            assert_eq!(a.quality, 85);
            assert!(a.improve_prompt.ends_with("editorial quality."));
        }
    }
    #[test]
    fn json_extraction_keeps_escaped_braces_and_rejects_ambiguous_assessments() {
        let raw = r#"{"quality":85,"improve_prompt":"Keep {detail} and \"quoted\" text"}"#;
        assert!(parse_assessment(&format!("```json\n{raw}\n```")).is_ok());
        assert!(parse_assessment(&format!("{raw}\n{raw}")).is_err());
        assert!(
            parse_assessment("```json\n{\"quality\":85,\"improve_prompt\":\"unfinished").is_err()
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
