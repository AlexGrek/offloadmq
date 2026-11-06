//! Img Model Wars tools — one prompt rendered by several imggen models side by side,
//! over `services::img_model_wars` (the web app at `/app/img-model-wars`).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    error::{AppError, ResultExt},
    offload::task_status::is_terminal,
    services::{
        image_jobs,
        img_model_wars::{self as wars, MAX_MODELS, MIN_MODELS, Params, View},
        prompt_expansion::PromptExpander,
        prompt_previews,
    },
};

use super::{
    super::content::{ImageView, ToolOutput, embed_previews, image_json},
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, ToolContext, WRITE, error_text,
    images::{
        DEFAULT_WAIT_SECS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, NEGATIVE_BUCKET, PROMPT_BUCKET,
        fmt_secs, wait_duration, wait_for_jobs_with, wait_schema,
    },
    parse_args, require_ids, tool,
};

const TOOLS: &[&str] = &[
    "start_model_war",
    "get_model_war",
    "list_model_wars",
    "cancel_model_wars",
    "retry_model_war",
    "delete_model_wars",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    let war_ids = json!({
        "type": "object",
        "properties": { "war_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
        "required": ["war_ids"],
    });
    vec![
        tool(
            "start_model_war",
            "Start model war",
            &format!(
                "Img Model Wars: render exactly the same prompt with {MIN_MODELS}–{MAX_MODELS} \
                 different image models (txt2img) to compare them side by side. Every model gets \
                 the same prompt, negative prompt, size and seed. Placeholders like {{color}}, \
                 {{animal}} and the user's custom {{placeholders}} are expanded once and shared by \
                 all models; {{?}} is substituted separately for each model's image. Pass \
                 placeholders through as the user wrote them. Each model's image is an ordinary \
                 image job (also visible in get_image_job / list_image_jobs). Waits, then returns \
                 one preview per model with its run time. Same as the web app Img Model Wars."
            ),
            json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "What to draw. May contain {placeholders}." },
                    "models": {
                        "type": "array", "items": { "type": "string" },
                        "minItems": MIN_MODELS, "maxItems": MAX_MODELS,
                        "description": format!("imggen.* capabilities from list_image_models (txt2img). Default: every online txt2img model, up to {MAX_MODELS}."),
                    },
                    "negative_prompt": { "type": "string", "description": "Things to avoid; overrides every workflow's default negative prompt." },
                    "width": { "type": "integer", "minimum": 128, "maximum": 4096, "default": 1024 },
                    "height": { "type": "integer", "minimum": 128, "maximum": 4096, "default": 1024 },
                    "seed": { "type": "integer", "description": "One seed shared by every model. Default random per model." },
                    "save_to_history": { "type": "boolean", "default": true, "description": "Record the prompt in the user's recent prompts." },
                    "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
                },
                "required": ["prompt"],
            }),
            WRITE,
        ),
        tool(
            "get_model_war",
            "Get model war",
            "Check an Img Model Wars run: refreshes every model's image job and returns per-model \
             status, run time, error and — once finished — previews and links. Optionally waits \
             for all models to finish.",
            json!({
                "type": "object",
                "properties": {
                    "war_id": { "type": "string" },
                    "wait_seconds": wait_schema(0),
                    "include_previews": { "type": "boolean", "default": true },
                },
                "required": ["war_id"],
            }),
            READ_ONLY,
        ),
        tool(
            "list_model_wars",
            "List model wars",
            "List the user's recent Img Model Wars runs (newest first): prompt, models and status.",
            json!({
                "type": "object",
                "properties": {
                    "active_only": { "type": "boolean", "default": false },
                    "limit": { "type": "integer", "minimum": 1, "maximum": LIST_MAX_LIMIT, "default": LIST_DEFAULT_LIMIT },
                },
            }),
            READ_ONLY,
        ),
        tool(
            "cancel_model_wars",
            "Cancel model wars",
            "Stop Img Model Wars runs: cancels every model that has not finished yet. Finished \
             models keep their images.",
            war_ids.clone(),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_model_war",
            "Run model war again",
            "Run a finished Img Model Wars run again as a new run with the same models, settings \
             and already-expanded prompt. Waits like start_model_war. For fresh placeholder \
             values, call start_model_war with the run's prompt_template instead.",
            json!({
                "type": "object",
                "properties": { "war_id": { "type": "string" }, "wait_seconds": wait_schema(DEFAULT_WAIT_SECS) },
                "required": ["war_id"],
            }),
            WRITE,
        ),
        tool(
            "delete_model_wars",
            "Delete model wars",
            "Permanently delete finished Img Model Wars runs together with every model's image \
             job and generated image.",
            war_ids,
            DESTRUCTIVE,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "start_model_war" => start(ctx, parse_args(args)?).await,
        "get_model_war" => get(ctx, parse_args(args)?).await,
        "list_model_wars" => list(ctx, parse_args(args)?).await,
        "cancel_model_wars" => cancel(ctx, parse_args(args)?).await,
        "retry_model_war" => retry(ctx, parse_args(args)?).await,
        "delete_model_wars" => delete(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

/// Online models that can run txt2img (untagged legacy agents included), the
/// same set the web page offers, capped at [`MAX_MODELS`].
fn default_models(caps: &[crate::offload::LlmCapabilityInfo]) -> Vec<String> {
    caps.iter()
        .filter(|c| c.online && (c.tags.is_empty() || c.tags.iter().any(|t| t == "txt2img")))
        .map(|c| c.base.clone())
        .take(MAX_MODELS)
        .collect()
}

#[derive(Deserialize)]
struct StartArgs {
    prompt: String,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default)]
    width: Option<i32>,
    #[serde(default)]
    height: Option<i32>,
    #[serde(default)]
    seed: Option<i64>,
    #[serde(default)]
    save_to_history: Option<bool>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn start(ctx: &ToolContext, a: StartArgs) -> Result<ToolOutput, AppError> {
    let template = a.prompt.trim().to_string();
    if template.is_empty() {
        return Err(AppError::BadRequest("prompt is required".into()));
    }
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let mut notes = Vec::new();
    let models = match a.models.filter(|m| !m.is_empty()) {
        Some(models) => models,
        None => {
            let caps = image_jobs::list_imggen_capabilities(&ctx.state, ctx.user_id).await?;
            let models = default_models(&caps);
            if models.len() < MIN_MODELS {
                return Err(AppError::BadRequest(format!(
                    "a model war needs at least {MIN_MODELS} online txt2img models; online: {}",
                    if models.is_empty() {
                        "none".into()
                    } else {
                        models.join(", ")
                    }
                )));
            }
            notes.push(format!(
                "Models: {} (every online txt2img model)",
                models.join(", ")
            ));
            models
        }
    };
    let negative = a
        .negative_prompt
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());

    // Expanded once so every model sees the same values; `{?}` is left for the
    // image service, which resolves it per model job (as in the web app).
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
    let prompt = expander.expand(&template)?.trim().to_string();
    notes.extend(super::placeholders::expansion_warnings(&expander));

    let id = wars::start(
        &ctx.state,
        ctx.user_id,
        Params {
            models,
            prompt,
            prompt_template: Some(template.clone()),
            override_negative: negative.is_some(),
            negative_prompt: negative.clone(),
            width: a.width.unwrap_or(1024),
            height: a.height.unwrap_or(1024),
            seed: a.seed,
        },
    )
    .await?;

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
    wait_and_render(ctx, id, wait, notes, true).await
}

