//! Image generation tools — `oai image capabilities|generate|jobs|job|poll|download|
//! cancel|retry|delete` over `services::image_jobs`.

use std::{future::Future, time::Duration};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    db::{image_generation, prompts as prompt_db},
    error::{AppError, ResultExt},
    offload::{LlmCapabilityInfo, task_status::is_terminal},
    services::{
        image_jobs::{self, JobDetail, StartJobParams},
        image_processing,
        prompt_expansion::PromptExpander,
        prompt_previews,
    },
};

use super::{
    super::content::{ImageView, ToolOutput, embed_previews, image_json},
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, ToolContext, WRITE, error_text, parse_args,
    require_ids, tool,
};

/// Prompt-library buckets the image generation page uses (`ImageGenerationPage.tsx`).
pub const PROMPT_BUCKET: &str = "imggen-prompt";
pub const NEGATIVE_BUCKET: &str = "imggen-negative";

/// Same cap as the CLI's `-n` (`maxGenerateCount`).
const MAX_COUNT: u32 = 10;
/// Claude's hosted apps give a tool call 240 s; stay well inside it.
const MAX_WAIT_SECS: u64 = 200;
const DEFAULT_WAIT_SECS: u64 = 150;
/// Same cadence as the web UI and the CLI.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const DEFAULT_SIZE: i32 = 1024;
const MIN_SIZE: i32 = 64;
const MAX_SIZE: i32 = 4096;
const LIST_DEFAULT_LIMIT: usize = 20;
const LIST_MAX_LIMIT: usize = 50;

