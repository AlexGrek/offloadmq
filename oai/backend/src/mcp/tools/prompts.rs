//! Prompt library tools — `oai image prompts …` over `db::prompts` /
//! `services::prompt_previews` (the image generation page's `imggen-prompt` and
//! `imggen-negative` buckets).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    db::prompts::{self, KIND_STARRED, PageCursor, PromptEntry},
    error::AppError,
    services::prompt_previews,
};

use super::{
    super::content::ToolOutput,
    DESTRUCTIVE, IDEMPOTENT_WRITE, Id, READ_ONLY, ToolContext, error_text,
    images::{NEGATIVE_BUCKET, PROMPT_BUCKET},
    parse_args, require_ids, tool,
};

/// Longest prompt text shown in a listing; `get_saved_prompt` returns it whole.
const LIST_PREVIEW_CHARS: usize = 400;
/// Mirrors `MAX_QUERY_LEN` in `db/prompts.rs`.
const MAX_QUERY_LEN: usize = 500;

const TOOLS: &[&str] = &[
    "list_saved_prompts",
    "get_saved_prompt",
    "star_prompt",
    "edit_saved_prompt",
    "delete_saved_prompts",
];

pub fn handles(name: &str) -> bool {
    TOOLS.contains(&name)
}

fn negative_schema() -> Value {
    json!({
        "type": "boolean", "default": false,
        "description": "Use the negative-prompt library instead of the prompt library.",
    })
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "list_saved_prompts",
            "List saved prompts",
            "List the user's image prompt library: their starred (favorite) prompts or their \
             recent prompts, newest first, optionally filtered by a case-insensitive search. \
             Same as `oai image prompts recent|starred`.",
            json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["starred", "recent"], "default": "starred" },
                    "negative": negative_schema(),
                    "query": { "type": "string", "description": "Case-insensitive substring filter." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": prompts::MAX_PAGE_SIZE, "default": prompts::DEFAULT_PAGE_SIZE },
                    "cursor": { "type": "string", "description": "next_cursor from a previous page." },
                },
            }),
            READ_ONLY,
        ),
        tool(
            "get_saved_prompt",
            "Get saved prompt",
            "Return the full text of a saved prompt, and the preview image of the last image \
             generated from it when there is one. Same as `oai image prompts show|preview`.",
            json!({
                "type": "object",
                "properties": { "entry_id": { "type": "string" } },
                "required": ["entry_id"],
            }),
            READ_ONLY,
        ),
        tool(
            "star_prompt",
            "Star or unstar a prompt",
            "Add a prompt to the user's starred prompts (by text, or by entry_id of e.g. a recent \
             prompt), or remove it from them with starred=false. Same as \
             `oai image prompts star|unstar`.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Exact prompt text (unstar matches it exactly)." },
                    "entry_id": { "type": "string", "description": "Instead of text: an existing library entry." },
                    "starred": { "type": "boolean", "default": true },
                    "negative": negative_schema(),
                },
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "edit_saved_prompt",
            "Edit saved prompt",
            "Replace the text of a saved prompt. Same as `oai image prompts edit`.",
            json!({
                "type": "object",
                "properties": { "entry_id": { "type": "string" }, "content": { "type": "string" } },
                "required": ["entry_id", "content"],
            }),
            IDEMPOTENT_WRITE,
        ),
        tool(
            "delete_saved_prompts",
            "Delete saved prompts",
            "Delete entries from the prompt library (starred or recent). Same as \
             `oai image prompts delete`.",
            json!({
                "type": "object",
                "properties": { "entry_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 } },
                "required": ["entry_ids"],
            }),
            DESTRUCTIVE,
        ),
    ]
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Result<ToolOutput, AppError> {
    match name {
        "list_saved_prompts" => list(ctx, parse_args(args)?).await,
        "get_saved_prompt" => get(ctx, parse_args(args)?).await,
        "star_prompt" => star(ctx, parse_args(args)?).await,
        "edit_saved_prompt" => edit(ctx, parse_args(args)?).await,
        "delete_saved_prompts" => delete(ctx, parse_args(args)?).await,
        _ => Err(AppError::BadRequest(format!("unknown tool {name}"))),
    }
}

