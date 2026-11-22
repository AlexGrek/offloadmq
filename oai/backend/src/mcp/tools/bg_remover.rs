//! Background Remover — `oai bgremove models|run|jobs|job|poll|cancel|retry|delete|download`
//! over `services::bg_remover`. One image in, one cutout out: a transparent PNG/WebP, or the
//! subject on a flat colour.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    db::{bg_remover::BgRemoverJob, image_generation},
    error::AppError,
    offload::task_status::is_terminal,
    services::bg_remover::{self, BgRemoverOptions, DEFAULT_MODEL},
};

use super::{
    super::content::{ImageView, ToolOutput, embed_previews, image_json},
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, ToolContext, WRITE, error_text,
    images::{
        DEFAULT_WAIT_SECS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, fmt_secs, wait_duration,
        wait_for_jobs_with, wait_schema,
    },
    parse_args, require_ids, tool,
};

/// Images per call; each becomes its own job (like the CLI's multiple inputs).
const MAX_IMAGES: usize = 10;

const TOOLS: &[&str] = &[
    "list_bg_remover_models",
    "remove_background",
    "get_bg_remover_job",
    "list_bg_remover_jobs",
    "cancel_bg_remover_jobs",
    "retry_bg_remover_job",
    "delete_bg_remover_jobs",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_bg_remover_models",
            "List background-removal models",
            format!(
                "List the background-removal models that are online right now (BiRefNet \
                 general, portrait, lite). A model only appears once it is installed on an \
                 agent. The default is {DEFAULT_MODEL}: best all-round, for anime and photos \
                 alike. Same as `oai bgremove models`."
            )
            .as_str(),
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "remove_background",
            "Remove background",
            "Cut the subject out of an image the user already has in OAI (an image_id from an \
             earlier result, e.g. generate_images). The default result is a transparent PNG; \
             format webp is transparent too, and jpeg is flattened onto a colour. \
             background is `transparent` or `#RRGGBB`. crop trims to the subject (padding \
             adds a margin), handy for game sprites. Submits one job per image, waits, and \
             returns a preview plus a signed link to the real file — the preview is a JPEG, so \
             transparency shows as black there; open the link for the true cutout. If the \
             result looks wrong the text says so: try another model (portrait for single \
             people). Same as `oai bgremove run`.",
            json!({
                "type": "object",
                "properties": {
                    "image_id": { "type": "string", "description": "An image_id from an earlier result in this account." },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_IMAGES, "description": "Several images at once (one job each); alternative to image_id." },
                    "model": { "type": "string", "description": format!("A model from list_bg_remover_models, e.g. birefnet-portrait. Default: {DEFAULT_MODEL} when online, else the first online model.") },
                    "format": { "type": "string", "enum": ["png", "webp", "jpeg"], "default": "png", "description": "png and webp keep transparency; jpeg cannot be transparent (it gets a colour, white by default)." },
                    "background": { "type": "string", "default": "transparent", "description": "`transparent` or a #RRGGBB colour to put behind the subject." },
                    "crop": { "type": "boolean", "default": false, "description": "Trim the result to the subject's bounding box." },
                    "padding": { "type": "integer", "minimum": 0, "maximum": 4096, "default": 0, "description": "Margin in pixels around the crop (only with crop)." },
                    "refine_foreground": { "type": "boolean", "default": true, "description": "Clean semi-transparent edge colours so the old background doesn't halo around hair. Turn off for the raw input colours." },
                    "alpha_threshold": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1, "description": "Hard edges: fully opaque or transparent pixels at this cut-off, for engines that cannot blend. Default: soft edges." },
                    "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "webp/jpeg quality." },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
            }),
            WRITE,
        ),
        tool(
            "get_bg_remover_job",
            "Get background removal job",
            "Check a background-removal job: refreshes its state from the queue and returns \
             status, timing, error, the options used, and — once completed — a preview and link \
             of the cutout. Optionally waits for it to finish. Same as `oai bgremove \
             job|poll|download`.",
            json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string" },
                    "wait_seconds": wait_schema(0),
                    "include_previews": { "type": "boolean", "default": true, "description": "Embed a thumbnail preview of the result." },
                },
                "required": ["job_id"],
            }),
            READ_ONLY,
        ),
        tool(
            "list_bg_remover_jobs",
            "List background removal jobs",
            "List the user's recent background-removal jobs (newest first, at most 100), \
             optionally filtered by status. Same as `oai bgremove jobs`.",
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
            "cancel_bg_remover_jobs",
            "Cancel background removal jobs",
            "Cancel queued or running background-removal jobs. Cancellation is asynchronous. \
             Same as `oai bgremove cancel`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_bg_remover_job",
            "Retry background removal job",
            "Run a failed or canceled background-removal job again with the same image, model \
             and options, as a new job (completed jobs can't be retried: run remove_background \
             again, perhaps with another model). Waits like remove_background. Same as `oai \
             bgremove retry`.",
            json!({
                "type": "object",
                "properties": { "job_id": { "type": "string" }, "wait_seconds": wait_schema(DEFAULT_WAIT_SECS) },
                "required": ["job_id"],
            }),
            WRITE,
        ),
        tool(
            "delete_bg_remover_jobs",
            "Delete background removal jobs",
            "Permanently delete background-removal jobs and the cutout each produced (the input \
             image is kept). Same as `oai bgremove delete`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            DESTRUCTIVE,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "list_bg_remover_models" => list_models(ctx).await,
        "remove_background" => run(ctx, parse_args(args)?).await,
        "get_bg_remover_job" => get_job(ctx, parse_args(args)?).await,
        "list_bg_remover_jobs" => list_jobs(ctx, parse_args(args)?).await,
        "cancel_bg_remover_jobs" => cancel_jobs(ctx, parse_args(args)?).await,
        "retry_bg_remover_job" => retry_job(ctx, parse_args(args)?).await,
        "delete_bg_remover_jobs" => delete_jobs(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

// ── Models ───────────────────────────────────────────────────────────────────

async fn list_models(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let caps = bg_remover::list_capabilities(&ctx.state).await?;
    if caps.is_empty() {
        return Ok(ToolOutput::text(
            "No background-removal model is online. Install one on an agent \
             (bgremove-birefnet-general) and rescan its capabilities.",
        ));
    }
    let mut lines = vec!["Background-removal models online now:".to_string()];
    for c in &caps {
        lines.push(format!(
            "- {}{} — {}",
            c.model,
            if c.model == DEFAULT_MODEL { " (default)" } else { "" },
            c.base
        ));
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({
        "models": caps.iter().map(|c| json!({
            "model": c.model, "capability": c.base, "default": c.model == DEFAULT_MODEL,
        })).collect::<Vec<_>>(),
    }));
    Ok(out)
}

// ── Run ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RunArgs {
    #[serde(default)]
    image_id: Option<Id>,
    #[serde(default)]
    image_ids: Vec<Id>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    crop: Option<bool>,
    #[serde(default)]
    padding: Option<u32>,
    #[serde(default)]
    refine_foreground: Option<bool>,
    #[serde(default)]
    alpha_threshold: Option<f64>,
    #[serde(default)]
    quality: Option<u8>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

/// Overlays the arguments that were given on the defaults and validates the result, so a bad
/// option is an error before anything is submitted.
fn build_options(a: &RunArgs) -> Result<BgRemoverOptions, AppError> {
    let mut o = BgRemoverOptions::default();
    if let Some(v) = &a.format {
        o.format = v.clone();
    }
    if let Some(v) = &a.background {
        o.background = v.clone();
    }
    if let Some(v) = a.crop {
        o.crop = v;
    }
    if let Some(v) = a.padding {
        o.padding = v;
    }
    if let Some(v) = a.refine_foreground {
        o.refine_foreground = v;
    }
    o.alpha_threshold = a.alpha_threshold;
    o.quality = a.quality;
    o.normalized()
}

async fn owned_image(ctx: &ToolContext, id: i64) -> Result<(), AppError> {
    image_generation::get_image_file(&ctx.state.db, id, ctx.user_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| AppError::BadRequest(format!("image {id} not found")))
}

async fn run(ctx: &ToolContext, a: RunArgs) -> Result<ToolOutput, AppError> {
    let mut image_ids: Vec<i64> = a.image_ids.iter().map(|i| i.0).collect();
    image_ids.extend(a.image_id.map(|i| i.0));
    if image_ids.is_empty() {
        return Err(AppError::BadRequest(
            "image_id (or image_ids) is required".into(),
        ));
    }
    if image_ids.len() > MAX_IMAGES {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_IMAGES} images per call"
        )));
    }
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;

    // Resolve and validate everything before submitting: a model that isn't online or a bad
    // option must not leave half a batch queued.
    let options = build_options(&a)?;
    let caps = bg_remover::list_capabilities(&ctx.state).await?;
    let cap = bg_remover::pick_capability(&caps, a.model.as_deref())?;
    for &id in &image_ids {
        owned_image(ctx, id).await?;
    }

    let mut notes = vec![format!(
        "Using {} on {} — {}",
        cap.model,
        cap.base,
        describe_options(&options)
    )];

    let mut job_ids = Vec::new();
    let mut submit_error = None;
    for (i, &input) in image_ids.iter().enumerate() {
        let params = bg_remover::StartJobParams {
            capability: cap.base.clone(),
            input_image_id: input,
            options: options.clone(),
        };
        match bg_remover::start_job(&ctx.state, ctx.user_id, params).await {
            Ok(id) => job_ids.push(id),
            Err(e) => {
                submit_error = Some(format!(
                    "submitting job {} of {} failed: {}",
                    i + 1,
                    image_ids.len(),
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
    if let Some(e) = submit_error {
        notes.push(format!("Warning: {e}"));
    }

    wait_for_jobs(ctx, &job_ids, wait).await;
    render_jobs(ctx, &job_ids, notes, true).await
}

/// `PNG, transparent, cropped +16 px` — what a job produces, for the notes and job lines.
fn describe_options(o: &BgRemoverOptions) -> String {
    let mut parts = vec![o.format.to_uppercase()];
    parts.push(if o.background == "transparent" {
        "transparent".to_string()
    } else {
        format!("on {}", o.background)
    });
    if o.crop {
        parts.push(if o.padding > 0 {
            format!("cropped +{} px", o.padding)
        } else {
            "cropped".to_string()
        });
    }
    if let Some(t) = o.alpha_threshold {
        parts.push(format!("hard edges at {t}"));
    }
    if !o.refine_foreground {
        parts.push("raw edge colours".to_string());
    }
    parts.join(", ")
}

// ── Waiting & rendering ──────────────────────────────────────────────────────

async fn wait_for_jobs(ctx: &ToolContext, job_ids: &[i64], wait: Duration) {
    wait_for_jobs_with(job_ids, wait, |id| async move {
        bg_remover::poll_job(&ctx.state, ctx.user_id, id)
            .await
            .map(|j| is_terminal(&j.status))
    })
    .await;
}

fn job_line(job: &BgRemoverJob) -> String {
    let model = job
        .capability
        .strip_prefix(bg_remover::CAPABILITY_PREFIX)
        .unwrap_or(&job.capability);
    let mut line = format!("Job {} ({model}) — {}", job.id, job.status);
    match job.status.as_str() {
        "completed" => {}
        "failed" | "canceled" => {
            if let Some(e) = job.error.as_deref().filter(|e| !e.is_empty()) {
                line.push_str(&format!(": {e}"));
            }
        }
        _ => match job.started_at {
            Some(started) => {
                let ran = (chrono::Utc::now().fixed_offset() - started)
                    .num_seconds()
                    .max(0) as f64;
                line.push_str(&format!(", running for {}", fmt_secs(ran)));
                if let Some(t) = job.typical_runtime_seconds.filter(|t| *t > 0.0) {
                    line.push_str(&format!(" (usually ~{})", fmt_secs(t)));
                }
            }
            None => line.push_str(", waiting for an agent"),
        },
    }
    line
}

/// The hint for a finished job whose result looks wrong, if any.
fn job_warning(job: &BgRemoverJob) -> Option<&'static str> {
    if job.status != "completed" {
        return None;
    }
    let options = BgRemoverOptions::from_stored(job.options_json.as_deref());
    bg_remover::foreground_warning(job.foreground_ratio, options.crop)
}

fn job_json(ctx: &ToolContext, job: &BgRemoverJob, output: Option<&ImageView>) -> Value {
    json!({
        "job_id": job.id.to_string(),
        "status": job.status,
        "error": job.error,
        "model": job
            .capability
            .strip_prefix(bg_remover::CAPABILITY_PREFIX)
            .unwrap_or(&job.capability),
        "capability": job.capability,
        "options": BgRemoverOptions::from_stored(job.options_json.as_deref()),
        "foreground_ratio": job.foreground_ratio,
        "warning": job_warning(job),
        "input_image_id": job.input_image_id.map(|i| i.to_string()),
        "output_image_id": job.output_image_id.map(|i| i.to_string()),
        "created_at": job.created_at.to_rfc3339(),
        "started_at": job.started_at.map(|t| t.to_rfc3339()),
        "typical_runtime_seconds": job.typical_runtime_seconds.filter(|t| *t > 0.0),
        "image": output.map(|i| image_json(ctx, i)),
    })
}

/// Text + structured summary of jobs, with embedded previews of completed results.
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
        let job = bg_remover::get_user_job(&ctx.state, ctx.user_id, id).await?;
        // A result deleted from My Files is just absent, not an error.
        let output = match job.output_image_id {
            Some(out_id) => image_generation::get_image_file(&ctx.state.db, out_id, ctx.user_id)
                .await?
                .map(|f| ImageView::from_file(&f)),
            None => None,
        };
        lines.push(job_line(&job));
        if let Some(img) = &output {
            lines.push(format!(
                "  cutout image {} ({}×{}, {}): {}",
                img.image_id,
                img.width,
                img.height,
                img.content_type,
                super::super::files::signed_file_url(ctx, img.image_id)
            ));
        }
        if let Some(w) = job_warning(&job) {
            lines.push(format!("  Note: {w}"));
        }
        if !is_terminal(&job.status) {
            unfinished.push(id.to_string());
        }
        jobs_json.push(job_json(ctx, &job, output.as_ref()));
        all_images.extend(output);
    }
    if !unfinished.is_empty() {
        lines.push(format!(
            "Still running: {}. It continues in the background — call get_bg_remover_job (with \
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
        lines.push(
            "Links are valid for a limited time; they open the full-resolution file. Previews are \
             JPEG, so transparency shows as black in them."
                .into(),
        );
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
    bg_remover::get_user_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
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
    let jobs = bg_remover::list_user_jobs(&ctx.state, ctx.user_id, 100).await?;
    let kept: Vec<&BgRemoverJob> = jobs
        .iter()
        .filter(|j| wanted.is_empty() || wanted.iter().any(|w| w.eq_ignore_ascii_case(&j.status)))
        .filter(|j| !a.active_only.unwrap_or(false) || !is_terminal(&j.status))
        .take(limit)
        .collect();
    if kept.is_empty() {
        return Ok(ToolOutput::text("No matching background removal jobs."));
    }
    let lines: Vec<String> = kept
        .iter()
        .map(|j| {
            let mut line = format!(
                "{} | {}",
                j.created_at.format("%Y-%m-%d %H:%M"),
                job_line(j)
            );
            if let Some(out_id) = j.output_image_id {
                line.push_str(&format!(
                    " | cutout {out_id}: {}",
                    super::super::files::signed_file_url(ctx, out_id)
                ));
            }
            line
        })
        .collect();
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(
        json!({ "jobs": kept.iter().map(|j| job_json(ctx, j, None)).collect::<Vec<_>>() }),
    );
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
        match bg_remover::cancel_job(&ctx.state, ctx.user_id, id).await {
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
        match bg_remover::delete_job(&ctx.state, ctx.user_id, id).await {
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
    let new_id = bg_remover::retry_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_jobs(ctx, &[new_id], wait).await;
    render_jobs(
        ctx,
        &[new_id],
        vec![format!("Resubmitted job {} as job {new_id}.", a.job_id.0)],
        true,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> RunArgs {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn omitted_arguments_give_a_transparent_png() {
        let o = build_options(&args(json!({}))).unwrap();
        assert_eq!(o, BgRemoverOptions::default());
    }

    #[test]
    fn given_arguments_override_the_defaults_and_are_validated() {
        let o = build_options(&args(
            json!({ "format": "JPG", "background": "2b2b35", "crop": true, "padding": 16, "quality": 90 }),
        ))
        .unwrap();
        assert_eq!(
            (o.format.as_str(), o.background.as_str(), o.crop, o.padding, o.quality),
            ("jpeg", "#2B2B35", true, 16, Some(90))
        );
        // JPEG with no colour gets white rather than failing.
        let o = build_options(&args(json!({ "format": "jpeg" }))).unwrap();
        assert_eq!(o.background, "#FFFFFF");

        assert!(build_options(&args(json!({ "format": "gif" }))).is_err());
        assert!(build_options(&args(json!({ "background": "red" }))).is_err());
        assert!(build_options(&args(json!({ "crop": true, "padding": 5000 }))).is_err());
        assert!(build_options(&args(json!({ "alpha_threshold": 1.0 }))).is_err());
        assert!(build_options(&args(json!({ "format": "webp", "quality": 0 }))).is_err());
    }

    #[test]
    fn options_are_described_for_the_notes() {
        assert_eq!(describe_options(&BgRemoverOptions::default()), "PNG, transparent");
        let o = BgRemoverOptions {
            format: "webp".into(),
            background: "#FFFFFF".into(),
            crop: true,
            padding: 8,
            refine_foreground: false,
            alpha_threshold: Some(0.5),
            quality: None,
        };
        assert_eq!(
            describe_options(&o),
            "WEBP, on #FFFFFF, cropped +8 px, hard edges at 0.5, raw edge colours"
        );
    }

    #[test]
    fn definitions_cover_every_handled_tool() {
        let defs = definitions();
        assert_eq!(defs.len(), TOOLS.len());
        for d in &defs {
            assert!(handles(d["name"].as_str().unwrap()));
        }
        let run = defs.iter().find(|d| d["name"] == "remove_background").unwrap();
        assert_eq!(run["inputSchema"]["properties"]["format"]["default"], "png");
        // Only the tools that change state are not read-only; delete is the destructive one.
        let del = defs.iter().find(|d| d["name"] == "delete_bg_remover_jobs").unwrap();
        assert_eq!(del["annotations"]["destructiveHint"], true);
    }
}