const TOOLS: &[&str] = &[
    "list_image_models",
    "generate_images",
    "get_image_job",
    "list_image_jobs",
    "cancel_image_jobs",
    "retry_image_job",
    "delete_image_jobs",
    "view_image",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

fn wait_schema(default: u64) -> Value {
    json!({
        "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS, "default": default,
        "description": format!(
            "Seconds to wait for completion before returning (max {MAX_WAIT_SECS}). 0 returns \
             immediately; unfinished jobs keep running and can be checked with get_image_job."
        ),
    })
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_image_models",
            "List image models",
            "List the image generation models (imggen.* capabilities) known to OAI, whether each \
             is online right now, and its tags (workflows it supports, e.g. txt2img, img2img). \
             Same as `oai image capabilities`.",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "generate_images",
            "Generate images",
            "Generate one or more images from a text prompt (or edit an existing image with \
             workflow img2img + input_image_id). Submits one job per image, waits for them, and \
             returns preview thumbnails plus signed links to the full-resolution files. Prompt \
             placeholders like {color}, {animal}, the user's custom {placeholders} and {?} are \
             expanded per job, never repeating a value within a batch; pass them through as \
             the user wrote them (don't pre-fill them yourself). Unknown {tokens} are reported. \
             Results show each job's final prompt and keep the raw text as prompt_template. \
             Same as `oai image generate`.",
            json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "What to draw. May contain {placeholders}." },
                    "negative_prompt": { "type": "string", "description": "Things to avoid; overrides the workflow's default negative prompt." },
                    "model": { "type": "string", "description": "imggen.* capability from list_image_models. Default: an online model supporting the workflow." },
                    "workflow": { "type": "string", "description": "txt2img (default) or img2img (default when input_image_id is given). Must be a tag of the model." },
                    "input_image_id": { "type": "string", "description": "img2img source: an image_id from an earlier result in this account." },
                    "width": { "type": "integer", "minimum": MIN_SIZE, "maximum": MAX_SIZE, "description": "Default 1024 (img2img: the input's size)." },
                    "height": { "type": "integer", "minimum": MIN_SIZE, "maximum": MAX_SIZE, "description": "Default 1024 (img2img: the input's size)." },
                    "seed": { "type": "integer", "description": "Fixed seed for reproducible results; job N of a batch uses seed+N. Default random." },
                    "count": { "type": "integer", "minimum": 1, "maximum": MAX_COUNT, "default": 1, "description": "Number of images (separate jobs)." },
                    "save_to_history": { "type": "boolean", "default": true, "description": "Record the prompt in the user's recent prompts." },
                    "star_prompt": { "type": "boolean", "default": false, "description": "Also add the prompt (unexpanded) to the user's starred prompts." },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
                "required": ["prompt"],
            }),
            WRITE,
        ),
        tool(
            "get_image_job",
            "Get image job",
            "Check an image job: refreshes its state from the GPU queue and returns status, \
             timing, error, and — once completed — previews and links of its images. Optionally \
             waits for it to finish. Same as `oai image job|poll|download`.",
            json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string" },
                    "wait_seconds": wait_schema(0),
                    "include_previews": { "type": "boolean", "default": true, "description": "Embed thumbnail previews of the output images." },
                },
                "required": ["job_id"],
            }),
            READ_ONLY,
        ),
        tool(
            "list_image_jobs",
            "List image jobs",
            "List the user's recent image generation jobs (newest first, at most 50), optionally \
             filtered by status. Same as `oai image jobs`.",
            json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "description": "Comma-separated statuses to keep, e.g. failed,canceled." },
                    "active_only": { "type": "boolean", "default": false, "description": "Only jobs that have not finished yet." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": LIST_MAX_LIMIT, "default": LIST_DEFAULT_LIMIT },
                },
            }),
            READ_ONLY,
        ),
        tool(
            "cancel_image_jobs",
            "Cancel image jobs",
            "Cancel queued or running image jobs. Cancellation is asynchronous: a running job \
             moves to cancelRequested, then canceled. Same as `oai image cancel`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_image_job",
            "Retry image job",
            "Run a finished job (completed, failed or canceled) again with exactly the same \
             settings and already-expanded prompt, as a new job. Waits like generate_images. \
             For fresh placeholder values instead, call generate_images with the job's \
             prompt_template. Same as `oai image retry`.",
            json!({
                "type": "object",
                "properties": { "job_id": { "type": "string" }, "wait_seconds": wait_schema(DEFAULT_WAIT_SECS) },
                "required": ["job_id"],
            }),
            WRITE,
        ),
        tool(
            "delete_image_jobs",
            "Delete image jobs",
            "Permanently delete image jobs and their stored images. Same as `oai image delete`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            DESTRUCTIVE,
        ),
        tool(
            "view_image",
            "View image",
            "Show one of the user's images at a larger size than the result thumbnails (preview, \
             up to 1024 px) so it can be inspected, plus a signed link to the original file.",
            json!({
                "type": "object",
                "properties": {
                    "image_id": { "type": "string" },
                    "size": { "type": "string", "enum": ["preview", "thumbnail"], "default": "preview" },
                },
                "required": ["image_id"],
            }),
            READ_ONLY,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "list_image_models" => list_models(ctx).await,
        "generate_images" => generate(ctx, parse_args(args)?).await,
        "get_image_job" => get_job(ctx, parse_args(args)?).await,
        "list_image_jobs" => list_jobs(ctx, parse_args(args)?).await,
        "cancel_image_jobs" => cancel_jobs(ctx, parse_args(args)?).await,
        "retry_image_job" => retry_job(ctx, parse_args(args)?).await,
        "delete_image_jobs" => delete_jobs(ctx, parse_args(args)?).await,
        "view_image" => view_image(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

// ── Models ───────────────────────────────────────────────────────────────────

async fn list_models(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let caps = image_jobs::list_imggen_capabilities(&ctx.state, ctx.user_id).await?;
    if caps.is_empty() {
        return Ok(ToolOutput::text("No image models are known to the server."));
    }
    let mut lines = vec!["Image models (online first):".to_string()];
    let mut sorted: Vec<&LlmCapabilityInfo> = caps.iter().collect();
    sorted.sort_by_key(|c| !c.online);
    for c in &sorted {
        lines.push(format!(
            "- {} — {}{}{}",
            c.base,
            if c.online { "online" } else { "offline" },
            if c.tags.is_empty() {
                String::new()
            } else {
                format!(", tags: {}", c.tags.join(", "))
            },
            if c.usage_count > 0 {
                format!(", used in {} of your last 20 jobs", c.usage_count)
            } else {
                String::new()
            },
        ));
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({
        "models": sorted.iter().map(|c| json!({
            "model": c.base, "online": c.online, "tags": c.tags,
            "last_available_at": c.last_available_at, "usage_count": c.usage_count,
        })).collect::<Vec<_>>(),
    }));
    Ok(out)
}

/// The CLI's `pickCapability`: the first online model tagged with the workflow, else the
/// first online model; with nothing online, an error naming the known models.
fn pick_model(caps: &[LlmCapabilityInfo], workflow: &str) -> Result<String, AppError> {
    let online: Vec<&LlmCapabilityInfo> = caps.iter().filter(|c| c.online).collect();
    if let Some(c) = online.iter().find(|c| c.tags.iter().any(|t| t == workflow)) {
        return Ok(c.base.clone());
    }
    if let Some(c) = online.first() {
        return Ok(c.base.clone());
    }
    if caps.is_empty() {
        return Err(AppError::BadRequest(
            "no image models are known to the server".into(),
        ));
    }
    let names: Vec<String> = caps
        .iter()
        .map(|c| format!("{} (offline)", c.base))
        .collect();
    Err(AppError::BadRequest(format!(
        "no image model is online right now; known: {}",
        names.join(", ")
    )))
}

// ── Generate ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GenerateArgs {
    prompt: String,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
    #[serde(default)]
    input_image_id: Option<Id>,
    #[serde(default)]
    width: Option<i32>,
    #[serde(default)]
    height: Option<i32>,
    #[serde(default)]
    seed: Option<i64>,
    #[serde(default)]
    count: Option<u32>,
    #[serde(default)]
    save_to_history: Option<bool>,
    #[serde(default)]
    star_prompt: Option<bool>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

fn wait_duration(wait_seconds: Option<u64>, default: u64) -> Result<Duration, AppError> {
    let secs = wait_seconds.unwrap_or(default);
    if secs > MAX_WAIT_SECS {
        return Err(AppError::BadRequest(format!(
            "wait_seconds must be at most {MAX_WAIT_SECS}"
        )));
    }
    Ok(Duration::from_secs(secs))
}

fn check_size(name: &str, v: i32) -> Result<i32, AppError> {
    if !(MIN_SIZE..=MAX_SIZE).contains(&v) {
        return Err(AppError::BadRequest(format!(
            "{name} must be between {MIN_SIZE} and {MAX_SIZE}"
        )));
    }
    Ok(v)
}

async fn generate(ctx: &ToolContext, a: GenerateArgs) -> Result<ToolOutput, AppError> {
    let template = a.prompt.trim().to_string();
    if template.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    let count = a.count.unwrap_or(1);
    if !(1..=MAX_COUNT).contains(&count) {
        return Err(AppError::BadRequest(format!(
            "count must be between 1 and {MAX_COUNT}"
        )));
    }
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let negative = a
        .negative_prompt
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    let workflow = a
        .workflow
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .unwrap_or_else(|| {
            if a.input_image_id.is_some() {
                "img2img".into()
            } else {
                "txt2img".into()
            }
        });

    // img2img defaults to the input's own (stored) size — the web UI's "original
    // resolution" default; ownership is checked here before anything is submitted.
    let input = match a.input_image_id {
        Some(Id(id)) => Some(
            image_generation::get_image_file(&ctx.state.db, id, ctx.user_id)
                .await?
                .ok_or_else(|| AppError::BadRequest(format!("input image {id} not found")))?,
        ),
        None => None,
    };
    let (default_w, default_h) = input
        .as_ref()
        .map(|f| (f.stored_width, f.stored_height))
        .unwrap_or((DEFAULT_SIZE, DEFAULT_SIZE));
    let width = check_size("width", a.width.unwrap_or(default_w))?;
    let height = check_size("height", a.height.unwrap_or(default_h))?;

    let mut notes = Vec::new();
    let model = match a
        .model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        Some(m) => m,
        None => {
            let caps = image_jobs::list_imggen_capabilities(&ctx.state, ctx.user_id).await?;
            let m = pick_model(&caps, &workflow)?;
            notes.push(format!("Model: {m} (auto-selected, online)"));
            m
        }
    };

    // Custom placeholders are additive, as in the web UI and CLI: if they can't be
    // loaded the builtin categories still expand and custom tokens stay literal.
    let mut expander = match PromptExpander::for_user(&ctx.state.db, ctx.user_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("mcp: loading custom placeholders failed: {e:?}");
            notes.push(
                "Warning: custom placeholders could not be loaded; they were sent literally."
                    .into(),
            );
            PromptExpander::new([])
        }
    };

    // Validate every expansion before submitting anything: a later expansion
    // error must not hide the IDs of jobs already sent to the queue.
    let expanded_prompts: Vec<String> = (0..count)
        .map(|_| expander.expand(&template).map(|p| p.trim().to_string()))
        .collect::<Result<_, _>>()?;
    notes.extend(super::placeholders::expansion_warnings(&expander));
    let mut job_ids = Vec::new();
    let mut submit_error = None;
    for (i, expanded) in (0..count).zip(expanded_prompts) {
        let params = StartJobParams {
            capability: model.clone(),
            prompt: expanded,
            negative_prompt: negative.clone(),
            override_negative: negative.is_some(),
            width,
            height,
            // Offset per job: one shared seed would make every image identical.
            seed: a.seed.filter(|s| *s != 0).map(|s| s + i64::from(i)),
            workflow: Some(workflow.clone()),
            input_image_id: input.as_ref().map(|f| f.id.to_string()),
            data_preparation: None,
            rescale: None,
            video_length: None,
            external_resize: false,
            prompt_template: Some(template.clone()),
        };
        match image_jobs::start_job(&ctx.state, ctx.user_id, params).await {
            Ok(id) => job_ids.push(id),
            Err(e) => {
                submit_error = Some(format!(
                    "submitting job {} of {count} failed: {}",
                    i + 1,
                    error_text(&e)
                ));
                break;
            }
        }
    }
    if job_ids.is_empty() {
        return Err(AppError::BadRequest(
            submit_error.unwrap_or_else(|| "nothing was submitted".into()),
        ));
    }

    // Once per invocation, the unexpanded template — like the web UI and `--history`.
    if a.save_to_history.unwrap_or(true) {
        prompt_previews::record_use(&ctx.state, ctx.user_id, PROMPT_BUCKET, &template)
            .await
            .log_warn("mcp: record recent prompt");
        if let Some(n) = negative.as_deref() {
            prompt_previews::record_use(&ctx.state, ctx.user_id, NEGATIVE_BUCKET, n)
                .await
                .log_warn("mcp: record recent negative prompt");
        }
    }
    if a.star_prompt.unwrap_or(false) {
        match prompt_db::add_starred(
            &ctx.state.db,
            || ctx.state.next_id(),
            ctx.user_id,
            PROMPT_BUCKET,
            &template,
        )
        .await
        {
            Ok(entry) => notes.push(format!("Starred the prompt (entry {}).", entry.id)),
            Err(e) => notes.push(format!(
                "Warning: could not star the prompt: {}",
                error_text(&e)
            )),
        }
    }
    if let Some(e) = submit_error {
        notes.push(format!("Warning: {e}"));
    }

    wait_for_jobs(ctx, &job_ids, wait).await;
    render_jobs(ctx, &job_ids, notes, true).await
}