fn bucket(negative: bool) -> &'static str {
    if negative {
        NEGATIVE_BUCKET
    } else {
        PROMPT_BUCKET
    }
}

fn entry_json(e: &PromptEntry) -> Value {
    json!({
        "entry_id": e.id.to_string(),
        "kind": e.kind,
        "library": if e.bucket == NEGATIVE_BUCKET { "negative" } else { "prompt" },
        "content": e.content,
        "last_used_at": e.last_used_at.to_rfc3339(),
        "updated_at": e.updated_at.to_rfc3339(),
        "has_preview": e.preview_updated_at.is_some(),
    })
}

/// Only the image generation libraries are reachable through these tools.
async fn find_image_entry(ctx: &ToolContext, id: i64) -> Result<PromptEntry, AppError> {
    let entry = prompts::find_owned(&ctx.state.db, ctx.user_id, id).await?;
    if entry.bucket != PROMPT_BUCKET && entry.bucket != NEGATIVE_BUCKET {
        return Err(AppError::NotFound);
    }
    Ok(entry)
}

#[derive(Deserialize)]
struct ListArgs {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    negative: bool,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    cursor: Option<String>,
}

async fn list(ctx: &ToolContext, a: ListArgs) -> Result<ToolOutput, AppError> {
    let kind = a.kind.as_deref().unwrap_or(KIND_STARRED);
    let cursor = a
        .cursor
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(PageCursor::parse)
        .transpose()?;
    let page = prompts::list_page(
        &ctx.state.db,
        ctx.user_id,
        bucket(a.negative),
        kind,
        a.query.as_deref(),
        cursor,
        a.limit.unwrap_or(prompts::DEFAULT_PAGE_SIZE),
    )
    .await?;
    let next_cursor = page.next_cursor.map(|c| c.encode());

    let mut lines = Vec::new();
    if page.items.is_empty() {
        lines.push(format!("No {kind} prompts."));
    }
    for e in &page.items {
        let shown: String = e.content.chars().take(LIST_PREVIEW_CHARS).collect();
        let more = if e.content.chars().count() > LIST_PREVIEW_CHARS {
            " …(truncated)"
        } else {
            ""
        };
        let preview = if e.preview_updated_at.is_some() {
            " [has preview]"
        } else {
            ""
        };
        lines.push(format!("[{}]{preview} {shown}{more}", e.id));
    }
    if let Some(c) = &next_cursor {
        lines.push(format!("More available: pass cursor \"{c}\"."));
    }
    let mut out = ToolOutput::text(lines.join("\n"));
    out.set_structured(json!({
        "items": page.items.iter().map(entry_json).collect::<Vec<_>>(),
        "next_cursor": next_cursor,
    }));
    Ok(out)
}

#[derive(Deserialize)]
struct EntryArgs {
    entry_id: Id,
}

async fn get(ctx: &ToolContext, a: EntryArgs) -> Result<ToolOutput, AppError> {
    let entry = find_image_entry(ctx, a.entry_id.0).await?;
    let mut out = ToolOutput::text(entry.content.clone());
    if entry.preview_updated_at.is_some() {
        match prompt_previews::preview_bytes(&ctx.state, ctx.user_id, entry.id).await {
            Ok(jpeg) => {
                out.push_jpeg(&jpeg);
            }
            Err(e) => tracing::debug!("mcp prompt preview unavailable: {e:?}"),
        }
    }
    out.set_structured(entry_json(&entry));
    Ok(out)
}

#[derive(Deserialize)]
struct StarArgs {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    entry_id: Option<Id>,
    #[serde(default)]
    starred: Option<bool>,
    #[serde(default)]
    negative: bool,
}

