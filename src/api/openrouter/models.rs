//! Model id ↔ `llm.*` capability mapping and the `GET /api/v1/models` listing.
//!
//! Accepted ids for the capability `llm.qwen3:8b`: `qwen3:8b`, `llm.qwen3:8b`,
//! `offloadmq/qwen3:8b`, plus any alias from `OPENROUTER_MODEL_ALIASES`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};

use super::error::{OrError, OrResult};
use crate::{
    api::client::service::do_capabilities_online,
    state::AppState,
    utils::{base_capability, capability_attrs},
};

const LLM_PREFIX: &str = "llm.";
const NAMESPACE: &str = "offloadmq/";

/// The local model name (`qwen3:8b`) a client model id refers to. Extended
/// attributes are stripped: tasks are always submitted with the BASE capability.
pub fn local_model_name(id: &str, aliases: &[(String, String)]) -> String {
    let id = id.trim();
    let id = aliases
        .iter()
        .find(|(alias, _)| alias == id)
        .map(|(_, model)| model.as_str())
        .unwrap_or(id);
    let id = id.strip_prefix(NAMESPACE).unwrap_or(id);
    let id = id.strip_prefix(LLM_PREFIX).unwrap_or(id);
    base_capability(id).to_string()
}

pub fn capability_for(id: &str, aliases: &[(String, String)]) -> String {
    format!("{LLM_PREFIX}{}", local_model_name(id, aliases))
}

/// A model the request will be run on.
pub struct ResolvedModel {
    /// The id as the client sent it — echoed back in `model`.
    pub requested: String,
    /// Local model name, e.g. `qwen3:8b`.
    pub local: String,
    /// Base capability to submit, e.g. `llm.qwen3:8b`.
    pub capability: String,
}

/// Pick the first candidate (`model`, then the `models` fallbacks) that has an
/// online runner and that the key may use. 403 if runners exist but the key
/// may not use any of them; 404 ("No endpoints found") if none are online.
pub fn resolve(
    state: &Arc<AppState>,
    candidates: &[String],
    api_key: &str,
    skip_owner: bool,
) -> OrResult<ResolvedModel> {
    let Some(first) = candidates.first() else {
        return Err(OrError::bad_request("model is required"));
    };
    let aliases = &state.config.openrouter.model_aliases;
    let online = do_capabilities_online(state, api_key, true, true)?;
    let mut forbidden: Option<String> = None;
    for requested in candidates {
        let capability = capability_for(requested, aliases);
        if !online.contains(&capability) {
            continue;
        }
        if !skip_owner
            && state
                .storage
                .client_keys
                .verify_key(api_key, &capability)
                .is_err()
        {
            forbidden.get_or_insert(requested.clone());
            continue;
        }
        return Ok(ResolvedModel {
            requested: requested.clone(),
            local: local_model_name(requested, aliases),
            capability,
        });
    }
    match forbidden {
        Some(model) => Err(OrError::new(
            axum::http::StatusCode::FORBIDDEN,
            format!("This API key is not allowed to use {model}"),
        )),
        None => Err(OrError::no_endpoints(first)),
    }
}

/// `GET /api/v1/models` entries for every online `llm.*` capability the key
/// may use, plus configured aliases whose target is online.
pub fn list(state: &Arc<AppState>, api_key: &str, skip_owner: bool) -> OrResult<Vec<Value>> {
    // Raw capabilities (with `[attrs]`); merge attributes across agents.
    let raw = do_capabilities_online(state, api_key, skip_owner, false)?;
    let mut models: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for cap in &raw {
        let Some(name) = base_capability(cap).strip_prefix(LLM_PREFIX) else {
            continue;
        };
        let attrs = models.entry(name.to_string()).or_default();
        for a in capability_attrs(cap) {
            if !attrs.iter().any(|x| x == a) {
                attrs.push(a.to_string());
            }
        }
    }

    let mut out: Vec<Value> = models
        .iter()
        .map(|(name, attrs)| model_entry(name, name, attrs))
        .collect();
    for (alias, target) in &state.config.openrouter.model_aliases {
        let local = local_model_name(target, &[]);
        if let Some(attrs) = models.get(&local)
            && !models.contains_key(alias)
        {
            out.push(model_entry(alias, &local, attrs));
        }
    }
    Ok(out)
}