// ── Waiting & rendering ──────────────────────────────────────────────────────

/// Forces a reconcile of each unfinished job (the same thing `POST …/poll` does) every
/// [`POLL_INTERVAL`] until all are terminal or `wait` has passed. Poll errors are not
/// fatal — the background worker keeps reconciling, and the persisted state is what
/// gets reported.
async fn wait_for_jobs(ctx: &ToolContext, job_ids: &[i64], wait: Duration) {
    wait_for_jobs_with(job_ids, wait, |id| async move {
        image_jobs::poll_job(&ctx.state, ctx.user_id, id)
            .await
            .map(|p| is_terminal(&p.status))
    })
    .await;
}

async fn wait_for_jobs_with<F, Fut>(job_ids: &[i64], wait: Duration, mut poll: F)
where
    F: FnMut(i64) -> Fut,
    Fut: Future<Output = Result<bool, AppError>>,
{
    let deadline = tokio::time::Instant::now() + wait;
    let mut pending: Vec<i64> = job_ids.to_vec();
    loop {
        let mut still = Vec::new();
        for &id in &pending {
            // In particular, zero wait must not make an upstream request.
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            match tokio::time::timeout_at(deadline, poll(id)).await {
                Ok(Ok(true) | Err(AppError::NotFound)) => {}
                Ok(Ok(false)) => still.push(id),
                Ok(Err(e)) => {
                    tracing::debug!(job_id = id, "mcp poll failed: {e:?}");
                    still.push(id);
                }
                // Drop the stalled poll; callers render persisted state and the
                // background worker can finish reconciling the job.
                Err(_) => return,
            }
        }
        pending = still;
        let now = tokio::time::Instant::now();
        if pending.is_empty() || now >= deadline {
            return;
        }
        tokio::time::sleep(POLL_INTERVAL.min(deadline - now)).await;
    }
}