async fn star(ctx: &ToolContext, a: StarArgs) -> Result<ToolOutput, AppError> {
    let starred = a.starred.unwrap_or(true);
    let source = match a.entry_id {
        Some(Id(id)) => Some(find_image_entry(ctx, id).await?),
        None => None,
    };

    if !starred {
        // Unstar = delete the starred entry, found by id or by exact text.
        let target = match source {
            Some(e) if e.kind == KIND_STARRED => e,
            Some(e) => {
                return Err(AppError::BadRequest(format!(
                    "entry {} is a {} prompt, not a starred one",
                    e.id, e.kind
                )));
            }
            None => {
                let text = a
                    .text
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| AppError::BadRequest("text or entry_id is required".into()))?;
                find_starred_by_text(ctx, bucket(a.negative), text).await?.ok_or_else(|| {
                    AppError::BadRequest("no starred prompt has exactly that text — use list_saved_prompts to find it".into())
                })?
            }
        };
        prompt_previews::delete_entry(&ctx.state, ctx.user_id, target.id).await?;
        return Ok(ToolOutput::text(format!("Unstarred prompt {}.", target.id)));
    }

    let (bucket, text) = match source {
        Some(e) => (e.bucket, e.content),
        None => (
            bucket(a.negative).to_string(),
            a.text
                .ok_or_else(|| AppError::BadRequest("text or entry_id is required".into()))?,
        ),
    };
    let entry = prompts::add_starred(
        &ctx.state.db,
        || ctx.state.next_id(),
        ctx.user_id,
        &bucket,
        &text,
    )
    .await?;
    let mut out = ToolOutput::text(format!("Starred prompt {}.", entry.id));
    out.set_structured(entry_json(&entry));
    Ok(out)
}

/// The starred entry whose (trimmed) content equals `text`, searched with the server's
/// substring filter when the text is short enough, else by scanning every page.
async fn find_starred_by_text(
    ctx: &ToolContext,
    bucket: &str,
    text: &str,
) -> Result<Option<PromptEntry>, AppError> {
    let query = (text.len() <= MAX_QUERY_LEN).then_some(text);
    let mut cursor = None;
    loop {
        let page = prompts::list_page(
            &ctx.state.db,
            ctx.user_id,
            bucket,
            KIND_STARRED,
            query,
            cursor,
            prompts::MAX_PAGE_SIZE,
        )
        .await?;
        if let Some(found) = page.items.into_iter().find(|e| e.content.trim() == text) {
            return Ok(Some(found));
        }
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => return Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct EditArgs {
    entry_id: Id,
    content: String,
}

async fn edit(ctx: &ToolContext, a: EditArgs) -> Result<ToolOutput, AppError> {
    find_image_entry(ctx, a.entry_id.0).await?;
    let entry =
        prompt_previews::update_content(&ctx.state, ctx.user_id, a.entry_id.0, &a.content).await?;
    let mut out = ToolOutput::text(format!("Updated prompt {}.", entry.id));
    out.set_structured(entry_json(&entry));
    Ok(out)
}

#[derive(Deserialize)]
struct DeleteArgs {
    entry_ids: Vec<Id>,
}

async fn delete(ctx: &ToolContext, a: DeleteArgs) -> Result<ToolOutput, AppError> {
    require_ids(&a.entry_ids, "entry_id")?;
    let mut lines = Vec::new();
    for Id(id) in a.entry_ids {
        let result = match find_image_entry(ctx, id).await {
            Ok(_) => prompt_previews::delete_entry(&ctx.state, ctx.user_id, id).await,
            Err(e) => Err(e),
        };
        lines.push(match result {
            Ok(()) => format!("Prompt {id}: deleted"),
            Err(e) => format!("Prompt {id}: not deleted — {}", error_text(&e)),
        });
    }
    Ok(ToolOutput::text(lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_flag_picks_the_bucket() {
        assert_eq!(bucket(false), "imggen-prompt");
        assert_eq!(bucket(true), "imggen-negative");
    }
}
