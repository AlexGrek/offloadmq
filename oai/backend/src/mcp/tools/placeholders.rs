//! Custom prompt placeholder tools — `oai image placeholders …` over
//! `db::prompt_placeholders`, plus `expand_prompt` (`placeholders expand`).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    db::prompt_placeholders::{self, Placeholder},
    error::AppError,
    services::prompt_expansion::{BUILTIN_CATEGORIES, PromptExpander},
};

use super::{
    super::content::ToolOutput, DESTRUCTIVE, IDEMPOTENT_WRITE, READ_ONLY, ToolContext, error_text,
    parse_args, tool,
};

const MAX_EXPANSIONS: u32 = 10;

const TOOLS: &[&str] = &[
    "list_placeholders",
    "save_placeholder",
    "delete_placeholders",
    "expand_prompt",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_placeholders",
            "List prompt placeholders",
            "List the user's custom prompt placeholders ({name} → one random variant per use) \
             and the built-in ones. Same as `oai image placeholders list`.",
            json!({ "type": "object", "properties": {} }),
            READ_ONLY,
        ),
        tool(
            "save_placeholder",
            "Create or update a placeholder",
            "Create a custom placeholder, or change an existing one: replace its variants, \
             add or remove individual variants, or rename it. Variants may themselves contain \
             placeholders. Same as `oai image placeholders create|set|add|remove|rename`.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Placeholder name (letters, digits, . - _), with or without braces; or the ID of an existing one." },
                    "variants": { "type": "array", "items": { "type": "string" }, "description": "Replace all variants with these." },
                    "add_variants": { "type": "array", "items": { "type": "string" } },
                    "remove_variants": { "type": "array", "items": { "type": "string" }, "description": "Exact variant texts to remove." },
                    "rename_to": { "type": "string" },
                },
                "required": ["name"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "delete_placeholders",
            "Delete placeholders",
            "Delete custom placeholders by name or ID. Same as `oai image placeholders delete`.",
            json!({
                "type": "object",
                "properties": { "names": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["names"],
            }),
            DESTRUCTIVE,
        ),
        tool(
            "expand_prompt",
            "Preview prompt expansion",
            "Show what a prompt with placeholders expands to, exactly as generate_images would \
             expand it (no repeats within the batch). {?} is shown as-is: it becomes a random \
             name only when a job is created. Same as `oai image placeholders expand`.",
            json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string" },
                    "count": { "type": "integer", "minimum": 1, "maximum": MAX_EXPANSIONS, "default": 1 },
                },
                "required": ["prompt"],
            }),
            READ_ONLY,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "list_placeholders" => list(ctx).await,
        "save_placeholder" => save(ctx, parse_args(args)?).await,
        "delete_placeholders" => delete(ctx, parse_args(args)?).await,
        "expand_prompt" => expand(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

fn placeholder_json(p: &Placeholder) -> Result<Value, AppError> {
    Ok(
        json!({ "id": p.id.to_string(), "name": p.name, "variants": prompt_placeholders::decode_variants(p)? }),
    )
}

/// Strips surrounding braces: `{.style}` → `.style`.
fn bare_name(name: &str) -> &str {
    let n = name.trim();
    n.strip_prefix('{')
        .and_then(|r| r.strip_suffix('}'))
        .unwrap_or(n)
        .trim()
}

/// Finds a placeholder by name (case-insensitive, braces optional) or ID, like the CLI's
/// `findPlaceholder`.
fn find<'a>(all: &'a [Placeholder], key: &str) -> Option<&'a Placeholder> {
    let key = bare_name(key);
    all.iter()
        .find(|p| p.name.eq_ignore_ascii_case(key))
        .or_else(|| {
            key.parse::<i64>()
                .ok()
                .and_then(|id| all.iter().find(|p| p.id == id))
        })
}

async fn list(ctx: &ToolContext) -> Result<ToolOutput, AppError> {
    let all = prompt_placeholders::list_for_user(&ctx.state.db, ctx.user_id).await?;
    let mut lines = vec![format!(
        "Built-in: {} (random words), {{?}} (random two-word name).",
        BUILTIN_CATEGORIES
            .iter()
            .map(|c| format!("{{{c}}}"))
            .collect::<Vec<_>>()
            .join(" ")
    )];
    if all.is_empty() {
        lines.push("No custom placeholders yet.".into());
    }
    let mut items = Vec::new();
    for p in &all {
        let variants = prompt_placeholders::decode_variants(p)?;
        lines.push(format!(
            "{{{}}} [{}]: {}",
            p.name,
            p.id,
            variants.join(" | ")
        ));
        items.push(placeholder_json(p)?);
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({ "builtin": BUILTIN_CATEGORIES, "custom": items }));
    Ok(out)
}

#[derive(Deserialize)]
struct SaveArgs {
    name: String,
    #[serde(default)]
    variants: Option<Vec<String>>,
    #[serde(default)]
    add_variants: Vec<String>,
    #[serde(default)]
    remove_variants: Vec<String>,
    #[serde(default)]
    rename_to: Option<String>,
}

