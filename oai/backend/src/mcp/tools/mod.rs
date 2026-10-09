//! MCP tool registry. Each tool mirrors an `oai image …` CLI command (see the table in
//! `docs/mcp.md`); keep the two in step when either changes.

mod images;
mod placeholders;
mod prompts;

use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::error::AppError;

use super::{ToolContext, content::ToolOutput};

/// Every tool definition, in a fixed order (deterministic `tools/list`).
pub fn definitions() -> Vec<Value> {
    let mut defs = images::definitions();
    defs.extend(prompts::definitions());
    defs.extend(placeholders::definitions());
    defs
}

/// Runs a tool. `None` means there is no tool by that name.
pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> Option<ToolOutput> {
    let result = match name {
        n if images::handles(n) => images::call(ctx, n, args).await,
        n if prompts::handles(n) => prompts::call(ctx, n, args).await,
        n if placeholders::handles(n) => placeholders::call(ctx, n, args).await,
        _ => return None,
    };
    Some(result.unwrap_or_else(ToolOutput::from))
}

/// A tool definition with its annotations.
fn tool(name: &str, title: &str, description: &str, input_schema: Value, hints: Hints) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "title": title,
            "readOnlyHint": hints.read_only,
            "destructiveHint": hints.destructive,
            "idempotentHint": hints.idempotent,
            "openWorldHint": false,
        },
    })
}

#[derive(Clone, Copy)]
struct Hints {
    read_only: bool,
    destructive: bool,
    idempotent: bool,
}

const READ_ONLY: Hints = Hints {
    read_only: true,
    destructive: false,
    idempotent: true,
};
const WRITE: Hints = Hints {
    read_only: false,
    destructive: false,
    idempotent: false,
};
const IDEMPOTENT_WRITE: Hints = Hints {
    read_only: false,
    destructive: false,
    idempotent: true,
};
const DESTRUCTIVE: Hints = Hints {
    read_only: false,
    destructive: true,
    idempotent: true,
};

fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, AppError> {
    // A client may send `null` / omit `arguments` for a tool with no required fields.
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args)
        .map_err(|e| AppError::BadRequest(format!("invalid arguments: {e}")))
}

/// A snowflake ID passed as a JSON string (how tools return them) or number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Id(pub i64);

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Num(i64),
            Str(String),
        }
        match Raw::deserialize(d)? {
            Raw::Num(n) => Ok(Id(n)),
            Raw::Str(s) => s
                .trim()
                .parse()
                .map(Id)
                .map_err(|_| serde::de::Error::custom(format!("invalid id: {s:?}"))),
        }
    }
}

/// Rejects an empty ID list, like the CLI's `requireIDs`.
fn require_ids(ids: &[Id], what: &str) -> Result<(), AppError> {
    if ids.is_empty() {
        return Err(AppError::BadRequest(format!(
            "at least one {what} is required"
        )));
    }
    Ok(())
}

/// Short text for a per-ID failure in a multi-ID tool.
fn error_text(e: &AppError) -> String {
    match e {
        AppError::NotFound => "not found".into(),
        AppError::BadRequest(m) | AppError::ExternalService(m) | AppError::Internal(m) => m.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_from_strings_and_numbers() {
        let ids: Vec<Id> = serde_json::from_value(json!(["123", 456, " 789 "])).unwrap();
        assert_eq!(ids, vec![Id(123), Id(456), Id(789)]);
        assert!(serde_json::from_value::<Id>(json!("abc")).is_err());
    }

    #[test]
    fn definitions_are_unique_and_well_formed() {
        let defs = definitions();
        let mut names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        let n = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), n, "duplicate tool names");
        for d in &defs {
            let name = d["name"].as_str().unwrap();
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{name}"
            );
            assert_eq!(d["inputSchema"]["type"], "object", "{name}");
            assert!(!d["description"].as_str().unwrap().is_empty(), "{name}");
            assert!(
                images::handles(name) || prompts::handles(name) || placeholders::handles(name),
                "{name}"
            );
        }
    }
}