fn fmt_secs(s: f64) -> String {
    let s = s.round() as i64;
    if s >= 60 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{s}s")
    }
}

fn job_outputs(detail: &JobDetail) -> Vec<ImageView> {
    detail
        .files
        .iter()
        .filter(|f| f.direction == "output")
        .map(ImageView::from_file)
        .collect()
}

fn job_line(detail: &JobDetail, outputs: usize) -> String {
    let job = &detail.job;
    let mut line = format!(
        "Job {} ({}) — {}",
        job.id,
        image_jobs::display_name_for_job(job),
        job.status
    );
    match job.status.as_str() {
        "completed" => {
            if let Some(s) = detail.execution_seconds {
                line.push_str(&format!(" in {}", fmt_secs(s)));
            }
            line.push_str(&format!(
                ", {outputs} image{}",
                if outputs == 1 { "" } else { "s" }
            ));
        }
        "failed" | "canceled" => {
            if let Some(e) = job.error.as_deref().filter(|e| !e.is_empty()) {
                line.push_str(&format!(": {e}"));
            }
        }
        _ => {
            if let Some(started) = detail.started_at {
                let ran = (chrono::Utc::now().fixed_offset() - started)
                    .num_seconds()
                    .max(0) as f64;
                line.push_str(&format!(", running for {}", fmt_secs(ran)));
                if let Some(t) = detail.typical_runtime_seconds {
                    line.push_str(&format!(" (usually ~{})", fmt_secs(t)));
                }
            } else {
                line.push_str(", waiting for a GPU worker");
            }
        }
    }
    line
}

