//! VR Worlds — `oai world models|generate|jobs|job|poll|cancel|retry|delete|download|share`
//! over `services::worlds`. A library image in, a Gaussian-splat world out: too large to
//! return inline, so results are a preview plus signed login-free links to the headset
//! viewer and the PLY.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    db::worlds::WorldJob,
    error::{AppError, ResultExt},
    offload::{LlmCapabilityInfo, task_status::is_terminal},
    services::{
        image_processing, storage,
        worlds::{self, MIRROR_CAPABILITY, PANO360_CAPABILITY, SHARP_CAPABILITY, SPLAT_CAPABILITY, ShareLink},
    },
};

use super::{
    super::content::ToolOutput,
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, ToolContext, WRITE, error_text,
    images::{
        DEFAULT_WAIT_SECS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, MAX_WAIT_SECS, fmt_secs,
        wait_duration, wait_for_jobs_with,
    },
    parse_args, require_ids, tool,
};

const PREVIEW_EDGE: u32 = 512;
const PREVIEW_QUALITY: u8 = 75;

const TOOLS: &[&str] = &[
    "list_world_models",
    "generate_world",
    "get_world_job",
    "list_world_jobs",
    "cancel_world_jobs",
    "retry_world_job",
    "delete_world_jobs",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

fn wait_schema(default: u64) -> Value {
    json!({
        "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS, "default": default,
        "description": format!(
            "Seconds to wait for completion before returning (max {MAX_WAIT_SECS}). 0 returns \
             immediately; unfinished jobs keep running and can be checked with get_world_job."
        ),
    })
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_world_models",
            "List 3D world generators",
            "List the 3D (VR) world generators (world.* capabilities) online right now, the \
             user's most used first, with what each is good at. Same as `oai world models`.",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "generate_world",
            "Generate a 3D world",
            "Turn an image the user already has in OAI (an image_id from an earlier result, \
             e.g. generate_images) into a 3D Gaussian-splat world to look around in, on a \
             screen or a VR headset. Waits, then returns a preview and signed links: the \
             viewer page (no login, has an Enter VR button) and the .ply scene. Takes seconds \
             to a few minutes depending on the generator. Leave model out to use the user's \
             most used online generator that fits the picture and the options. Options a \
             generator would ignore are rejected. Same as `oai world generate`.",
            json!({
                "type": "object",
                "properties": {
                    "image_id": { "type": "string", "description": "An image_id from an earlier result in this account." },
                    "model": { "type": "string", "description": format!("A generator from list_world_models: {SHARP_CAPABILITY} (solid, perspective pictures), {SPLAT_CAPABILITY} (fast, the only one for 2:1 360° panoramas) or {PANO360_CAPABILITY} (paints any picture out to 360°). {MIRROR_CAPABILITY} is an experimental, licence-restricted comparison generator: use it only when the user asks for it. Short names (sharp) work.") },
                    "mode": { "type": "string", "enum": worlds::MODES, "description": "Projection. auto treats a 2:1 picture as a panorama (world.splat only); sharp, pano360 and mirror are always perspective." },
                    "max_width": { "type": "integer", "minimum": 256, "maximum": 2048, "description": "Splat budget as grid width: 1024 (default) suits a Quest headset, 2048 is full detail. Not for world.sharp or world.mirror." },
                    "fill_lean": { "type": "number", "minimum": 0, "maximum": 1, "description": "Head movement in metres the hidden background layer covers (default 0.25). Not for world.sharp or world.mirror." },
                    "hfov": { "type": "number", "minimum": 20, "maximum": 150, "description": "Horizontal field of view of the picture in degrees. Default: chosen by the generator. Not for world.mirror." },
                    "near": { "type": "number", "minimum": 0.1, "maximum": 20, "description": "Nearest depth in metres (default 1.2). Not for world.sharp or world.mirror." },
                    "far": { "type": "number", "minimum": 1, "maximum": 1000, "description": "Farthest depth in metres (default 50). Not for world.sharp or world.mirror." },
                    "prompt": { "type": "string", "maxLength": worlds::MAX_PROMPT_CHARS, "description": format!("{PANO360_CAPABILITY} only: what surrounds the picture. Default: the prompt that generated the image.") },
                    "pitch": { "type": "number", "minimum": -60, "maximum": 60, "description": format!("{PANO360_CAPABILITY} only: camera tilt in degrees, negative = looking down.") },
                    "seed": { "type": "integer", "minimum": 0, "description": format!("{PANO360_CAPABILITY} only: seed for the painted surroundings.") },
                    "cleanup": { "type": "boolean", "description": format!("{MIRROR_CAPABILITY} only: its sky and depth-edge filters (default off; they cut out the sky).") },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
                "required": ["image_id"],
            }),
            WRITE,
        ),
        tool(
            "get_world_job",
            "Get 3D world job",
            "Check a 3D world job: refreshes its state from the queue and returns status, \
             timing, error, the settings used and, once completed, a preview plus fresh signed \
             viewer and .ply links (this is also how to share a world). Optionally waits for it \
             to finish. Same as `oai world job|poll|share|download`.",
            json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string" },
                    "wait_seconds": wait_schema(0),
                    "include_previews": { "type": "boolean", "default": true, "description": "Embed a preview picture of the world." },
                },
                "required": ["job_id"],
            }),
            READ_ONLY,
        ),
        tool(
            "list_world_jobs",
            "List 3D world jobs",
            "List the user's recent 3D world jobs (newest first, at most 100), optionally \
             filtered by status. Same as `oai world jobs`.",
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
            "cancel_world_jobs",
            "Cancel 3D world jobs",
            "Cancel queued or running 3D world jobs. Cancellation is asynchronous. Same as \
             `oai world cancel`.",
            json!({
                "type": "object",
                "properties": { "job_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["job_ids"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_world_job",
            "Retry 3D world job",
            "Build a failed or canceled 3D world again with the same image, generator and \
             settings, as a new job (completed jobs can't be retried: run generate_world \
             again). Waits like generate_world. Same as `oai world retry`.",
            json!({
                "type": "object",
                "properties": { "job_id": { "type": "string" }, "wait_seconds": wait_schema(DEFAULT_WAIT_SECS) },
                "required": ["job_id"],
            }),
            WRITE,
        ),
        tool(
            "delete_world_jobs",
            "Delete 3D world jobs",
            "Permanently delete finished 3D world jobs and their scenes (shared links stop \
             working; the input image is kept). Cancel a running job first. Same as `oai world \
             delete`.",
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
        "list_world_models" => list_models(ctx).await,
        "generate_world" => generate(ctx, parse_args(args)?).await,
        "get_world_job" => get_job(ctx, parse_args(args)?).await,
        "list_world_jobs" => list_jobs(ctx, parse_args(args)?).await,
        "cancel_world_jobs" => cancel_jobs(ctx, parse_args(args)?).await,
        "retry_world_job" => retry_job(ctx, parse_args(args)?).await,
        "delete_world_jobs" => delete_jobs(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

// ── Generators ───────────────────────────────────────────────────────────────

fn about(base: &str) -> &'static str {
    match base {
        SHARP_CAPABILITY => "Apple SHARP: solid and metric, perspective pictures only",
        SPLAT_CAPABILITY => "Lotus depth: fast, handles 2:1 360° panoramas",
        PANO360_CAPABILITY => "WorldGen: paints any picture out to a full 360° world (slowest)",
        MIRROR_CAPABILITY => "WorldMirror 2.0 (experimental): gaps open behind objects when leaning; not licensed in the EU, UK or South Korea",
        _ => "3D world generator",
    }
}

fn model_line(c: &LlmCapabilityInfo) -> String {
    let mut line = format!("- {} — {}", c.base, about(&c.base));
    if c.usage_count > 0 {
        line.push_str(&format!(", used in {} of your last 20 worlds", c.usage_count));
    }
    line
}

async fn list_models(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let caps = worlds::list_capabilities(&ctx.state, ctx.user_id).await?;
    if caps.is_empty() {
        return Ok(ToolOutput::text(
            "No 3D world generator is online. An agent needs a world.* capability.",
        ));
    }
    let mut lines = vec!["3D world generators online now, most used first:".to_string()];
    lines.extend(caps.iter().map(model_line));
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({
        "models": caps.iter().map(|c| json!({
            "model": c.base, "tags": c.tags, "usage_count": c.usage_count,
        })).collect::<Vec<_>>(),
    }));
    Ok(out)
}

// ── Generate ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GenerateArgs {
    image_id: Id,
    #[serde(default)]
    model: Option<String>,
    #[serde(flatten)]
    params: worlds::WorldParamsInput,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn generate(ctx: &ToolContext, a: GenerateArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let id = worlds::submit_job(
        &ctx.state,
        ctx.user_id,
        worlds::StartJobParams {
            capability: a.model.unwrap_or_default(),
            input_image_id: a.image_id.0,
            params: a.params,
        },
    )
    .await?;
    wait_for_jobs(ctx, &[id], wait).await;
    render_job(ctx, id, vec![format!("Submitted job {id}.")], true).await
}

// ── Waiting & rendering ──────────────────────────────────────────────────────

async fn wait_for_jobs(ctx: &ToolContext, job_ids: &[i64], wait: Duration) {
    wait_for_jobs_with(job_ids, wait, |id| async move {
        worlds::poll_job(&ctx.state, ctx.user_id, id)
            .await
            .map(|j| is_terminal(&j.status))
    })
    .await;
}

fn result_of(job: &WorldJob) -> Option<Value> {
    job.result_json.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// `perspective, 1.18 M splats, 63.0 MiB` — what a completed job produced.
fn describe_result(job: &WorldJob) -> String {
    let mut parts = Vec::new();
    let result = result_of(job).unwrap_or_default();
    if let Some(mode) = result["mode"].as_str() {
        parts.push(if mode == "pano" { "360° panorama" } else { "perspective" }.to_string());
    }
    if let Some(n) = result["splat_count"].as_u64() {
        parts.push(format!("{:.2} M splats", n as f64 / 1e6));
    }
    if let Some(bytes) = job.ply_bytes {
        parts.push(format!("{:.1} MiB", bytes as f64 / f64::from(1 << 20)));
    }
    parts.join(", ")
}

fn job_line(job: &WorldJob) -> String {
    let mut line = format!("Job {} ({}) — {}", job.id, job.capability, job.status);
    match job.status.as_str() {
        "completed" => {
            let summary = describe_result(job);
            if !summary.is_empty() {
                line.push_str(&format!(": {summary}"));
            }
        }
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
                if let Some(stage) = job.stage.as_deref().filter(|s| !s.is_empty()) {
                    line.push_str(&format!(" — {stage}"));
                }
            }
            None => line.push_str(", waiting for an agent"),
        },
    }
    line
}

fn job_json(job: &WorldJob, link: Option<&ShareLink>) -> Value {
    json!({
        "job_id": job.id.to_string(),
        "status": job.status,
        "error": job.error,
        "model": job.capability,
        "mode": job.mode,
        "params": worlds::parse_params(&job.params_json),
        "input_image_id": job.input_image_id.map(|i| i.to_string()),
        "result": result_of(job),
        "ply_bytes": job.ply_bytes,
        "created_at": job.created_at.to_rfc3339(),
        "started_at": job.started_at.map(|t| t.to_rfc3339()),
        "typical_runtime_seconds": job.typical_runtime_seconds.filter(|t| *t > 0.0),
        "links": link,
    })
}

/// The stored preview as a small JPEG; `None` (logged) if there is none or it fails.
async fn preview_jpeg(ctx: &ToolContext, job: &WorldJob) -> Option<Vec<u8>> {
    let path = job.preview_path.as_deref()?;
    let op = storage::operator(&ctx.state).log_warn("mcp world preview storage")?;
    let png = storage::read(op, path).await.log_warn("mcp world preview read")?;
    image_processing::downscaled_jpeg_async(png, PREVIEW_EDGE, PREVIEW_QUALITY)
        .await
        .log_warn("mcp world preview downscale")
}

/// One job: its state and, when completed, share links and a preview.
async fn render_job(
    ctx: &ToolContext,
    job_id: i64,
    notes: Vec<String>,
    preview: bool,
) -> Result<ToolOutput, AppError> {
    let job = worlds::get_user_job(&ctx.state, ctx.user_id, job_id).await?;
    let mut lines = notes;
    lines.push(job_line(&job));
    let link = if job.status == "completed" {
        worlds::share_link(&ctx.state, &ctx.base, ctx.user_id, job_id)
            .await
            .log_warn("mcp world share link")
    } else {
        None
    };
    if let Some(l) = &link {
        lines.push(format!("  View in 3D / VR (no login): {}", l.viewer_url));
        lines.push(format!("  Scene file (.ply): {}", l.ply_url));
        lines.push(format!(
            "Links expire at {}; call get_world_job for new ones.",
            l.expires_at
        ));
    }
    if !is_terminal(&job.status) {
        lines.push(
            "Still running. It continues in the background — call get_world_job (with \
             wait_seconds) to fetch the result; don't submit again."
                .into(),
        );
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    if preview
        && let Some(jpeg) = preview_jpeg(ctx, &job).await
    {
        out.push_jpeg(&jpeg);
    }
    out.set_structured(job_json(&job, link.as_ref()));
    Ok(out)
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
    worlds::get_user_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_jobs(ctx, &[a.job_id.0], wait).await;
    render_job(ctx, a.job_id.0, Vec::new(), a.include_previews.unwrap_or(true)).await
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
    let jobs = worlds::list_user_jobs(&ctx.state, ctx.user_id, 100).await?;
    let kept: Vec<&WorldJob> = jobs
        .iter()
        .filter(|j| wanted.is_empty() || wanted.iter().any(|w| w.eq_ignore_ascii_case(&j.status)))
        .filter(|j| !a.active_only.unwrap_or(false) || !is_terminal(&j.status))
        .take(limit)
        .collect();
    if kept.is_empty() {
        return Ok(ToolOutput::text("No matching 3D world jobs."));
    }
    let lines: Vec<String> = kept
        .iter()
        .map(|j| format!("{} | {}", j.created_at.format("%Y-%m-%d %H:%M"), job_line(j)))
        .collect();
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "jobs": kept.iter().map(|j| job_json(j, None)).collect::<Vec<_>>() }));
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
        match worlds::cancel_job(&ctx.state, ctx.user_id, id).await {
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
        match worlds::delete_job(&ctx.state, ctx.user_id, id).await {
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
    let new_id = worlds::retry_job(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_jobs(ctx, &[new_id], wait).await;
    render_job(
        ctx,
        new_id,
        vec![format!("Resubmitted job {} as job {new_id}.", a.job_id.0)],
        true,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_arguments_reach_the_world_params() {
        let a: GenerateArgs = serde_json::from_value(json!({
            "image_id": "42", "model": "pano360", "pitch": -15, "max_width": 2048, "prompt": "a shrine",
        }))
        .unwrap();
        assert_eq!(a.image_id, Id(42));
        assert_eq!(
            (a.params.pitch, a.params.max_width, a.params.prompt.as_deref(), a.params.mode),
            (Some(-15.0), Some(2048), Some("a shrine"), None)
        );
        assert!(serde_json::from_value::<GenerateArgs>(json!({})).is_err());
    }

    #[test]
    fn definitions_cover_every_handled_tool() {
        let defs = definitions();
        assert_eq!(defs.len(), TOOLS.len());
        for d in &defs {
            assert!(handles(d["name"].as_str().unwrap()));
        }
        let del = defs.iter().find(|d| d["name"] == "delete_world_jobs").unwrap();
        assert_eq!(del["annotations"]["destructiveHint"], true);
    }
}