fn model_entry(id: &str, local: &str, attrs: &[String]) -> Value {
    let has = |a: &str| attrs.iter().any(|x| x.eq_ignore_ascii_case(a));
    let mut input = vec!["text"];
    if has("vision") {
        input.push("image");
    }
    let modality = if has("vision") {
        "text+image->text"
    } else {
        "text->text"
    };
    let mut params = vec![
        "max_tokens",
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "seed",
        "stop",
        "presence_penalty",
        "frequency_penalty",
        "repetition_penalty",
        "response_format",
        "structured_outputs",
    ];
    if has("tools") {
        params.extend(["tools", "tool_choice"]);
    }
    if has("thinking") || has("reasoning") {
        params.extend(["reasoning", "include_reasoning"]);
    }
    let description = if id == local {
        format!("{local} served by OffloadMQ agents (Ollama)")
    } else {
        format!("Alias of {local}, served by OffloadMQ agents (Ollama)")
    };
    json!({
        "id": id,
        "canonical_slug": id,
        "name": format!("OffloadMQ: {id}"),
        "created": 0,
        "description": description,
        "context_length": null,
        "architecture": {
            "modality": modality,
            "input_modalities": input,
            "output_modalities": ["text"],
            "tokenizer": "Other",
            "instruct_type": null,
        },
        "pricing": {
            "prompt": "0",
            "completion": "0",
            "request": "0",
            "image": "0",
        },
        "top_provider": {
            "context_length": null,
            "max_completion_tokens": null,
            "is_moderated": false,
        },
        "per_request_limits": null,
        "supported_parameters": params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliases() -> Vec<(String, String)> {
        vec![
            (
                "meta-llama/llama-3.1-8b-instruct".into(),
                "llama3.1:8b".into(),
            ),
            ("gpt".into(), "llm.qwen3:8b".into()),
        ]
    }

    #[test]
    fn prefixes_are_accepted() {
        for id in [
            "qwen3:8b",
            "llm.qwen3:8b",
            "offloadmq/qwen3:8b",
            " qwen3:8b ",
        ] {
            assert_eq!(capability_for(id, &[]), "llm.qwen3:8b", "{id}");
        }
    }

    #[test]
    fn extended_attributes_are_stripped() {
        assert_eq!(
            capability_for("llm.qwen3:8b[vision;tools]", &[]),
            "llm.qwen3:8b"
        );
    }

    #[test]
    fn aliases_resolve_to_local_models() {
        let a = aliases();
        assert_eq!(
            capability_for("meta-llama/llama-3.1-8b-instruct", &a),
            "llm.llama3.1:8b"
        );
        assert_eq!(local_model_name("gpt", &a), "qwen3:8b");
        assert_eq!(capability_for("other/model", &a), "llm.other/model");
    }

    #[test]
    fn model_entry_reflects_attributes() {
        let e = model_entry(
            "qwen2.5vl:7b",
            "qwen2.5vl:7b",
            &["vision".into(), "tools".into()],
        );
        assert_eq!(
            e["architecture"]["input_modalities"],
            json!(["text", "image"])
        );
        let params = e["supported_parameters"].as_array().unwrap();
        assert!(params.contains(&json!("tools")));
        assert_eq!(e["pricing"]["prompt"], json!("0"));

        let plain = model_entry("mistral", "mistral", &[]);
        assert_eq!(plain["architecture"]["input_modalities"], json!(["text"]));
        assert!(
            !plain["supported_parameters"]
                .as_array()
                .unwrap()
                .contains(&json!("tools"))
        );
    }
}