/// The prompt as typed, before `{placeholder}` substitution — what to resubmit for
/// fresh random values (the web UI's "Edit prompt"). `None` for jobs created without
/// one (older API/CLI jobs); then the stored prompt *is* the template.
fn prompt_template(job: &image_generation::ImageGenerationJob) -> Option<String> {
    image_jobs::pipeline_params_for_job(job)
        .prompt_template
        .filter(|t| !t.trim().is_empty())
}

fn job_json(ctx: &ToolContext, detail: &JobDetail, outputs: &[ImageView]) -> Value {
    let job = &detail.job;
    json!({
        "job_id": job.id.to_string(),
        "name": image_jobs::display_name_for_job(job),
        "status": job.status,
        "error": job.error,
        "prompt": job.prompt,
        "prompt_template": prompt_template(job),
        "negative_prompt": job.negative_prompt,
        "model": job.capability,
        "workflow": job.workflow,
        "width": job.width,
        "height": job.height,
        "seed": job.seed,
        "input_image_id": job.input_image_id.map(|i| i.to_string()),
        "created_at": job.created_at.to_rfc3339(),
        "started_at": detail.started_at.map(|t| t.to_rfc3339()),
        "typical_runtime_seconds": detail.typical_runtime_seconds,
        "queued_seconds": detail.queued_seconds,
        "execution_seconds": detail.execution_seconds,
        "images": outputs.iter().map(|i| image_json(ctx, i)).collect::<Vec<_>>(),
    })
}