/// Polls every unfinished model's image job (as `get_image_job` does) until the
/// run is done or `wait` passes, then renders it.
async fn wait_and_render(
    ctx: &ToolContext,
    id: i64,
    wait: std::time::Duration,
    notes: Vec<String>,
    previews: bool,
) -> Result<ToolOutput, AppError> {
    let view = wars::get(&ctx.state, ctx.user_id, id).await?;
    let children: Vec<i64> = view
        .slots
        .iter()
        .filter(|s| !is_terminal(&s.status))
        .filter_map(|s| s.child_job_id.parse().ok())
        .collect();
    if !children.is_empty() {
        wait_for_jobs_with(&children, wait, |child| async move {
            image_jobs::poll_job(&ctx.state, ctx.user_id, child)
                .await
                .map(|p| is_terminal(&p.status))
        })
        .await;
    }
    let view = wars::get(&ctx.state, ctx.user_id, id).await?;
    render(ctx, &view, notes, previews).await
}

fn slot_image(slot: &wars::SlotView) -> Option<ImageView> {
    Some(ImageView {
        image_id: slot.output_image_id.as_deref()?.parse().ok()?,
        width: slot.output_width.unwrap_or_default(),
        height: slot.output_height.unwrap_or_default(),
        // The view only lists image outputs; OAI stores them as JPEG.
        content_type: "image/jpeg".into(),
    })
}

