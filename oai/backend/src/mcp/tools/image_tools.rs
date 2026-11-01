//! Image Tools — `oai img-utils tools|run|jobs|job|poll|cancel|retry|delete` and the
//! `oai upscale` shortcut over `services::img_utils`. One image in, one image out, no
//! prompt: upscale, depth map, face swap and the built-in basic resize.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    db::{image_generation, img_utils::ImgUtilsJob},
    error::AppError,
    offload::task_status::is_terminal,
    services::img_utils::{self, ImgUtilCapability, KIND_COMFY, KIND_RESIZE, RESIZE_WORKFLOW},
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

/// Upscale `scale_multiplier` bounds. The default is 2 (the web UI's page defaults to 4),
/// matching `defaultScaleMultiplier` in the CLI.
pub const DEFAULT_SCALE_MULTIPLIER: f64 = 2.0;
const MIN_SCALE_MULTIPLIER: f64 = 1.0;
const MAX_SCALE_MULTIPLIER: f64 = 8.0;
/// Images per call; each becomes its own job (like the CLI's multiple inputs).
const MAX_IMAGES: usize = 10;

const TOOLS: &[&str] = &[
    "list_image_tools",
    "run_image_tool",
    "upscale_image",
    "get_image_tool_job",
    "list_image_tool_jobs",
    "cancel_image_tool_jobs",
    "retry_image_tool_job",
    "delete_image_tool_jobs",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_image_tools",
            "List image tools",
            "List the Image Tools that are online right now: one entry per operation (upscale, \
             depth, face_swap, resize, …) with the capability that serves it and which options \
             it takes. Same as `oai img-utils tools`.",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "upscale_image",
            "Upscale image",
            format!(
                "Upscale an image the user already has in OAI (an image_id from an earlier \
                 result, e.g. generate_images) with the online upscaler. scale is the \
                 multiplier, 1-8, default {DEFAULT_SCALE_MULTIPLIER}. Submits one job per \
                 image, waits, and returns a preview plus a signed link to the full-resolution \
                 result. Same as `oai upscale`."
            )
            .as_str(),
            json!({
                "type": "object",
                "properties": {
                    "image_id": { "type": "string", "description": "An image_id from an earlier result in this account." },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_IMAGES, "description": "Several images at once (one job each); alternative to image_id." },
                    "scale": { "type": "number", "minimum": MIN_SCALE_MULTIPLIER, "maximum": MAX_SCALE_MULTIPLIER, "default": DEFAULT_SCALE_MULTIPLIER, "description": "Upscale multiplier." },
                    "capability": { "type": "string", "description": "Pin one img-utils.* capability from list_image_tools. Default: the first online upscaler." },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
            }),
            WRITE,
        ),
        tool(
            "run_image_tool",
            "Run image tool",
            format!(
                "Run an Image Tool on images the user already has in OAI (image_id from an \
                 earlier result). tool is an operation from list_image_tools: upscale \
                 (scale, default {DEFAULT_SCALE_MULTIPLIER}), depth, face_swap (needs \
                 source_image_id, the face to use) or resize (scale, or width and/or height). \
                 Submits one job per image, waits, and returns previews and signed links. \
                 Same as `oai img-utils run`."
            )
            .as_str(),
            json!({
                "type": "object",
                "properties": {
                    "tool": { "type": "string", "description": "Operation name: upscale, depth, face_swap, resize (or a pack/capability name)." },
                    "image_id": { "type": "string", "description": "An image_id from an earlier result in this account." },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_IMAGES, "description": "Several images at once (one job each); alternative to image_id." },
                    "source_image_id": { "type": "string", "description": "Second image for tools that need one (face_swap: the face to use)." },
                    "capability": { "type": "string", "description": "Pin one capability from list_image_tools. Default: the first online one offering the tool." },
                    "scale": { "type": "number", "description": format!("upscale: multiplier {MIN_SCALE_MULTIPLIER}-{MAX_SCALE_MULTIPLIER} (default {DEFAULT_SCALE_MULTIPLIER}); resize: scale factor (max 4).") },
                    "width": { "type": "integer", "description": "resize: target width." },
                    "height": { "type": "integer", "description": "resize: target height." },
                    "mode": { "type": "string", "enum": ["fit", "exact", "cover"], "description": "resize: fit (default), exact or cover (exact/cover need width and height)." },
                    "method": { "type": "string", "description": "resize: resampling filter (see list_image_tools)." },
                    "format": { "type": "string", "enum": ["png", "jpeg", "webp", "bmp", "tiff"], "description": "resize: output format." },
                    "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "resize: quality for lossy formats." },
                    "allow_upscale": { "type": "boolean", "description": "resize: allow making the image larger." },
                    "options": { "type": "object", "description": "Extra workflow options for ComfyUI tools, sent as-is (the CLI's -opt key=value)." },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
                "required": ["tool"],
            }),
            WRITE,
        ),
        tool(
            "get_image_tool_job",
            "Get image tool job",
            "Check an Image Tools job: refreshes its state from the GPU queue and returns status, \
             timing, error, and — once completed — a preview and link of the result. Optionally \
             waits for it to finish. Same as `oai img-utils job|poll|download`.",
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
            "list_image_tool_jobs",
            "List image tool jobs",
            "List the user's recent Image Tools jobs (newest first, at most 100), optionally \
             filtered by status. Same as `oai img-utils jobs`.",
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
            "cancel_image_tool_jobs",
            "Cancel image tool jobs",
            "Cancel queued or running Image Tools jobs. Cancellation is asynchronous. Same as \
             `oai img-utils cancel`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_image_tool_job",
            "Retry image tool job",
            "Run a failed or canceled Image Tools job again with the same images and options, as \
             a new job (completed jobs can't be retried: run the tool again instead). Waits \
             like run_image_tool. Same as `oai img-utils retry`.",
            json!({
                "type": "object",
                "properties": { "job_id": { "type": "string" }, "wait_seconds": wait_schema(DEFAULT_WAIT_SECS) },
                "required": ["job_id"],
            }),
            WRITE,
        ),
        tool(
            "delete_image_tool_jobs",
            "Delete image tool jobs",
            "Permanently delete Image Tools jobs and the result image each produced (the input \
             image is kept). Same as `oai img-utils delete`.",
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
        "list_image_tools" => list_tools(ctx).await,
        "run_image_tool" => {
            let a: RunArgs = parse_args(args)?;
            let tool = a
                .tool
                .clone()
                .filter(|t| !t.trim().is_empty())
                .ok_or_else(|| AppError::BadRequest("tool is required".into()))?;
            run(ctx, &tool, a).await
        }
        "upscale_image" => run(ctx, "upscale", parse_args(args)?).await,
        "get_image_tool_job" => get_job(ctx, parse_args(args)?).await,
        "list_image_tool_jobs" => list_jobs(ctx, parse_args(args)?).await,
        "cancel_image_tool_jobs" => cancel_jobs(ctx, parse_args(args)?).await,
        "retry_image_tool_job" => retry_job(ctx, parse_args(args)?).await,
        "delete_image_tool_jobs" => delete_jobs(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

// ── Tool resolution (the CLI's toolsFromCapabilities / pickImgTool) ─────────────

/// One pack/operation pair — what a caller picks.
#[derive(Debug, Clone, PartialEq)]
struct ImgTool {
    capability: String,
    pack: String,
    workflow: String,
    kind: &'static str,
    needs_source: bool,
    takes_scale: bool,
    methods: Vec<String>,
}

/// face-swap / faceswap / Face_Swap all name face_swap.
fn normalize(s: &str) -> String {
    s.trim().to_lowercase().replace(['-', '_'], "")
}

/// Flattens capabilities to one tool per operation, sorted by operation then pack so
/// "first available" is stable.
fn tools_from_capabilities(caps: &[ImgUtilCapability]) -> Vec<ImgTool> {
    let mut tools = Vec::new();
    for c in caps {
        let fallback = [c.utility.clone()];
        let workflows = if c.workflows.is_empty() {
            &fallback[..]
        } else {
            &c.workflows[..]
        };
        for wf in workflows {
            let comfy = c.kind == KIND_COMFY;
            tools.push(ImgTool {
                capability: c.base.clone(),
                pack: c.utility.clone(),
                workflow: wf.clone(),
                kind: c.kind,
                needs_source: comfy && normalize(wf).starts_with("faceswap"),
                takes_scale: comfy && wf.starts_with("upscale"),
                methods: c.methods.clone(),
            });
        }
    }
    tools.sort_by(|a, b| (&a.workflow, &a.pack).cmp(&(&b.workflow, &b.pack)));
    tools
}

/// Resolves an operation (upscale, depth, face_swap, resize), pack or capability name to
/// the first online match, optionally restricted to one capability. Never falls back to
/// another operation, so nothing is uploaded or submitted when the tool isn't online.
fn pick_tool<'a>(
    tools: &'a [ImgTool],
    name: &str,
    capability: Option<&str>,
) -> Result<&'a ImgTool, AppError> {
    let mut key = normalize(name);
    if key == "resize" {
        key = normalize(RESIZE_WORKFLOW);
    }
    if let Some(t) = tools.iter().find(|t| {
        capability.is_none_or(|c| t.capability == c)
            && (normalize(&t.workflow) == key
                || normalize(&t.pack) == key
                || normalize(&t.capability) == key)
    }) {
        return Ok(t);
    }
    let on = capability.map(|c| format!(" on {c}")).unwrap_or_default();
    if tools.is_empty() {
        return Err(AppError::BadRequest(format!(
            "no {name} tool is available{on}: no Image Tools capability is online"
        )));
    }
    let mut online: Vec<&str> = tools.iter().map(|t| t.workflow.as_str()).collect();
    online.dedup();
    Err(AppError::BadRequest(format!(
        "no {name} tool is available{on}; online tools: {}",
        online.join(", ")
    )))
}