/// Text + structured summary of jobs, with embedded previews of completed outputs.
async fn render_jobs(
    ctx: &ToolContext,
    job_ids: &[i64],
    notes: Vec<String>,
    previews: bool,
) -> Result<ToolOutput, AppError> {
    let mut lines = notes;
    let mut jobs_json = Vec::new();
    let mut all_images = Vec::new();
    let mut unfinished = Vec::new();
    for &id in job_ids {
        let detail = image_jobs::user_job_detail(&ctx.state, id, ctx.user_id).await?;
        let outputs = job_outputs(&detail);
        lines.push(job_line(&detail, outputs.len()));
        // The prompt the model actually got, whenever substitution changed it
        // (placeholders, including `{?}` resolved at job creation).
        if prompt_template(&detail.job).is_some_and(|t| t.trim() != detail.job.prompt.trim()) {
            lines.push(format!("  prompt: {}", detail.job.prompt));
        }
        for img in &outputs {
            lines.push(format!(
                "  image {} ({}×{}): {}",
                img.image_id,
                img.width,
                img.height,
                super::super::files::signed_file_url(ctx, img.image_id)
            ));
        }
        if !is_terminal(&detail.job.status) {
            unfinished.push(id.to_string());
        }
        jobs_json.push(job_json(ctx, &detail, &outputs));
        all_images.extend(outputs);
    }
    if !unfinished.is_empty() {
        lines.push(format!(
            "Still running: {}. It continues in the background — call get_image_job (with \
             wait_seconds) to fetch the result; don't submit again.",
            unfinished.join(", ")
        ));
    }

    let mut out = ToolOutput::new();
    let mut embedded = 0;
    if previews && !all_images.is_empty() {
        embedded = embed_previews(ctx, &mut out, &all_images).await;
        if embedded < all_images.len() {
            lines.push(format!(
                "Previews shown for {embedded} of {} images (result size limit); use view_image or the links for the rest.",
                all_images.len()
            ));
        }
    }
    if !all_images.is_empty() {
        lines
            .push("Links are valid for a limited time; they open the full-resolution file.".into());
    }
    // Text first, previews after.
    let mut result = ToolOutput::text(lines.join("\n"));
    result.append(out);
    result.set_structured(json!({ "jobs": jobs_json, "previews_embedded": embedded }));
    Ok(result)
}

// ── Job management ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GetJobArgs {
    job_id: Id,
    #[serde(default)]
    wait_seconds: Option<u64>,
    #[serde(default)]
    include_previews: Option<bool>,
}

async fn get_job(ctx: &ToolContext, a: GetJobArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, 0)?;
    // Ownership check first, so an unknown ID is a clean "not found".
    image_jobs::user_job_detail(&ctx.state, a.job_id.0, ctx.user_id).await?;
    wait_for_jobs(ctx, &[a.job_id.0], wait).await;
    render_jobs(
        ctx,
        &[a.job_id.0],
        Vec::new(),
        a.include_previews.unwrap_or(true),
    )
    .await
}