fn war_json(ctx: &ToolContext, view: &View) -> Value {
    json!({
        "war_id": view.job_id,
        "status": view.status,
        "error": view.error,
        "prompt": view.params.prompt,
        "prompt_template": view.params.prompt_template,
        "negative_prompt": view.params.negative_prompt,
        "width": view.params.width,
        "height": view.params.height,
        "seed": view.params.seed,
        "created_at": view.created_at,
        "models": view.slots.iter().map(|s| json!({
            "model": s.model,
            "image_job_id": s.child_job_id,
            "status": s.status,
            "error": s.error,
            "prompt": s.prompt,
            "execution_seconds": s.execution_seconds,
            "image": slot_image(s).map(|i| image_json(ctx, &i)),
        })).collect::<Vec<_>>(),
    })
}

fn war_line(view: &View) -> String {
    let done = view
        .slots
        .iter()
        .filter(|s| s.status == "completed")
        .count();
    let mut line = format!(
        "Model war {} — {} ({done}/{} models finished)",
        view.job_id,
        view.status,
        view.slots.len()
    );
    if let Some(e) = &view.error {
        line.push_str(&format!(": {e}"));
    }
    line
}

async fn render(
    ctx: &ToolContext,
    view: &View,
    notes: Vec<String>,
    previews: bool,
) -> Result<ToolOutput, AppError> {
    let mut lines = notes;
    lines.push(war_line(view));
    lines.push(format!("  prompt: {}", view.params.prompt));
    let mut images = Vec::new();
    for slot in &view.slots {
        let mut line = format!("- {} — {}", slot.model, slot.status);
        if let Some(s) = slot
            .execution_seconds
            .filter(|_| slot.status == "completed")
        {
            line.push_str(&format!(" in {}", fmt_secs(s)));
        }
        if let Some(e) = slot.error.as_deref().filter(|e| !e.is_empty()) {
            line.push_str(&format!(": {e}"));
        }
        if let Some(img) = slot_image(slot) {
            line.push_str(&format!(
                "\n  image {} ({}×{}): {}",
                img.image_id,
                img.width,
                img.height,
                super::super::files::signed_file_url(ctx, img.image_id)
            ));
            images.push(img);
        }
        if let Some(p) = slot.prompt.as_deref().filter(|p| *p != view.params.prompt) {
            line.push_str(&format!("\n  prompt sent: {p}"));
        }
        lines.push(line);
    }
    if !is_terminal(&view.status) {
        lines.push(format!(
            "Still running. It continues in the background — call get_model_war with war_id {} \
             (and wait_seconds) to fetch the rest; don't start it again.",
            view.job_id
        ));
    }
    let mut embedded = 0;
    let mut previews_out = ToolOutput::new();
    if previews && !images.is_empty() {
        embedded = embed_previews(ctx, &mut previews_out, &images).await;
        if embedded < images.len() {
            lines.push(format!(
                "Previews shown for {embedded} of {} images (result size limit); use view_image or the links for the rest.",
                images.len()
            ));
        }
        lines.push("Previews follow in model order. Links are valid for a limited time.".into());
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.append(previews_out);
    out.set_structured(json!({ "war": war_json(ctx, view), "previews_embedded": embedded }));
    Ok(out)
}

#[derive(Deserialize)]
struct GetArgs {
    war_id: Id,
    #[serde(default)]
    wait_seconds: Option<u64>,
    #[serde(default)]
    include_previews: Option<bool>,
}

async fn get(ctx: &ToolContext, a: GetArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, 0)?;
    wait_and_render(
        ctx,
        a.war_id.0,
        wait,
        Vec::new(),
        a.include_previews.unwrap_or(true),
    )
    .await
}