async fn online_tools(ctx: &ToolContext) -> Result<Vec<ImgTool>, AppError> {
    let caps = img_utils::list_capabilities(&ctx.state).await?;
    Ok(tools_from_capabilities(&caps))
}

/// Resolve generation's optional upscale before submitting any base images.
pub(super) async fn generation_upscaler(
    ctx: &ToolContext,
    scale: Option<f64>,
    model: Option<&str>,
) -> Result<Option<crate::services::image_pipeline_params::UpscaleParams>, AppError> {
    let Some(scale) = scale else {
        if model.is_some() {
            return Err(AppError::BadRequest("upscale_model requires upscale_factor".into()));
        }
        return Ok(None);
    };
    if !scale.is_finite() || !(MIN_SCALE_MULTIPLIER..=MAX_SCALE_MULTIPLIER).contains(&scale) {
        return Err(AppError::BadRequest("upscale_factor must be between 1 and 8".into()));
    }
    let tools = online_tools(ctx).await?;
    let selected = pick_tool(&tools, "upscale", model)?;
    let params = crate::services::image_pipeline_params::UpscaleParams {
        capability: selected.capability.clone(),
        workflow: selected.workflow.clone(),
        scale,
    };
    params.validate()?;
    Ok(Some(params))
}

fn tool_notes(t: &ImgTool) -> Vec<String> {
    let mut notes = Vec::new();
    if t.needs_source {
        notes.push("needs source_image_id (the face to use)".to_string());
    }
    if t.takes_scale {
        notes.push(format!(
            "scale {MIN_SCALE_MULTIPLIER}-{MAX_SCALE_MULTIPLIER} (default {DEFAULT_SCALE_MULTIPLIER})"
        ));
    }
    if t.kind == KIND_RESIZE {
        notes.push(format!(
            "scale, or width/height; mode, format, quality, allow_upscale; methods: {}",
            t.methods.join(", ")
        ));
    }
    notes
}