#[derive(Deserialize)]
struct ListJobsArgs {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    active_only: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn list_jobs(ctx: &ToolContext, a: ListJobsArgs) -> Result<ToolOutput, AppError> {
    let limit = a
        .limit
        .unwrap_or(LIST_DEFAULT_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let wanted: Vec<String> = a
        .status
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let details =
        image_jobs::list_user_job_details(&ctx.state, ctx.user_id, LIST_MAX_LIMIT as u64).await?;
    let kept: Vec<&JobDetail> = details
        .iter()
        .filter(|d| {
            wanted.is_empty() || wanted.iter().any(|w| w.eq_ignore_ascii_case(&d.job.status))
        })
        .filter(|d| !a.active_only.unwrap_or(false) || !is_terminal(&d.job.status))
        .take(limit)
        .collect();
    if kept.is_empty() {
        return Ok(ToolOutput::text("No matching image jobs."));
    }
    let mut lines = Vec::new();
    let mut jobs = Vec::new();
    for d in &kept {
        let outputs = job_outputs(d);
        let prompt: String = d.job.prompt.chars().take(100).collect();
        let ellipsis = if d.job.prompt.chars().count() > 100 {
            "…"
        } else {
            ""
        };
        lines.push(format!(
            "{} | {} | {} | {} | {}{ellipsis}",
            d.job.created_at.format("%Y-%m-%d %H:%M"),
            job_line(d, outputs.len()),
            d.job.capability,
            d.job.workflow,
            prompt,
        ));
        jobs.push(job_json(ctx, d, &outputs));
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "jobs": jobs }));
    Ok(out)
}

#[derive(Deserialize)]
struct JobIdsArgs {
    job_ids: Vec<Id>,
}

async fn cancel_jobs(ctx: &ToolContext, a: JobIdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.job_ids, "job_id")?;
    let mut lines = Vec::new();
    let mut results = Vec::new();
    for Id(id) in a.job_ids {
        match image_jobs::cancel_job(&ctx.state, ctx.user_id, id).await {
            Ok(o) => {
                lines.push(
                    format!("Job {id}: {} {}", o.status, o.message)
                        .trim_end()
                        .to_string(),
                );
                results.push(json!({ "job_id": id.to_string(), "ok": true, "status": o.status }));
            }
            Err(e) => {
                lines.push(format!("Job {id}: not canceled — {}", error_text(&e)));
                results.push(
                    json!({ "job_id": id.to_string(), "ok": false, "error": error_text(&e) }),
                );
            }
        }
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "results": results }));
    Ok(out)
}

async fn delete_jobs(ctx: &ToolContext, a: JobIdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.job_ids, "job_id")?;
    let mut lines = Vec::new();
    let mut results = Vec::new();
    for Id(id) in a.job_ids {
        match image_jobs::delete_job(&ctx.state, ctx.user_id, id).await {
            Ok(()) => {
                lines.push(format!("Job {id}: deleted"));
                results.push(json!({ "job_id": id.to_string(), "ok": true }));
            }
            Err(e) => {
                lines.push(format!("Job {id}: not deleted — {}", error_text(&e)));
                results.push(
                    json!({ "job_id": id.to_string(), "ok": false, "error": error_text(&e) }),
                );
            }
        }
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "results": results }));
    Ok(out)
}

#[derive(Deserialize)]
struct RetryArgs {
    job_id: Id,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn retry_job(ctx: &ToolContext, a: RetryArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let new_id = image_jobs::retry_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_jobs(ctx, &[new_id], wait).await;
    render_jobs(
        ctx,
        &[new_id],
        vec![format!("Resubmitted job {} as job {new_id}.", a.job_id.0)],
        true,
    )
    .await
}

// ── Viewing ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ViewArgs {
    image_id: Id,
    #[serde(default)]
    size: Option<String>,
}

/// Preview sizes tried in order until one fits the result budget.
const PREVIEW_STEPS: &[(u32, u8)] = &[(1024, 80), (768, 75), (512, 70)];

