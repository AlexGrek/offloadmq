//! Personas — reusable characters with faces, a look description, a system prompt
//! and optional model preferences. Owns validation, `{p_*}` token rendering, and
//! resolving each model slot to an effective capability (preference → the user's
//! most-used → the first/only online one). Photos live in `services::persona_photos`,
//! chats are ordinary `chats` rows of kind `persona` (`services::chat`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{
    db::{
        chats as db_chats, image_generation, img_utils as db_img_utils,
        personas::{self as db, Persona, PersonaFields},
    },
    error::AppError,
    offload::{LlmCapabilityInfo, base_capability},
    services::{chat, image_jobs, img_utils},
    state::AppState,
};

pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 32_000;
pub const MAX_LOOK_CHARS: usize = 4_000;
pub const MAX_FACES: usize = 10;

/// Persona tokens, substituted before the regular prompt placeholders. Reserved as
/// custom placeholder names (`db::prompt_placeholders::RESERVED_PLACEHOLDER_NAMES`).
pub const PERSONA_TOKENS: &[&str] = &["p_name", "p_look", "p_system"];

/// How many recent runs rank "most used" for LLM and Image Tools defaults.
const USAGE_HISTORY: u64 = 50;

/// Create / full-replace body. Preferences: `None` or blank = automatic.
#[derive(Debug, Default, Deserialize, Serialize, Clone)]
pub struct PersonaInput {
    pub name: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub look: String,
    /// Ordered `image_files` ids; the first is the primary face.
    #[serde(default)]
    pub face_image_ids: Vec<String>,
    #[serde(default)]
    pub llm_capability: Option<String>,
    #[serde(default)]
    pub txt2img_capability: Option<String>,
    #[serde(default)]
    pub img2img_capability: Option<String>,
    #[serde(default)]
    pub face_swap_capability: Option<String>,
    #[serde(default)]
    pub upscaler_capability: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImageRef {
    pub image_id: String,
    pub filename: String,
    pub content_type: String,
    pub width: i32,
    pub height: i32,
}

/// What a model slot resolves to right now.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct EffectiveChoice {
    pub capability: String,
    /// Image Tools operation (`face_swap`, `upscale`) — Image Tools slots only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    /// `preference` | `most_used` | `only` | `first_online`.
    pub source: &'static str,
    pub online: bool,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct EffectiveModels {
    pub llm: Option<EffectiveChoice>,
    pub txt2img: Option<EffectiveChoice>,
    pub img2img: Option<EffectiveChoice>,
    pub face_swap: Option<EffectiveChoice>,
    pub upscaler: Option<EffectiveChoice>,
    /// Lookup problems (OffloadMQ unreachable, …); slots that failed stay `null`.
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PersonaView {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    /// `system_prompt` with `{p_name}` / `{p_look}` substituted — what chats send.
    pub rendered_system_prompt: String,
    pub look: String,
    pub face_image_ids: Vec<String>,
    pub faces: Vec<ImageRef>,
    pub llm_capability: Option<String>,
    pub txt2img_capability: Option<String>,
    pub img2img_capability: Option<String>,
    pub face_swap_capability: Option<String>,
    pub upscaler_capability: Option<String>,
    /// Only on the detail endpoint (it asks OffloadMQ what is online).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective: Option<EffectiveModels>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/// Replaces `{p_name}`, `{p_look}` and `{p_system}` (case-insensitive, inner
/// whitespace ignored). Other `{…}` tokens are left for the placeholder expander.
/// `{p_system}` expands to the persona's rendered system prompt — except inside the
/// system prompt itself (`in_system_prompt`), where it becomes empty.
pub fn render_tokens(text: &str, persona: &Persona, in_system_prompt: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after
            .find(['}', '{'])
            .filter(|&e| after.as_bytes()[e] == b'}')
        {
            let value = match after[..end].trim().to_ascii_lowercase().as_str() {
                "p_name" => Some(persona.name.trim().to_string()),
                "p_look" => Some(persona.look.trim().to_string()),
                "p_system" if in_system_prompt => Some(String::new()),
                "p_system" => Some(
                    render_tokens(&persona.system_prompt, persona, true)
                        .trim()
                        .to_string(),
                ),
                _ => None,
            };
            if let Some(v) = value {
                out.push_str(&v);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push('{');
        rest = after;
    }
    out.push_str(rest);
    out
}

/// The system prompt a persona chat sends.
pub fn rendered_system_prompt(persona: &Persona) -> String {
    render_tokens(&persona.system_prompt, persona, true)
        .trim()
        .to_string()
}

// ── Faces ───────────────────────────────────────────────────────────────────

pub fn face_ids(persona: &Persona) -> Vec<i64> {
    serde_json::from_str::<Vec<String>>(&persona.face_image_ids_json)
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// The persona's faces that still exist, in order (deleted files drop out).
pub async fn resolve_faces(
    state: &AppState,
    persona: &Persona,
) -> Result<Vec<image_generation::ImageFile>, AppError> {
    let mut out = Vec::new();
    for id in face_ids(persona) {
        if let Some(f) = image_generation::get_image_file(&state.db, id, persona.user_id).await? {
            out.push(f);
        }
    }
    Ok(out)
}

fn face_ref(f: &image_generation::ImageFile) -> ImageRef {
    ImageRef {
        image_id: f.id.to_string(),
        filename: f.filename.clone(),
        content_type: f.content_type.clone(),
        width: f.stored_width,
        height: f.stored_height,
    }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

fn normalize_pref(
    value: Option<String>,
    prefix: &str,
    label: &str,
) -> Result<Option<String>, AppError> {
    let Some(raw) = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v != "auto")
    else {
        return Ok(None);
    };
    let base = base_capability(&raw).to_string();
    if !base.starts_with(prefix) || base.len() == prefix.len() {
        return Err(AppError::BadRequest(format!(
            "{label} must be a `{prefix}*` capability (got {raw:?})"
        )));
    }
    Ok(Some(base))
}

async fn validate(
    state: &AppState,
    user_id: i64,
    exclude_id: Option<i64>,
    input: PersonaInput,
) -> Result<PersonaFields, AppError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("persona name cannot be empty".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::BadRequest(format!(
            "persona name exceeds {MAX_NAME_CHARS} characters"
        )));
    }
    let lower = name.to_lowercase();
    if db::list(&state.db, user_id)
        .await?
        .iter()
        .any(|p| Some(p.id) != exclude_id && p.name.to_lowercase() == lower)
    {
        return Err(AppError::BadRequest(format!(
            "you already have a persona named {name:?}"
        )));
    }
    let system_prompt = input.system_prompt.trim().to_string();
    if system_prompt.chars().count() > MAX_SYSTEM_PROMPT_CHARS {
        return Err(AppError::BadRequest(format!(
            "system prompt exceeds {MAX_SYSTEM_PROMPT_CHARS} characters"
        )));
    }
    let look = input.look.trim().to_string();
    if look.chars().count() > MAX_LOOK_CHARS {
        return Err(AppError::BadRequest(format!(
            "look description exceeds {MAX_LOOK_CHARS} characters"
        )));
    }

    let mut faces: Vec<String> = Vec::new();
    for raw in &input.face_image_ids {
        let id: i64 = raw
            .trim()
            .parse()
            .map_err(|_| AppError::BadRequest(format!("invalid face image id {raw:?}")))?;
        let file = image_generation::get_image_file(&state.db, id, user_id)
            .await?
            .ok_or_else(|| AppError::BadRequest(format!("face image {id} not found")))?;
        if !file.content_type.starts_with("image/") {
            return Err(AppError::BadRequest(format!("face {id} is not an image")));
        }
        let id = id.to_string();
        if !faces.contains(&id) {
            faces.push(id);
        }
    }
    if faces.len() > MAX_FACES {
        return Err(AppError::BadRequest(format!(
            "a persona can have at most {MAX_FACES} face images"
        )));
    }

    Ok(PersonaFields {
        name,
        system_prompt,
        look,
        face_image_ids_json: serde_json::to_string(&faces)
            .map_err(|e| AppError::Internal(e.to_string()))?,
        llm_capability: normalize_pref(input.llm_capability, "llm.", "llm_capability")?,
        txt2img_capability: normalize_pref(
            input.txt2img_capability,
            "imggen.",
            "txt2img_capability",
        )?,
        img2img_capability: normalize_pref(
            input.img2img_capability,
            "imggen.",
            "img2img_capability",
        )?,
        face_swap_capability: normalize_pref(
            input.face_swap_capability,
            "img-utils.",
            "face_swap_capability",
        )?,
        upscaler_capability: normalize_pref(
            input.upscaler_capability,
            "img-utils.",
            "upscaler_capability",
        )?,
    })
}

pub async fn create(
    state: &AppState,
    user_id: i64,
    input: PersonaInput,
) -> Result<Persona, AppError> {
    let fields = validate(state, user_id, None, input).await?;
    db::create(&state.db, state.next_id(), user_id, fields).await
}

pub async fn update(
    state: &AppState,
    user_id: i64,
    id: i64,
    input: PersonaInput,
) -> Result<Persona, AppError> {
    db::get(&state.db, id, user_id).await?;
    let fields = validate(state, user_id, Some(id), input).await?;
    db::update(&state.db, id, fields).await
}

pub async fn delete(state: &AppState, user_id: i64, id: i64) -> Result<(), AppError> {
    db::delete(&state.db, id, user_id).await
}

pub async fn get(state: &AppState, user_id: i64, id: i64) -> Result<Persona, AppError> {
    db::get(&state.db, id, user_id).await
}

pub async fn list(state: &AppState, user_id: i64) -> Result<Vec<Persona>, AppError> {
    db::list(&state.db, user_id).await
}

/// Resolves a persona by id or (case-insensitive) name — for the CLI and MCP.
pub async fn find(state: &AppState, user_id: i64, reference: &str) -> Result<Persona, AppError> {
    let reference = reference.trim();
    if let Ok(id) = reference.parse::<i64>()
        && let Ok(p) = db::get(&state.db, id, user_id).await
    {
        return Ok(p);
    }
    let lower = reference.to_lowercase();
    db::list(&state.db, user_id)
        .await?
        .into_iter()
        .find(|p| p.name.to_lowercase() == lower)
        .ok_or_else(|| AppError::BadRequest(format!("no persona {reference:?}")))
}

pub async fn view(
    state: &AppState,
    persona: Persona,
    with_effective: bool,
) -> Result<PersonaView, AppError> {
    let faces = resolve_faces(state, &persona).await?;
    let effective = if with_effective {
        Some(effective_models(state, &persona).await)
    } else {
        None
    };
    Ok(PersonaView {
        id: persona.id.to_string(),
        rendered_system_prompt: rendered_system_prompt(&persona),
        face_image_ids: faces.iter().map(|f| f.id.to_string()).collect(),
        faces: faces.iter().map(face_ref).collect(),
        name: persona.name,
        system_prompt: persona.system_prompt,
        look: persona.look,
        llm_capability: persona.llm_capability,
        txt2img_capability: persona.txt2img_capability,
        img2img_capability: persona.img2img_capability,
        face_swap_capability: persona.face_swap_capability,
        upscaler_capability: persona.upscaler_capability,
        effective,
        created_at: persona.created_at.to_rfc3339(),
        updated_at: persona.updated_at.to_rfc3339(),
    })
}

// ── Model resolution ────────────────────────────────────────────────────────

/// Picks among capabilities: the explicit preference, else the online one the user
/// ran most, else the first online one (`only` when it is the sole candidate).
/// `candidates` are `(capability, workflow)` pairs that are online right now.
fn choose(
    preference: Option<&str>,
    candidates: &[(String, Option<String>)],
    usage: &HashMap<String, u32>,
    default_workflow: Option<&str>,
) -> Option<EffectiveChoice> {
    if let Some(pref) = preference {
        let online = candidates.iter().find(|(c, _)| c == pref);
        return Some(EffectiveChoice {
            capability: pref.to_string(),
            workflow: online
                .and_then(|(_, w)| w.clone())
                .or_else(|| default_workflow.map(str::to_string)),
            source: "preference",
            online: online.is_some(),
        });
    }
    let best = candidates
        .iter()
        .enumerate()
        .max_by_key(|(i, (c, _))| (usage.get(c).copied().unwrap_or(0), std::cmp::Reverse(*i)))
        .map(|(_, c)| c)?;
    let used = usage.get(&best.0).copied().unwrap_or(0) > 0;
    Some(EffectiveChoice {
        capability: best.0.clone(),
        workflow: best.1.clone(),
        source: if candidates.len() == 1 {
            "only"
        } else if used {
            "most_used"
        } else {
            "first_online"
        },
        online: true,
    })
}

pub async fn resolve_llm(
    state: &AppState,
    persona: &Persona,
) -> Result<Option<EffectiveChoice>, AppError> {
    let caps = chat::load_capabilities(state).await?;
    let usage = db_chats::recent_model_usage(&state.db, persona.user_id, USAGE_HISTORY).await?;
    let candidates: Vec<(String, Option<String>)> = caps
        .iter()
        .filter(|c| c.online)
        .map(|c| (c.base.clone(), None))
        .collect();
    Ok(choose(
        persona.llm_capability.as_deref(),
        &candidates,
        &usage,
        None,
    ))
}

/// `workflow` is `txt2img` or `img2img`.
pub async fn resolve_imggen(
    state: &AppState,
    persona: &Persona,
    workflow: &str,
) -> Result<Option<EffectiveChoice>, AppError> {
    let caps = image_jobs::list_imggen_capabilities(state, persona.user_id).await?;
    let preference = match workflow {
        "img2img" => persona.img2img_capability.as_deref(),
        _ => persona.txt2img_capability.as_deref(),
    };
    Ok(pick_imggen(&caps, preference, workflow))
}

fn pick_imggen(
    caps: &[LlmCapabilityInfo],
    preference: Option<&str>,
    workflow: &str,
) -> Option<EffectiveChoice> {
    // Models tagged for the workflow; when none advertise tags, any online model
    // (mirrors `image_jobs::pick_imggen_model`).
    let online: Vec<&LlmCapabilityInfo> = caps.iter().filter(|c| c.online).collect();
    let tagged: Vec<&LlmCapabilityInfo> = online
        .iter()
        .copied()
        .filter(|c| c.tags.iter().any(|t| t == workflow))
        .collect();
    let pool = if tagged.is_empty() { online } else { tagged };
    let candidates: Vec<(String, Option<String>)> =
        pool.iter().map(|c| (c.base.clone(), None)).collect();
    let usage: HashMap<String, u32> = pool
        .iter()
        .map(|c| (c.base.clone(), c.usage_count))
        .collect();
    choose(preference, &candidates, &usage, None)
}

fn is_face_swap(workflow: &str) -> bool {
    workflow
        .to_lowercase()
        .replace(['-', '_'], "")
        .starts_with("faceswap")
}

fn is_upscale(workflow: &str) -> bool {
    workflow.to_lowercase().starts_with("upscale")
}

/// `kind` is `face_swap` or `upscale`.
pub async fn resolve_img_tool(
    state: &AppState,
    persona: &Persona,
    kind: &str,
) -> Result<Option<EffectiveChoice>, AppError> {
    let caps = img_utils::list_capabilities(state).await?;
    let matches: fn(&str) -> bool = if kind == "face_swap" {
        is_face_swap
    } else {
        is_upscale
    };
    let mut candidates: Vec<(String, Option<String>)> = Vec::new();
    for c in caps.iter().filter(|c| c.kind == img_utils::KIND_COMFY) {
        if let Some(w) = c.workflows.iter().find(|w| matches(w)) {
            candidates.push((c.base.clone(), Some(w.clone())));
        }
    }
    candidates.sort();
    let usage =
        db_img_utils::capability_usage(&state.db, persona.user_id, kind, USAGE_HISTORY).await?;
    let preference = if kind == "face_swap" {
        persona.face_swap_capability.as_deref()
    } else {
        persona.upscaler_capability.as_deref()
    };
    Ok(choose(preference, &candidates, &usage, Some(kind)))
}

/// Every slot, best-effort: a failed lookup leaves the slot empty and adds an error.
pub async fn effective_models(state: &AppState, persona: &Persona) -> EffectiveModels {
    let mut out = EffectiveModels::default();
    let note = |label: &str, e: AppError| format!("{label}: {e}");
    let mut errors = Vec::new();
    match resolve_llm(state, persona).await {
        Ok(v) => out.llm = v,
        Err(e) => errors.push(note("llm", e)),
    }
    match image_jobs::list_imggen_capabilities(state, persona.user_id).await {
        Ok(caps) => {
            out.txt2img = pick_imggen(&caps, persona.txt2img_capability.as_deref(), "txt2img");
            out.img2img = pick_imggen(&caps, persona.img2img_capability.as_deref(), "img2img");
        }
        Err(e) => errors.push(note("image models", e)),
    }
    match resolve_img_tool(state, persona, "face_swap").await {
        Ok(v) => out.face_swap = v,
        Err(e) => errors.push(note("face swap", e)),
    }
    match resolve_img_tool(state, persona, "upscale").await {
        Ok(v) => out.upscaler = v,
        Err(e) => errors.push(note("upscaler", e)),
    }
    out.errors = errors;
    out
}

/// The chat a persona conversation goes to: `chat_id` (must belong to the persona),
/// a fresh one when `new_chat`, else the persona's most recent chat (created when
/// there is none). Used by MCP; the CLI does the same over REST.
pub async fn chat_for(
    state: &AppState,
    persona: &Persona,
    chat_id: Option<i64>,
    new_chat: bool,
) -> Result<db_chats::Chat, AppError> {
    if let Some(id) = chat_id {
        let chat = db_chats::get_chat(&state.db, id, persona.user_id)
            .await?
            .ok_or(AppError::NotFound)?;
        if chat.persona_id != Some(persona.id) {
            return Err(AppError::BadRequest(format!(
                "chat {id} does not belong to persona {:?}",
                persona.name
            )));
        }
        return Ok(chat);
    }
    if !new_chat
        && let Some(latest) = db_chats::list_chats(
            &state.db,
            persona.user_id,
            db_chats::ChatKind::Persona,
            Some(persona.id),
        )
        .await?
        .into_iter()
        .next()
    {
        return Ok(latest);
    }
    db_chats::create_chat(
        &state.db,
        state.next_id(),
        persona.user_id,
        "",
        db_chats::ChatKind::Persona,
        Some(persona.id),
    )
    .await
}

/// Full-replace input for an existing persona (MCP merges partial edits into it).
pub fn input_from(persona: &Persona) -> PersonaInput {
    PersonaInput {
        name: persona.name.clone(),
        system_prompt: persona.system_prompt.clone(),
        look: persona.look.clone(),
        face_image_ids: face_ids(persona).iter().map(i64::to_string).collect(),
        llm_capability: persona.llm_capability.clone(),
        txt2img_capability: persona.txt2img_capability.clone(),
        img2img_capability: persona.img2img_capability.clone(),
        face_swap_capability: persona.face_swap_capability.clone(),
        upscaler_capability: persona.upscaler_capability.clone(),
    }
}

/// One selectable model for a persona slot (profile form, CLI, MCP).
#[derive(Debug, Serialize)]
pub struct ModelOption {
    pub capability: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub online: bool,
}

/// Everything the persona slots can be set to (online models, plus known offline
/// LLM/image models so a preference can be kept while its agent is down).
#[derive(Debug, Serialize, Default)]
pub struct ModelOptions {
    pub llm: Vec<ModelOption>,
    pub txt2img: Vec<ModelOption>,
    pub img2img: Vec<ModelOption>,
    pub face_swap: Vec<ModelOption>,
    pub upscaler: Vec<ModelOption>,
    pub errors: Vec<String>,
}

pub async fn model_options(state: &AppState, user_id: i64) -> ModelOptions {
    let mut out = ModelOptions::default();
    match chat::load_capabilities(state).await {
        Ok(caps) => {
            out.llm = caps
                .into_iter()
                .map(|c| ModelOption {
                    capability: c.base,
                    workflow: None,
                    online: c.online,
                })
                .collect()
        }
        Err(e) => out.errors.push(format!("llm: {e}")),
    }
    match image_jobs::list_imggen_capabilities(state, user_id).await {
        Ok(caps) => {
            for wf in ["txt2img", "img2img"] {
                let tagged: Vec<ModelOption> = caps
                    .iter()
                    .filter(|c| c.tags.is_empty() || c.tags.iter().any(|t| t == wf))
                    .map(|c| ModelOption {
                        capability: c.base.clone(),
                        workflow: None,
                        online: c.online,
                    })
                    .collect();
                if wf == "txt2img" {
                    out.txt2img = tagged;
                } else {
                    out.img2img = tagged;
                }
            }
        }
        Err(e) => out.errors.push(format!("image models: {e}")),
    }
    match img_utils::list_capabilities(state).await {
        Ok(caps) => {
            for c in caps.iter().filter(|c| c.kind == img_utils::KIND_COMFY) {
                for w in &c.workflows {
                    let opt = ModelOption {
                        capability: c.base.clone(),
                        workflow: Some(w.clone()),
                        online: true,
                    };
                    if is_face_swap(w) {
                        out.face_swap.push(opt);
                    } else if is_upscale(w) {
                        out.upscaler.push(opt);
                    }
                }
            }
        }
        Err(e) => out.errors.push(format!("image tools: {e}")),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persona() -> Persona {
        let now = chrono::Utc::now().fixed_offset();
        Persona {
            id: 1,
            user_id: 1,
            name: "Ada".into(),
            system_prompt: "You are {p_name}. You look like: {P_LOOK}. {p_system}".into(),
            look: "red hair, green eyes".into(),
            face_image_ids_json: r#"["5","x","7"]"#.into(),
            llm_capability: None,
            txt2img_capability: None,
            img2img_capability: None,
            face_swap_capability: None,
            upscaler_capability: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn renders_tokens_case_insensitively_and_leaves_others() {
        let p = persona();
        assert_eq!(
            render_tokens(
                "photo of {p_name}, { p_look }, {color} {a|b} {unknown",
                &p,
                false
            ),
            "photo of Ada, red hair, green eyes, {color} {a|b} {unknown"
        );
        assert_eq!(
            rendered_system_prompt(&p),
            "You are Ada. You look like: red hair, green eyes."
        );
        assert_eq!(
            render_tokens("{p_system}", &p, false),
            "You are Ada. You look like: red hair, green eyes."
        );
        assert_eq!(render_tokens("{{p_name}}", &p, false), "{Ada}");
    }

    #[test]
    fn face_ids_skip_garbage() {
        assert_eq!(face_ids(&persona()), vec![5, 7]);
    }

    #[test]
    fn choose_prefers_preference_then_usage_then_first() {
        let c = |s: &str| (s.to_string(), None::<String>);
        let cands = vec![c("llm.a"), c("llm.b")];
        let mut usage = HashMap::new();
        let first = choose(None, &cands, &usage, None).unwrap();
        assert_eq!(
            (first.capability.as_str(), first.source),
            ("llm.a", "first_online")
        );
        usage.insert("llm.b".to_string(), 3);
        let used = choose(None, &cands, &usage, None).unwrap();
        assert_eq!(
            (used.capability.as_str(), used.source),
            ("llm.b", "most_used")
        );
        let pref = choose(Some("llm.z"), &cands, &usage, Some("upscale")).unwrap();
        assert_eq!(pref.source, "preference");
        assert!(!pref.online);
        assert_eq!(pref.workflow.as_deref(), Some("upscale"));
        let only = choose(None, &cands[..1], &HashMap::new(), None).unwrap();
        assert_eq!(only.source, "only");
        assert!(choose(None, &[], &usage, None).is_none());
    }

    #[test]
    fn preference_validation() {
        assert_eq!(
            normalize_pref(Some(" auto ".into()), "llm.", "x").unwrap(),
            None
        );
        assert_eq!(
            normalize_pref(Some("llm.qwen3[vision]".into()), "llm.", "x").unwrap(),
            Some("llm.qwen3".into())
        );
        assert!(normalize_pref(Some("imggen.flux".into()), "llm.", "x").is_err());
    }

    #[test]
    fn tool_kinds() {
        assert!(
            is_face_swap("face_swap") && is_face_swap("Face-Swap2") && !is_face_swap("upscale")
        );
        assert!(is_upscale("upscale_x4") && !is_upscale("depth"));
    }
}
