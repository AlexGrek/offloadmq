//! Persona tools — mirror `oai persona …` (CRUD, faces, photos, chat) over
//! `services::personas`, `services::persona_photos` and `services::chat`.

use std::time::Duration;

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

use super::images::{DEFAULT_WAIT_SECS, wait_duration, wait_for_jobs_with, wait_schema};
use super::{
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, WRITE, error_text, parse_args, require_ids, tool,
};
use crate::{
    db::{chats as db_chats, personas::Persona},
    error::AppError,
    mcp::{
        ToolContext,
        content::{ImageView, ToolOutput, embed_previews, image_json},
        files,
    },
    offload::task_status::is_terminal,
    services::{
        chat,
        persona_photos::{self, PhotoView, StartPhotoRequest},
        personas::{self, PersonaInput, PersonaView},
    },
};

const TOOLS: &[&str] = &[
    "list_personas",
    "get_persona",
    "create_persona",
    "update_persona",
    "delete_persona",
    "set_persona_faces",
    "list_persona_models",
    "generate_persona_photos",
    "get_persona_photo",
    "list_persona_photos",
    "cancel_persona_photos",
    "retry_persona_photo",
    "delete_persona_photos",
    "persona_chat",
    "list_persona_chats",
    "get_persona_chat",
];

/// Chat replies are text: a shorter default wait than image generation.
const CHAT_WAIT_SECS: u64 = 120;

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

fn persona_schema() -> Value {
    json!({ "type": ["string", "integer"], "description": "Persona id or name (case-insensitive)" })
}

fn model_schema(what: &str) -> Value {
    json!({ "type": "string", "description": format!(
        "Preferred {what} capability (see list_persona_models); \"auto\" or \"\" = automatic \
         (the model you use most, else the first online one)") })
}

fn profile_properties(require_name: bool) -> serde_json::Map<String, Value> {
    let mut p = serde_json::Map::new();
    p.insert("name".into(), json!({ "type": "string", "description": if require_name { "Display name (unique among your personas)" } else { "New name" } }));
    p.insert("system_prompt".into(), json!({ "type": "string", "description": "System prompt for the persona's chats. May use {p_name} and {p_look}." }));
    p.insert("look".into(), json!({ "type": "string", "description": "How the persona looks (hair, body, style…); substituted for {p_look} in photo prompts." }));
    p.insert("face_image_ids".into(), json!({ "type": "array", "items": { "type": ["string", "integer"] }, "description": "Face reference images (library image ids); the first is the primary face used for face swap." }));
    p.insert("llm_model".into(), model_schema("chat LLM (llm.*)"));
    p.insert("txt2img_model".into(), model_schema("txt2img (imggen.*)"));
    p.insert("img2img_model".into(), model_schema("img2img (imggen.*)"));
    p.insert(
        "face_swap_model".into(),
        model_schema("face swap (img-utils.*)"),
    );
    p.insert(
        "upscaler_model".into(),
        model_schema("upscaler (img-utils.*)"),
    );
    p
}