async fn view_image(ctx: &ToolContext, a: ViewArgs) -> Result<ToolOutput, AppError> {
    let file = image_generation::get_image_file(&ctx.state.db, a.image_id.0, ctx.user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let view = ImageView::from_file(&file);
    let url = super::super::files::signed_file_url(ctx, view.image_id);
    let mut header = format!(
        "Image {} ({}×{}, {}): {url}",
        view.image_id, view.width, view.height, view.content_type
    );
    let mut out = ToolOutput::new();

    let thumbnail_only = view.is_video() || a.size.as_deref() == Some("thumbnail");
    let mut shown = false;
    if !thumbnail_only {
        let (bytes, _) = image_jobs::image_bytes(&ctx.state, ctx.user_id, view.image_id).await?;
        for &(edge, quality) in PREVIEW_STEPS {
            let Some(jpeg) = image_processing::downscaled_jpeg_async(bytes.clone(), edge, quality)
                .await
                .log_warn("mcp view preview")
            else {
                break;
            };
            if out.push_jpeg(&jpeg) {
                header.push_str(&format!("\nShown at up to {edge} px."));
                shown = true;
                break;
            }
        }
    }
    if !shown && embed_previews(ctx, &mut out, std::slice::from_ref(&view)).await == 1 {
        header.push_str("\nShown as a thumbnail.");
    }
    let mut result = ToolOutput::text(header);
    result.append(out);
    result.set_structured(image_json(ctx, &view));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(base: &str, online: bool, tags: &[&str]) -> LlmCapabilityInfo {
        LlmCapabilityInfo {
            base: base.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            raw: base.into(),
            online,
            last_available_at: String::new(),
            usage_count: 0,
        }
    }

    #[test]
    fn model_picking_follows_the_cli() {
        let caps = vec![
            cap("imggen.video", true, &["img2video"]),
            cap("imggen.off", false, &["txt2img"]),
            cap("imggen.flux", true, &["txt2img", "img2img"]),
        ];
        assert_eq!(pick_model(&caps, "txt2img").unwrap(), "imggen.flux");
        assert_eq!(pick_model(&caps, "img2video").unwrap(), "imggen.video");
        // No online model with the tag: first online one.
        assert_eq!(pick_model(&caps, "inpaint").unwrap(), "imggen.video");
        let offline = vec![cap("imggen.off", false, &["txt2img"])];
        let err = pick_model(&offline, "txt2img").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(m) if m.contains("imggen.off (offline)")));
        assert!(pick_model(&[], "txt2img").is_err());
    }

    #[test]
    fn wait_is_capped() {
        assert_eq!(wait_duration(None, 7).unwrap(), Duration::from_secs(7));
        assert!(wait_duration(Some(MAX_WAIT_SECS + 1), 0).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn zero_wait_never_polls() {
        wait_for_jobs_with(&[1], Duration::ZERO, |_| async {
            panic!("zero wait must return stored state without polling")
        })
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_poll_stops_at_the_deadline_without_starting_the_next_job() {
        let started = tokio::time::Instant::now();
        let wait = Duration::from_secs(10);
        let mut polled = Vec::new();
        wait_for_jobs_with(&[1, 2], wait, |id| {
            polled.push(id);
            std::future::pending()
        })
        .await;
        assert_eq!(polled, [1]);
        assert_eq!(started.elapsed(), wait);
    }

    #[tokio::test(start_paused = true)]
    async fn batch_polls_share_one_deadline() {
        let started = tokio::time::Instant::now();
        let wait = Duration::from_secs(10);
        let mut polled = Vec::new();
        wait_for_jobs_with(&[1, 2], wait, |id| {
            polled.push(id);
            async move {
                if id == 1 {
                    tokio::time::sleep(Duration::from_secs(6)).await;
                    Ok(true)
                } else {
                    std::future::pending().await
                }
            }
        })
        .await;
        assert_eq!(polled, [1, 2]);
        assert_eq!(started.elapsed(), wait);
    }

    #[tokio::test(start_paused = true)]
    async fn completed_jobs_are_not_polled_again() {
        let started = tokio::time::Instant::now();
        let mut polled = Vec::new();
        let mut second_job_ready = false;
        wait_for_jobs_with(&[1, 2], Duration::from_secs(20), |id| {
            polled.push(id);
            let done = id == 1 || second_job_ready;
            second_job_ready = id == 2;
            std::future::ready(Ok(done))
        })
        .await;
        assert_eq!(polled, [1, 2, 2]);
        assert_eq!(started.elapsed(), POLL_INTERVAL);
    }

    #[test]
    fn durations_format_compactly() {
        assert_eq!(fmt_secs(4.4), "4s");
        assert_eq!(fmt_secs(75.0), "1m15s");
    }
}