#[derive(Deserialize)]
struct ListArgs {
    #[serde(default)]
    active_only: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn list(ctx: &ToolContext, a: ListArgs) -> Result<ToolOutput, AppError> {
    let limit = a
        .limit
        .unwrap_or(LIST_DEFAULT_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let views: Vec<View> = wars::list(&ctx.state, ctx.user_id)
        .await?
        .into_iter()
        .filter(|v| !a.active_only.unwrap_or(false) || !is_terminal(&v.status))
        .take(limit)
        .collect();
    if views.is_empty() {
        return Ok(ToolOutput::text("No matching model wars."));
    }
    let lines: Vec<String> = views
        .iter()
        .map(|v| {
            let prompt: String = v.params.prompt.chars().take(100).collect();
            let models: Vec<&str> = v.slots.iter().map(|s| s.model.as_str()).collect();
            format!(
                "{} | {} | {} | {prompt}",
                v.created_at,
                war_line(v),
                models.join(", ")
            )
        })
        .collect();
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(
        json!({ "wars": views.iter().map(|v| war_json(ctx, v)).collect::<Vec<_>>() }),
    );
    Ok(out)
}

#[derive(Deserialize)]
struct WarIdsArgs {
    war_ids: Vec<Id>,
}

async fn cancel(ctx: &ToolContext, a: WarIdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.war_ids, "war_id")?;
    let mut lines = Vec::new();
    let mut results = Vec::new();
    for Id(id) in a.war_ids {
        match wars::cancel(&ctx.state, ctx.user_id, id).await {
            Ok(v) => {
                lines.push(war_line(&v));
                results.push(json!({ "war_id": id.to_string(), "ok": true, "status": v.status }));
            }
            Err(e) => {
                lines.push(format!("Model war {id}: not canceled — {}", error_text(&e)));
                results.push(
                    json!({ "war_id": id.to_string(), "ok": false, "error": error_text(&e) }),
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
    war_id: Id,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn retry(ctx: &ToolContext, a: RetryArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let id = wars::retry(&ctx.state, ctx.user_id, a.war_id.0).await?;
    let note = format!("New run {id} from model war {}.", a.war_id.0);
    wait_and_render(ctx, id, wait, vec![note], true).await
}

async fn delete(ctx: &ToolContext, a: WarIdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.war_ids, "war_id")?;
    let mut lines = Vec::new();
    let mut results = Vec::new();
    for Id(id) in a.war_ids {
        match wars::delete(&ctx.state, ctx.user_id, id).await {
            Ok(()) => {
                lines.push(format!("Model war {id}: deleted"));
                results.push(json!({ "war_id": id.to_string(), "ok": true }));
            }
            Err(e) => {
                lines.push(format!("Model war {id}: not deleted — {}", error_text(&e)));
                results.push(
                    json!({ "war_id": id.to_string(), "ok": false, "error": error_text(&e) }),
                );
            }
        }
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "results": results }));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::offload::LlmCapabilityInfo;

    fn cap(base: &str, tags: &[&str], online: bool) -> LlmCapabilityInfo {
        serde_json::from_value(json!({
            "base": base, "tags": tags, "raw": base, "online": online,
            "last_available_at": "2026-11-06T00:00:00Z", "usage_count": 0,
        }))
        .unwrap()
    }

    #[test]
    fn default_models_are_online_txt2img_capped() {
        let mut caps = vec![
            cap("imggen.flux", &["txt2img", "img2img"], true),
            cap("imggen.wan", &["img2video"], true),
            cap("imggen.legacy", &[], true),
            cap("imggen.off", &["txt2img"], false),
        ];
        assert_eq!(default_models(&caps), ["imggen.flux", "imggen.legacy"]);
        caps.extend((0..10).map(|i| cap(&format!("imggen.m{i}"), &["txt2img"], true)));
        assert_eq!(default_models(&caps).len(), MAX_MODELS);
    }
}