async fn list_tools(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let tools = online_tools(ctx).await?;
    if tools.is_empty() {
        return Ok(ToolOutput::text("No Image Tools are online."));
    }
    let mut lines = vec!["Image tools online now:".to_string()];
    for t in &tools {
        let notes = tool_notes(t);
        lines.push(format!(
            "- {} — {}{}",
            t.workflow,
            t.capability,
            if notes.is_empty() {
                String::new()
            } else {
                format!(" ({})", notes.join("; "))
            }
        ));
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({
        "tools": tools.iter().map(|t| json!({
            "tool": t.workflow, "capability": t.capability, "pack": t.pack, "kind": t.kind,
            "needs_source_image": t.needs_source, "takes_scale": t.takes_scale,
            "methods": t.methods,
        })).collect::<Vec<_>>(),
    }));
    Ok(out)
}

// ── Run ──────────────────────────────────────────────────────────────────────

/// Arguments of `run_image_tool`; `upscale_image` parses the same struct and simply
/// doesn't advertise the resize knobs.
#[derive(Deserialize)]
struct RunArgs {
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    capability: Option<String>,
    #[serde(default)]
    image_id: Option<Id>,
    #[serde(default)]
    image_ids: Vec<Id>,
    #[serde(default)]
    source_image_id: Option<Id>,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    height: Option<i64>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    quality: Option<i64>,
    #[serde(default)]
    allow_upscale: Option<bool>,
    #[serde(default)]
    options: Option<Map<String, Value>>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

/// Whole numbers are sent as integers (2, not 2.0), as the web UI and CLI do.
fn number_value(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// Builds the job's options for the chosen tool, rejecting arguments that don't apply to
/// it (resize knobs on a ComfyUI tool and vice versa) — the CLI's `imgToolOptions`.
fn build_options(tool: &ImgTool, a: &RunArgs) -> Result<Option<Map<String, Value>>, AppError> {
    let bad = |m: String| Err(AppError::BadRequest(m));
    let mut options = a.options.clone().unwrap_or_default();

    if tool.kind == KIND_RESIZE {
        if !options.is_empty() {
            return bad(
                "options is for ComfyUI tools; resize takes scale, width, height, \
                        mode, method, format, quality and allow_upscale"
                    .into(),
            );
        }
        if let Some(w) = a.width {
            options.insert("width".into(), json!(w));
        }
        if let Some(h) = a.height {
            options.insert("height".into(), json!(h));
        }
        if let Some(s) = a.scale {
            options.insert("scale".into(), number_value(s));
        }
        for (key, v) in [
            ("mode", &a.mode),
            ("method", &a.method),
            ("format", &a.format),
        ] {
            if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
                options.insert(key.into(), json!(v));
            }
        }
        if let Some(q) = a.quality {
            options.insert("quality".into(), json!(q));
        }
        if let Some(u) = a.allow_upscale {
            options.insert("allow_upscale".into(), json!(u));
        }
        if options.is_empty() {
            return bad("resize needs a size: scale, or width and/or height".into());
        }
        return Ok(Some(options)); // the server validates and normalizes these
    }

    for (name, set) in [
        ("width", a.width.is_some()),
        ("height", a.height.is_some()),
        ("mode", a.mode.is_some()),
        ("method", a.method.is_some()),
        ("format", a.format.is_some()),
        ("quality", a.quality.is_some()),
        ("allow_upscale", a.allow_upscale.is_some()),
    ] {
        if set {
            return bad(format!(
                "{name} only applies to resize, not {}",
                tool.workflow
            ));
        }
    }
    if tool.takes_scale {
        let scale = a.scale.unwrap_or(DEFAULT_SCALE_MULTIPLIER);
        if !(MIN_SCALE_MULTIPLIER..=MAX_SCALE_MULTIPLIER).contains(&scale) {
            return bad(format!(
                "scale must be between {MIN_SCALE_MULTIPLIER} and {MAX_SCALE_MULTIPLIER}"
            ));
        }
        // An explicit options.scale_multiplier wins, like the CLI's -opt.
        options
            .entry("scale_multiplier")
            .or_insert_with(|| number_value(scale));
    } else if a.scale.is_some() {
        return bad(format!("{} takes no scale", tool.workflow));
    }
    Ok((!options.is_empty()).then_some(options))
}

async fn owned_image(ctx: &ToolContext, what: &str, id: i64) -> Result<(), AppError> {
    image_generation::get_image_file(&ctx.state.db, id, ctx.user_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| AppError::BadRequest(format!("{what} {id} not found")))
}

async fn run(ctx: &ToolContext, tool_name: &str, a: RunArgs) -> Result<ToolOutput, AppError> {
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

    // Resolve and validate everything before submitting: a tool that isn't online or a
    // bad option must not leave half a batch queued.
    let tools = online_tools(ctx).await?;
    let capability = a
        .capability
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let tool = pick_tool(&tools, tool_name, capability)?;
    let options = build_options(tool, &a)?;
    if tool.needs_source && a.source_image_id.is_none() {
        return Err(AppError::BadRequest(format!(
            "{} needs a second image: pass source_image_id (the face to use)",
            tool.workflow
        )));
    }
    if !tool.needs_source && a.source_image_id.is_some() {
        return Err(AppError::BadRequest(format!(
            "{} takes no source_image_id",
            tool.workflow
        )));
    }
    for &id in &image_ids {
        owned_image(ctx, "image", id).await?;
    }
    if let Some(Id(id)) = a.source_image_id {
        owned_image(ctx, "source image", id).await?;
    }

    let mut notes = vec![format!("Using {} on {}", tool.workflow, tool.capability)];
    if tool.takes_scale {
        let scale = options
            .as_ref()
            .and_then(|o| o.get("scale_multiplier"))
            .map(Value::to_string)
            .unwrap_or_default();
        notes.push(format!("Upscale ×{scale}"));
    }

    let mut job_ids = Vec::new();
    let mut submit_error = None;
    for (i, &input) in image_ids.iter().enumerate() {
        let params = img_utils::StartJobParams {
            capability: tool.capability.clone(),
            workflow: Some(tool.workflow.clone()),
            input_image_id: input,
            source_image_id: a.source_image_id.map(|s| s.0),
            options: options.clone(),
        };
        match img_utils::start_job(&ctx.state, ctx.user_id, params).await {
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

// ── Waiting & rendering ──────────────────────────────────────────────────────

async fn wait_for_jobs(ctx: &ToolContext, job_ids: &[i64], wait: Duration) {
    wait_for_jobs_with(job_ids, wait, |id| async move {
        img_utils::poll_job(&ctx.state, ctx.user_id, id)
            .await
            .map(|j| is_terminal(&j.status))
    })
    .await;
}

fn job_line(job: &ImgUtilsJob) -> String {
    let mut line = format!("Job {} ({}) — {}", job.id, job.workflow, job.status);
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
            None => line.push_str(", waiting for a GPU worker"),
        },
    }
    line
}

fn job_json(ctx: &ToolContext, job: &ImgUtilsJob, output: Option<&ImageView>) -> Value {
    json!({
        "job_id": job.id.to_string(),
        "status": job.status,
        "error": job.error,
        "tool": job.workflow,
        "capability": job.capability,
        "options": img_utils::parse_options(job.options_json.as_deref()),
        "input_image_id": job.input_image_id.map(|i| i.to_string()),
        "source_image_id": job.source_image_id.map(|i| i.to_string()),
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
        let job = img_utils::get_user_job(&ctx.state, ctx.user_id, id).await?;
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
                "  result image {} ({}×{}): {}",
                img.image_id,
                img.width,
                img.height,
                super::super::files::signed_file_url(ctx, img.image_id)
            ));
        }
        if !is_terminal(&job.status) {
            unfinished.push(id.to_string());
        }
        jobs_json.push(job_json(ctx, &job, output.as_ref()));
        all_images.extend(output);
    }
    if !unfinished.is_empty() {
        lines.push(format!(
            "Still running: {}. It continues in the background — call get_image_tool_job (with \
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
    img_utils::get_user_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
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
    let jobs = img_utils::list_user_jobs(&ctx.state, ctx.user_id, 100).await?;
    let kept: Vec<&ImgUtilsJob> = jobs
        .iter()
        .filter(|j| wanted.is_empty() || wanted.iter().any(|w| w.eq_ignore_ascii_case(&j.status)))
        .filter(|j| !a.active_only.unwrap_or(false) || !is_terminal(&j.status))
        .take(limit)
        .collect();
    if kept.is_empty() {
        return Ok(ToolOutput::text("No matching image tool jobs."));
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
                    " | result {out_id}: {}",
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
        match img_utils::cancel_job(&ctx.state, ctx.user_id, id).await {
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
        match img_utils::delete_job(&ctx.state, ctx.user_id, id).await {
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
    let new_id = img_utils::retry_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
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

    fn cap(base: &str, workflows: &[&str], kind: &'static str) -> ImgUtilCapability {
        ImgUtilCapability {
            base: base.into(),
            utility: base.strip_prefix("img-utils.").unwrap_or(base).into(),
            workflows: workflows.iter().map(|w| w.to_string()).collect(),
            raw: base.into(),
            needs_source_image: false,
            kind,
            methods: if kind == KIND_RESIZE {
                vec!["lanczos".into()]
            } else {
                Vec::new()
            },
        }
    }

    fn online() -> Vec<ImgTool> {
        tools_from_capabilities(&[
            cap("image_resize", &[RESIZE_WORKFLOW], KIND_RESIZE),
            cap("img-utils.lotus", &["depth"], KIND_COMFY),
            cap("img-utils.seedvr2", &["upscale"], KIND_COMFY),
            cap("img-utils.reactor", &["face_swap"], KIND_COMFY),
        ])
    }

    fn args(v: Value) -> RunArgs {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn tools_are_one_per_operation_and_sorted() {
        let names: Vec<_> = online().into_iter().map(|t| t.workflow).collect();
        assert_eq!(names, ["basic_resize", "depth", "face_swap", "upscale"]);
        let tools = online();
        assert!(
            tools
                .iter()
                .find(|t| t.workflow == "face_swap")
                .unwrap()
                .needs_source
        );
        assert!(
            tools
                .iter()
                .find(|t| t.workflow == "upscale")
                .unwrap()
                .takes_scale
        );
        assert!(
            !tools
                .iter()
                .find(|t| t.kind == KIND_RESIZE)
                .unwrap()
                .takes_scale
        );
    }

    #[test]
    fn picking_accepts_aliases_and_never_falls_back() {
        let tools = online();
        assert_eq!(
            pick_tool(&tools, "upscale", None).unwrap().capability,
            "img-utils.seedvr2"
        );
        assert_eq!(
            pick_tool(&tools, "Face-Swap", None).unwrap().workflow,
            "face_swap"
        );
        assert_eq!(
            pick_tool(&tools, "resize", None).unwrap().capability,
            "image_resize"
        );
        assert_eq!(
            pick_tool(&tools, "seedvr2", None).unwrap().workflow,
            "upscale"
        );
        assert!(pick_tool(&tools, "upscale", Some("img-utils.lotus")).is_err());

        let no_upscaler =
            tools_from_capabilities(&[cap("img-utils.lotus", &["depth"], KIND_COMFY)]);
        let err = pick_tool(&no_upscaler, "upscale", None).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(m) if m.contains("online tools: depth")));
        assert!(pick_tool(&[], "upscale", None).is_err());
    }

    #[test]
    fn upscale_defaults_to_two() {
        let tools = online();
        let up = pick_tool(&tools, "upscale", None).unwrap();
        let opts = build_options(up, &args(json!({}))).unwrap().unwrap();
        assert_eq!(opts["scale_multiplier"], json!(2));
        let opts = build_options(up, &args(json!({ "scale": 4 })))
            .unwrap()
            .unwrap();
        assert_eq!(opts["scale_multiplier"], json!(4));
        let opts = build_options(up, &args(json!({ "scale": 1.5 })))
            .unwrap()
            .unwrap();
        assert_eq!(opts["scale_multiplier"], json!(1.5));
        // An explicit workflow option wins over the default.
        let opts = build_options(up, &args(json!({ "options": { "scale_multiplier": 3 } })))
            .unwrap()
            .unwrap();
        assert_eq!(opts["scale_multiplier"], json!(3));
        assert!(build_options(up, &args(json!({ "scale": 9 }))).is_err());
        assert!(build_options(up, &args(json!({ "scale": 0.5 }))).is_err());
    }

    #[test]
    fn options_follow_the_tool_family() {
        let tools = online();
        let depth = pick_tool(&tools, "depth", None).unwrap();
        assert_eq!(build_options(depth, &args(json!({}))).unwrap(), None);
        assert!(build_options(depth, &args(json!({ "scale": 2 }))).is_err());
        assert!(build_options(depth, &args(json!({ "width": 800 }))).is_err());

        let resize = pick_tool(&tools, "resize", None).unwrap();
        assert!(build_options(resize, &args(json!({}))).is_err());
        assert!(
            build_options(resize, &args(json!({ "options": { "x": 1 }, "width": 8 }))).is_err()
        );
        let opts = build_options(
            resize,
            &args(json!({ "width": 800, "scale": 2, "mode": "fit", "format": "webp", "allow_upscale": true })),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            Value::Object(opts),
            json!({ "width": 800, "scale": 2, "mode": "fit", "format": "webp", "allow_upscale": true })
        );
    }

    #[test]
    fn definitions_name_the_default_scale() {
        let defs = definitions();
        let up = defs.iter().find(|d| d["name"] == "upscale_image").unwrap();
        assert_eq!(
            up["inputSchema"]["properties"]["scale"]["default"],
            json!(2.0)
        );
        assert!(up["description"].as_str().unwrap().contains("default 2"));
        for d in &defs {
            assert!(handles(d["name"].as_str().unwrap()));
        }
    }
}