pub fn definitions() -> Vec<Value> {
    let create_props = profile_properties(true);
    let mut update_props = profile_properties(false);
    update_props.insert("persona".into(), persona_schema());
    vec![
        tool(
            "list_personas",
            "List personas",
            "Lists your personas (`oai persona list`): id, name, face count, look and model preferences.",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "get_persona",
            "Get a persona",
            "One persona with its faces, rendered system prompt and the models it resolves to right \
             now (`oai persona show`). Shows face previews.",
            json!({ "type": "object", "properties": { "persona": persona_schema() }, "required": ["persona"] }),
            READ_ONLY,
        ),
        tool(
            "create_persona",
            "Create a persona",
            "Creates a persona (`oai persona create`). Faces must already be in the user's \
             library (generated images or uploads); MCP cannot upload files.",
            json!({ "type": "object", "properties": create_props, "required": ["name"] }),
            WRITE,
        ),
        tool(
            "update_persona",
            "Update a persona",
            "Changes only the fields you pass (`oai persona update`). Pass \"auto\" to clear a \
             model preference; face_image_ids replaces the whole face list.",
            json!({ "type": "object", "properties": update_props, "required": ["persona"] }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "delete_persona",
            "Delete a persona",
            "Deletes a persona with its chats and photo runs (`oai persona delete`). Generated \
             images stay in the library.",
            json!({ "type": "object", "properties": { "persona": persona_schema() }, "required": ["persona"] }),
            DESTRUCTIVE,
        ),
        tool(
            "set_persona_faces",
            "Set persona faces",
            "Replaces the persona's face reference images, in order; the first is the primary \
             face (`oai persona face add|remove|primary`).",
            json!({ "type": "object", "properties": {
                "persona": persona_schema(),
                "image_ids": { "type": "array", "items": { "type": ["string", "integer"] }, "description": "Library image ids, primary first" },
            }, "required": ["persona", "image_ids"] }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "list_persona_models",
            "List persona model choices",
            "Models each persona slot can use: chat LLMs, txt2img/img2img models, face swap \
             tools and upscalers (`oai persona models`).",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "generate_persona_photos",
            "Generate persona photos",
            "Makes photos of a persona (`oai persona photo`). Default chain: txt2img → face swap \
             with the primary face → upscale ×2. The prompt may use {p_name}, {p_look}, \
             {p_system} plus the usual placeholders; pass it unexpanded. Waits and returns \
             previews of the final images. A run still going when the wait ends is normal — \
             call get_persona_photo; don't submit again.",
            json!({ "type": "object", "properties": {
                "persona": persona_schema(),
                "prompt": { "type": "string", "description": "Photo prompt, e.g. \"{p_look}, portrait of {p_name} on a beach at sunset\"" },
                "negative_prompt": { "type": "string" },
                "workflow": { "type": "string", "enum": ["txt2img", "img2img"], "description": "Default txt2img; img2img needs input_image_id" },
                "input_image_id": { "type": ["string", "integer"], "description": "img2img source image (library id)" },
                "count": { "type": "integer", "minimum": 1, "maximum": persona_photos::MAX_COUNT, "description": "Photos to make (default 1)" },
                "width": { "type": "integer" },
                "height": { "type": "integer" },
                "seed": { "type": "integer" },
                "face_image_id": { "type": ["string", "integer"], "description": "Which of the persona's faces to swap in (default: the primary)" },
                "face_swap": { "type": "boolean", "description": "Default true when the persona has faces" },
                "upscale": { "type": "boolean", "description": "Default true" },
                "scale": { "type": "number", "minimum": 1, "maximum": 8, "description": "Upscale factor (default 2)" },
                "image_model": { "type": "string", "description": "Override the persona's image model" },
                "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
            }, "required": ["persona", "prompt"] }),
            WRITE,
        ),
        tool(
            "get_persona_photo",
            "Get a persona photo",
            "Status, steps and final image of a photo run, optionally waiting for it \
             (`oai persona photo-job`).",
            json!({ "type": "object", "properties": {
                "job_id": { "type": ["string", "integer"] },
                "wait_seconds": wait_schema(0),
            }, "required": ["job_id"] }),
            READ_ONLY,
        ),
        tool(
            "list_persona_photos",
            "List persona photos",
            "A persona's photo runs, newest first (`oai persona photos`).",
            json!({ "type": "object", "properties": {
                "persona": persona_schema(),
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Default 20" },
            }, "required": ["persona"] }),
            READ_ONLY,
        ),
        tool(
            "cancel_persona_photos",
            "Cancel persona photos",
            "Cancels running photo runs (`oai persona photo-cancel`).",
            json!({ "type": "object", "properties": {
                "job_ids": { "type": "array", "items": { "type": ["string", "integer"] } },
            }, "required": ["job_ids"] }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "retry_persona_photo",
            "Retry a persona photo",
            "Runs a finished/failed photo run again with the same prompt and models \
             (`oai persona photo-retry`).",
            json!({ "type": "object", "properties": {
                "job_id": { "type": ["string", "integer"] },
                "wait_seconds": wait_schema(DEFAULT_WAIT_SECS),
            }, "required": ["job_id"] }),
            WRITE,
        ),
        tool(
            "delete_persona_photos",
            "Delete persona photos",
            "Deletes finished photo runs and their images, intermediates included \
             (`oai persona photo-delete`).",
            json!({ "type": "object", "properties": {
                "job_ids": { "type": "array", "items": { "type": ["string", "integer"] } },
            }, "required": ["job_ids"] }),
            DESTRUCTIVE,
        ),
        tool(
            "persona_chat",
            "Chat with a persona",
            "Sends a message to a persona and waits for its reply (`oai persona chat`). Uses \
             the persona's most recent chat unless chat_id or new_chat is given. The persona's \
             system prompt and preferred LLM apply.",
            json!({ "type": "object", "properties": {
                "persona": persona_schema(),
                "message": { "type": "string" },
                "chat_id": { "type": ["string", "integer"], "description": "Continue this chat" },
                "new_chat": { "type": "boolean", "description": "Start a new chat" },
                "model": { "type": "string", "description": "Override the LLM for this message" },
                "wait_seconds": wait_schema(CHAT_WAIT_SECS),
            }, "required": ["persona", "message"] }),
            WRITE,
        ),
        tool(
            "list_persona_chats",
            "List persona chats",
            "A persona's chats, most recent first (`oai persona chats`).",
            json!({ "type": "object", "properties": { "persona": persona_schema() }, "required": ["persona"] }),
            READ_ONLY,
        ),
        tool(
            "get_persona_chat",
            "Read a persona chat",
            "Messages of a persona chat, oldest first (`oai persona history`). A pending reply \
             is refreshed first.",
            json!({ "type": "object", "properties": {
                "chat_id": { "type": ["string", "integer"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Last N messages (default 50)" },
            }, "required": ["chat_id"] }),
            READ_ONLY,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "list_personas" => list(ctx).await,
        "get_persona" => get(ctx, parse_args(args)?).await,
        "create_persona" => create(ctx, parse_args(args)?).await,
        "update_persona" => update(ctx, parse_args(args)?).await,
        "delete_persona" => delete(ctx, parse_args(args)?).await,
        "set_persona_faces" => set_faces(ctx, parse_args(args)?).await,
        "list_persona_models" => models(ctx).await,
        "generate_persona_photos" => generate(ctx, parse_args(args)?).await,
        "get_persona_photo" => get_photo(ctx, parse_args(args)?).await,
        "list_persona_photos" => list_photos(ctx, parse_args(args)?).await,
        "cancel_persona_photos" => cancel_photos(ctx, parse_args(args)?).await,
        "retry_persona_photo" => retry_photo(ctx, parse_args(args)?).await,
        "delete_persona_photos" => delete_photos(ctx, parse_args(args)?).await,
        "persona_chat" => send_chat(ctx, parse_args(args)?).await,
        "list_persona_chats" => list_chats(ctx, parse_args(args)?).await,
        "get_persona_chat" => get_chat(ctx, parse_args(args)?).await,
        _ => Err(AppError::NotFound),
    }
}

/// A persona reference: id (string or number) or name.
#[derive(Debug, Clone)]
struct PersonaRef(String);

impl<'de> Deserialize<'de> for PersonaRef {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Num(i64),
            Str(String),
        }
        Ok(PersonaRef(match Raw::deserialize(d)? {
            Raw::Num(n) => n.to_string(),
            Raw::Str(s) => s,
        }))
    }
}

async fn resolve(ctx: &ToolContext, r: &PersonaRef) -> Result<Persona, AppError> {
    personas::find(&ctx.state, ctx.user_id, &r.0).await
}

// ── Personas ────────────────────────────────────────────────────────────────

fn persona_line(v: &PersonaView) -> String {
    let prefs: Vec<String> = [
        ("llm", &v.llm_capability),
        ("txt2img", &v.txt2img_capability),
        ("img2img", &v.img2img_capability),
        ("face swap", &v.face_swap_capability),
        ("upscaler", &v.upscaler_capability),
    ]
    .iter()
    .filter_map(|(k, c)| c.as_ref().map(|c| format!("{k}={c}")))
    .collect();
    format!(
        "persona {} \"{}\": {} face(s){}",
        v.id,
        v.name,
        v.faces.len(),
        if prefs.is_empty() {
            String::new()
        } else {
            format!(", prefers {}", prefs.join(" "))
        }
    )
}

async fn list(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let mut views = Vec::new();
    for p in personas::list(&ctx.state, ctx.user_id).await? {
        views.push(personas::view(&ctx.state, p, false).await?);
    }
    let text = if views.is_empty() {
        "No personas yet — create one with create_persona.".to_string()
    } else {
        views
            .iter()
            .map(persona_line)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut out = ToolOutput::text(text);
    out.set_structured(json!({ "personas": views }));
    Ok(out)
}

#[derive(Deserialize)]
struct PersonaArgs {
    persona: PersonaRef,
}

async fn render_persona(
    ctx: &ToolContext,
    persona: Persona,
    effective: bool,
) -> Result<ToolOutput, AppError> {
    let v = personas::view(&ctx.state, persona, effective).await?;
    let mut lines = vec![persona_line(&v)];
    if !v.look.is_empty() {
        lines.push(format!("look: {}", v.look));
    }
    if !v.rendered_system_prompt.is_empty() {
        lines.push(format!("system prompt: {}", v.rendered_system_prompt));
    }
    for (i, f) in v.faces.iter().enumerate() {
        lines.push(format!(
            "face {}{}: image {} ({}×{})",
            i + 1,
            if i == 0 { " (primary)" } else { "" },
            f.image_id,
            f.width,
            f.height
        ));
    }
    if let Some(e) = &v.effective {
        for (slot, c) in [
            ("llm", &e.llm),
            ("txt2img", &e.txt2img),
            ("img2img", &e.img2img),
            ("face swap", &e.face_swap),
            ("upscaler", &e.upscaler),
        ] {
            lines.push(match c {
                Some(c) => format!(
                    "uses {slot}: {}{} ({}{})",
                    c.capability,
                    c.workflow
                        .as_deref()
                        .map(|w| format!(" [{w}]"))
                        .unwrap_or_default(),
                    c.source,
                    if c.online { "" } else { ", offline" }
                ),
                None => format!("uses {slot}: none online"),
            });
        }
        for err in &e.errors {
            lines.push(format!("warning: {err}"));
        }
    }
    let mut previews = ToolOutput::new();
    let images: Vec<ImageView> = v
        .faces
        .iter()
        .map(|f| ImageView {
            image_id: f.image_id.parse().unwrap_or_default(),
            width: f.width,
            height: f.height,
            content_type: f.content_type.clone(),
        })
        .collect();
    embed_previews(ctx, &mut previews, &images).await;
    let mut out = ToolOutput::text(lines.join("\n"));
    out.append(previews);
    out.set_structured(json!({ "persona": v }));
    Ok(out)
}

async fn get(ctx: &ToolContext, a: PersonaArgs) -> Result<ToolOutput, AppError> {
    let p = resolve(ctx, &a.persona).await?;
    render_persona(ctx, p, true).await
}

#[derive(Deserialize, Default)]
struct ProfileArgs {
    #[serde(default)]
    persona: Option<PersonaRef>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    look: Option<String>,
    #[serde(default)]
    face_image_ids: Option<Vec<Id>>,
    #[serde(default)]
    llm_model: Option<String>,
    #[serde(default)]
    txt2img_model: Option<String>,
    #[serde(default)]
    img2img_model: Option<String>,
    #[serde(default)]
    face_swap_model: Option<String>,
    #[serde(default)]
    upscaler_model: Option<String>,
}

/// Overlays the given fields; model fields of "" / "auto" clear the preference.
fn merge(mut input: PersonaInput, a: ProfileArgs) -> PersonaInput {
    if let Some(v) = a.name {
        input.name = v;
    }
    if let Some(v) = a.system_prompt {
        input.system_prompt = v;
    }
    if let Some(v) = a.look {
        input.look = v;
    }
    if let Some(ids) = a.face_image_ids {
        input.face_image_ids = ids.iter().map(|i| i.0.to_string()).collect();
    }
    for (src, dst) in [
        (a.llm_model, &mut input.llm_capability),
        (a.txt2img_model, &mut input.txt2img_capability),
        (a.img2img_model, &mut input.img2img_capability),
        (a.face_swap_model, &mut input.face_swap_capability),
        (a.upscaler_model, &mut input.upscaler_capability),
    ] {
        if let Some(v) = src {
            *dst = Some(v); // blank / "auto" is normalized to None by the service
        }
    }
    input
}

async fn create(ctx: &ToolContext, a: ProfileArgs) -> Result<ToolOutput, AppError> {
    let input = merge(PersonaInput::default(), a);
    let p = personas::create(&ctx.state, ctx.user_id, input).await?;
    let mut out = render_persona(ctx, p, false).await?;
    out.push_text("Created. Generate photos with generate_persona_photos, chat with persona_chat.");
    Ok(out)
}

async fn update(ctx: &ToolContext, mut a: ProfileArgs) -> Result<ToolOutput, AppError> {
    let reference = a
        .persona
        .take()
        .ok_or_else(|| AppError::BadRequest("persona is required".into()))?;
    let p = resolve(ctx, &reference).await?;
    let input = merge(personas::input_from(&p), a);
    let p = personas::update(&ctx.state, ctx.user_id, p.id, input).await?;
    render_persona(ctx, p, false).await
}

async fn delete(ctx: &ToolContext, a: PersonaArgs) -> Result<ToolOutput, AppError> {
    let p = resolve(ctx, &a.persona).await?;
    personas::delete(&ctx.state, ctx.user_id, p.id).await?;
    Ok(ToolOutput::text(format!(
        "Deleted persona {} \"{}\".",
        p.id, p.name
    )))
}

#[derive(Deserialize)]
struct FacesArgs {
    persona: PersonaRef,
    image_ids: Vec<Id>,
}

async fn set_faces(ctx: &ToolContext, a: FacesArgs) -> Result<ToolOutput, AppError> {
    let p = resolve(ctx, &a.persona).await?;
    let mut input = personas::input_from(&p);
    input.face_image_ids = a.image_ids.iter().map(|i| i.0.to_string()).collect();
    let p = personas::update(&ctx.state, ctx.user_id, p.id, input).await?;
    render_persona(ctx, p, false).await
}

async fn models(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let o = personas::model_options(&ctx.state, ctx.user_id).await;
    let fmt = |name: &str, list: &[personas::ModelOption]| {
        let items: Vec<String> = list
            .iter()
            .map(|m| {
                format!(
                    "{}{}{}",
                    m.capability,
                    m.workflow
                        .as_deref()
                        .map(|w| format!(" [{w}]"))
                        .unwrap_or_default(),
                    if m.online { "" } else { " (offline)" }
                )
            })
            .collect();
        format!(
            "{name}: {}",
            if items.is_empty() {
                "none".into()
            } else {
                items.join(", ")
            }
        )
    };
    let mut lines = vec![
        fmt("llm", &o.llm),
        fmt("txt2img", &o.txt2img),
        fmt("img2img", &o.img2img),
        fmt("face swap", &o.face_swap),
        fmt("upscaler", &o.upscaler),
    ];
    lines.extend(o.errors.iter().map(|e| format!("warning: {e}")));
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(serde_json::to_value(&o).unwrap_or_default());
    Ok(out)
}

// ── Photos ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GenerateArgs {
    persona: PersonaRef,
    prompt: String,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
    #[serde(default)]
    input_image_id: Option<Id>,
    #[serde(default)]
    count: Option<u32>,
    #[serde(default)]
    width: Option<i32>,
    #[serde(default)]
    height: Option<i32>,
    #[serde(default)]
    seed: Option<i64>,
    #[serde(default)]
    face_image_id: Option<Id>,
    #[serde(default)]
    face_swap: Option<bool>,
    #[serde(default)]
    upscale: Option<bool>,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    image_model: Option<String>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn wait_for_photos(ctx: &ToolContext, ids: &[i64], wait: Duration) {
    wait_for_jobs_with(ids, wait, |id| async move {
        persona_photos::poll(&ctx.state, ctx.user_id, id, true)
            .await
            .map(|v| is_terminal(&v.status))
    })
    .await;
}

fn step_summary(v: &PhotoView) -> String {
    v.steps
        .iter()
        .map(|s| {
            let name = match s.kind {
                persona_photos::Kind::Generate => "generate",
                persona_photos::Kind::FaceSwap => "face swap",
                persona_photos::Kind::Upscale => "upscale",
            };
            format!("{name}: {}", s.status)
        })
        .collect::<Vec<_>>()
        .join(" → ")
}

async fn render_photos(
    ctx: &ToolContext,
    ids: &[i64],
    notes: Vec<String>,
) -> Result<ToolOutput, AppError> {
    let mut lines = notes;
    let mut images = Vec::new();
    let mut views = Vec::new();
    let mut unfinished = Vec::new();
    for &id in ids {
        let v = persona_photos::get(&ctx.state, ctx.user_id, id).await?;
        lines.push(format!(
            "photo {}: {} ({})",
            v.job_id,
            v.status,
            step_summary(&v)
        ));
        if v.prompt != v.prompt_template {
            lines.push(format!("  prompt: {}", v.prompt));
        }
        if let Some(e) = &v.error {
            lines.push(format!("  error: {e}"));
        }
        let mut image = Value::Null;
        if let Some(img) = &v.final_image {
            let view = ImageView {
                image_id: img.image_id.parse().unwrap_or_default(),
                width: img.width,
                height: img.height,
                content_type: img.content_type.clone(),
            };
            lines.push(format!(
                "  image {} ({}×{}): {}",
                img.image_id,
                img.width,
                img.height,
                files::signed_file_url(ctx, view.image_id)
            ));
            image = image_json(ctx, &view);
            images.push(view);
        }
        if !is_terminal(&v.status) {
            unfinished.push(v.job_id.clone());
        }
        let mut j = serde_json::to_value(&v).unwrap_or_default();
        j["image"] = image;
        views.push(j);
    }
    if !unfinished.is_empty() {
        lines.push(format!(
            "Still running: {}. It continues in the background — call get_persona_photo (with \
             wait_seconds) to fetch the result; don't submit again.",
            unfinished.join(", ")
        ));
    }
    let mut previews = ToolOutput::new();
    let embedded = embed_previews(ctx, &mut previews, &images).await;
    if !images.is_empty() {
        lines
            .push("Links are valid for a limited time; they open the full-resolution file.".into());
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.append(previews);
    out.set_structured(json!({ "photos": views, "previews_embedded": embedded }));
    Ok(out)
}

async fn generate(ctx: &ToolContext, a: GenerateArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let p = resolve(ctx, &a.persona).await?;
    let ids = persona_photos::start(
        &ctx.state,
        ctx.user_id,
        p.id,
        StartPhotoRequest {
            prompt: a.prompt,
            negative_prompt: a.negative_prompt,
            workflow: a.workflow,
            input_image_id: a.input_image_id.map(|i| i.0.to_string()),
            width: a.width,
            height: a.height,
            seed: a.seed,
            count: a.count,
            face_image_id: a.face_image_id.map(|i| i.0.to_string()),
            face_swap: a.face_swap,
            upscale: a.upscale,
            scale: a.scale,
            image_model: a.image_model,
            face_swap_capability: None,
            upscaler_capability: None,
        },
    )
    .await?;
    wait_for_photos(ctx, &ids, wait).await;
    render_photos(ctx, &ids, vec![format!("Persona: {} ({})", p.name, p.id)]).await
}

#[derive(Deserialize)]
struct PhotoArgs {
    job_id: Id,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn get_photo(ctx: &ToolContext, a: PhotoArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, 0)?;
    persona_photos::get(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_photos(ctx, &[a.job_id.0], wait).await;
    render_photos(ctx, &[a.job_id.0], Vec::new()).await
}

#[derive(Deserialize)]
struct ListPhotosArgs {
    persona: PersonaRef,
    #[serde(default)]
    limit: Option<u64>,
}

async fn list_photos(ctx: &ToolContext, a: ListPhotosArgs) -> Result<ToolOutput, AppError> {
    let p = resolve(ctx, &a.persona).await?;
    let limit = a.limit.unwrap_or(20).clamp(1, 100);
    let photos = persona_photos::list(&ctx.state, ctx.user_id, p.id, limit).await?;
    let lines: Vec<String> = photos
        .iter()
        .map(|v| {
            format!(
                "{} {} {}{} — {}",
                v.job_id,
                v.created_at,
                v.status,
                v.final_image_id
                    .as_deref()
                    .map(|i| format!(" image {i}"))
                    .unwrap_or_default(),
                v.prompt_template
            )
        })
        .collect();
    let mut out = ToolOutput::text(if lines.is_empty() {
        format!("{} has no photos yet.", p.name)
    } else {
        lines.join("\n")
    });
    out.set_structured(json!({ "photos": photos }));
    Ok(out)
}

#[derive(Deserialize)]
struct IdsArgs {
    job_ids: Vec<Id>,
}

async fn cancel_photos(ctx: &ToolContext, a: IdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.job_ids, "job_id")?;
    let mut lines = Vec::new();
    for Id(id) in a.job_ids {
        lines.push(
            match persona_photos::cancel(&ctx.state, ctx.user_id, id).await {
                Ok(v) => format!("{id}: {}", v.status),
                Err(e) => format!("{id}: {}", error_text(&e)),
            },
        );
    }
    Ok(ToolOutput::text(lines.join("\n")))
}

async fn retry_photo(ctx: &ToolContext, a: PhotoArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, DEFAULT_WAIT_SECS)?;
    let new_id = persona_photos::retry(&ctx.state, ctx.user_id, a.job_id.0).await?;
    wait_for_photos(ctx, &[new_id], wait).await;
    render_photos(
        ctx,
        &[new_id],
        vec![format!("Retry of {} → {new_id}", a.job_id.0)],
    )
    .await
}

async fn delete_photos(ctx: &ToolContext, a: IdsArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.job_ids, "job_id")?;
    let mut lines = Vec::new();
    for Id(id) in a.job_ids {
        lines.push(
            match persona_photos::delete(&ctx.state, ctx.user_id, id).await {
                Ok(()) => format!("{id}: deleted"),
                Err(e) => format!("{id}: {}", error_text(&e)),
            },
        );
    }
    Ok(ToolOutput::text(lines.join("\n")))
}

// ── Chat ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChatArgs {
    persona: PersonaRef,
    message: String,
    #[serde(default)]
    chat_id: Option<Id>,
    #[serde(default)]
    new_chat: bool,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

async fn send_chat(ctx: &ToolContext, a: ChatArgs) -> Result<ToolOutput, AppError> {
    let wait = wait_duration(a.wait_seconds, CHAT_WAIT_SECS)?;
    let p = resolve(ctx, &a.persona).await?;
    let chat = personas::chat_for(&ctx.state, &p, a.chat_id.map(|i| i.0), a.new_chat).await?;
    let turn = chat::submit_turn(
        &ctx.state,
        ctx.user_id,
        chat::TurnRequest {
            capability: a.model,
            chat_id: chat.id,
            content: a.message,
            attachment_ids: Vec::new(),
            model_online: true,
            timeout_secs: None,
            max_wait_secs: None,
            runtime_secs: None,
        },
    )
    .await?;
    let msg_id = turn.assistant_message_id;
    let capability = turn.capability.clone();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    chat::spawn_poll_loop(&ctx.state, turn, String::new(), tx);

    let chat_id = chat.id;
    wait_for_jobs_with(&[msg_id], wait, |id| async move {
        chat::get_message_reconciled(&ctx.state, ctx.user_id, chat_id, id)
            .await
            .map(|m| m.status != "pending")
    })
    .await;
    let msg = db_chats::get_message(&ctx.state.db, chat_id, msg_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let header = format!("{} (chat {chat_id}, {capability}):", p.name);
    let text = match msg.status.as_str() {
        "pending" => format!(
            "{header} the reply is still being generated. Call get_persona_chat with chat_id \
             {chat_id} shortly; don't send the message again."
        ),
        "failed" => format!("{header} the reply failed: {}", msg.content),
        _ => format!("{header}\n\n{}", msg.content),
    };
    let mut out = ToolOutput::text(text);
    out.set_structured(json!({
        "persona_id": p.id.to_string(),
        "chat_id": chat_id.to_string(),
        "message_id": msg_id.to_string(),
        "status": msg.status,
        "model": capability,
        "reply": msg.content,
    }));
    Ok(out)
}

async fn list_chats(ctx: &ToolContext, a: PersonaArgs) -> Result<ToolOutput, AppError> {
    let p = resolve(ctx, &a.persona).await?;
    let chats = db_chats::list_chats(
        &ctx.state.db,
        ctx.user_id,
        db_chats::ChatKind::Persona,
        Some(p.id),
    )
    .await?;
    let items: Vec<Value> = chats
        .iter()
        .map(|c| {
            json!({
                "chat_id": c.id.to_string(),
                "title": c.title,
                "last_model": c.last_model,
                "updated_at": c.updated_at.to_rfc3339(),
            })
        })
        .collect();
    let lines: Vec<String> = chats
        .iter()
        .map(|c| {
            format!(
                "{} {} {}",
                c.id,
                c.updated_at.to_rfc3339(),
                if c.title.is_empty() {
                    "(untitled)"
                } else {
                    &c.title
                }
            )
        })
        .collect();
    let mut out = ToolOutput::text(if lines.is_empty() {
        format!("{} has no chats yet — start one with persona_chat.", p.name)
    } else {
        lines.join("\n")
    });
    out.set_structured(json!({ "chats": items }));
    Ok(out)
}

#[derive(Deserialize)]
struct GetChatArgs {
    chat_id: Id,
    #[serde(default)]
    limit: Option<usize>,
}

async fn get_chat(ctx: &ToolContext, a: GetChatArgs) -> Result<ToolOutput, AppError> {
    let chat = db_chats::get_chat(&ctx.state.db, a.chat_id.0, ctx.user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if chat.persona_id.is_none() {
        return Err(AppError::BadRequest(format!(
            "chat {} is not a persona chat",
            chat.id
        )));
    }
    let mut msgs = db_chats::get_messages(&ctx.state.db, chat.id).await?;
    for m in msgs.iter_mut().filter(|m| m.status == "pending") {
        if let Ok(fresh) =
            chat::get_message_reconciled(&ctx.state, ctx.user_id, chat.id, m.id).await
        {
            *m = fresh;
        }
    }
    let limit = a.limit.unwrap_or(50).clamp(1, 200);
    let skip = msgs.len().saturating_sub(limit);
    let msgs = &msgs[skip..];
    let lines: Vec<String> = msgs
        .iter()
        .map(|m| {
            let status = if m.status == "complete" {
                String::new()
            } else {
                format!(" [{}]", m.status)
            };
            format!("{}{status}: {}", m.role, m.content)
        })
        .collect();
    let items: Vec<Value> = msgs
        .iter()
        .map(|m| {
            json!({
                "id": m.id.to_string(), "role": m.role, "status": m.status,
                "content": m.content, "model": m.model, "created_at": m.created_at.to_rfc3339(),
            })
        })
        .collect();
    let mut out = ToolOutput::text(lines.join("\n\n"));
    out.set_structured(json!({ "chat_id": chat.id.to_string(), "messages": items }));
    Ok(out)
}