/// Applies replace → add (skipping duplicates) → remove to a variant list.
fn merge_variants(
    current: Vec<String>,
    replace: Option<Vec<String>>,
    add: Vec<String>,
    remove: &[String],
) -> Vec<String> {
    let mut variants = replace.unwrap_or(current);
    for v in add {
        let v = v.trim().to_string();
        if !v.is_empty() && !variants.iter().any(|x| x.trim() == v) {
            variants.push(v);
        }
    }
    variants.retain(|v| !remove.iter().any(|r| r.trim() == v.trim()));
    variants
}

async fn save(ctx: &ToolContext, a: SaveArgs) -> Result<ToolOutput, AppError> {
    let all = prompt_placeholders::list_for_user(&ctx.state.db, ctx.user_id).await?;
    let rename = a
        .rename_to
        .as_deref()
        .map(bare_name)
        .filter(|n| !n.is_empty());
    let (row, verb) = match find(&all, &a.name) {
        Some(existing) => {
            let current = prompt_placeholders::decode_variants(existing)?;
            let variants = merge_variants(current, a.variants, a.add_variants, &a.remove_variants);
            let name = rename.unwrap_or(&existing.name);
            // Validation (charset, reserved names, uniqueness, empty) is the DB layer's.
            let row = prompt_placeholders::update(
                &ctx.state.db,
                ctx.user_id,
                existing.id,
                name,
                variants,
            )
            .await?;
            (row, "Updated")
        }
        None => {
            let variants =
                merge_variants(Vec::new(), a.variants, a.add_variants, &a.remove_variants);
            let name = rename.unwrap_or(bare_name(&a.name));
            let row = prompt_placeholders::create(
                &ctx.state.db,
                || ctx.state.next_id(),
                ctx.user_id,
                name,
                variants,
            )
            .await?;
            (row, "Created")
        }
    };
    let variants = prompt_placeholders::decode_variants(&row)?;
    let mut out = ToolOutput::text(format!("{verb} {{{}}}: {}", row.name, variants.join(" | ")));
    out.set_structured(placeholder_json(&row)?);
    Ok(out)
}

#[derive(Deserialize)]
struct DeleteArgs {
    names: Vec<String>,
}

async fn delete(ctx: &ToolContext, a: DeleteArgs) -> Result<ToolOutput, AppError> {
    if a.names.iter().all(|n| n.trim().is_empty()) {
        return Err(AppError::BadRequest("at least one name is required".into()));
    }
    let all = prompt_placeholders::list_for_user(&ctx.state.db, ctx.user_id).await?;
    let mut lines = Vec::new();
    for name in a.names.iter().filter(|n| !n.trim().is_empty()) {
        lines.push(match find(&all, name) {
            Some(p) => match prompt_placeholders::delete(&ctx.state.db, ctx.user_id, p.id).await {
                Ok(()) => format!("{{{}}}: deleted", p.name),
                Err(e) => format!("{{{}}}: not deleted — {}", p.name, error_text(&e)),
            },
            None => format!("{name}: no such placeholder"),
        });
    }
    Ok(ToolOutput::text(lines.join("\n")))
}

#[derive(Deserialize)]
struct ExpandArgs {
    prompt: String,
    #[serde(default)]
    count: Option<u32>,
}

async fn expand(ctx: &ToolContext, a: ExpandArgs) -> Result<ToolOutput, AppError> {
    let count = a.count.unwrap_or(1);
    if !(1..=MAX_EXPANSIONS).contains(&count) {
        return Err(AppError::BadRequest(format!(
            "count must be between 1 and {MAX_EXPANSIONS}"
        )));
    }
    let mut expander = PromptExpander::for_user(&ctx.state.db, ctx.user_id).await?;
    let template = a.prompt.trim();
    let expansions: Vec<String> = (0..count)
        .map(|_| expander.expand(template).map(|p| p.trim().to_string()))
        .collect::<Result<_, _>>()?;
    let mut out = ToolOutput::text(expansions.join("\n"));
    out.set_structured(json!({ "expansions": expansions }));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ph(id: i64, name: &str) -> Placeholder {
        let now = chrono::Utc::now().fixed_offset();
        Placeholder {
            id,
            user_id: 1,
            name: name.into(),
            variants_json: "[\"a\"]".into(),
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn find_by_name_braces_case_or_id() {
        let all = vec![ph(10, ".Style"), ph(20, "mood")];
        assert_eq!(find(&all, "{.style}").map(|p| p.id), Some(10));
        assert_eq!(find(&all, "MOOD").map(|p| p.id), Some(20));
        assert_eq!(find(&all, "20").map(|p| p.id), Some(20));
        assert!(find(&all, "nope").is_none());
    }

    #[test]
    fn variant_merging() {
        let cur = vec!["a".to_string(), "b".to_string()];
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            merge_variants(cur.clone(), None, s(&["c", "a", " "]), &[]),
            s(&["a", "b", "c"])
        );
        assert_eq!(
            merge_variants(cur.clone(), None, vec![], &s(&["a"])),
            s(&["b"])
        );
        assert_eq!(
            merge_variants(cur, Some(s(&["x"])), s(&["y"]), &s(&["x"])),
            s(&["y"])
        );
    }
}
