use std::fs;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::client::Client;
use crate::config::Config;
use crate::output;

/// Resolve `id` to an agent uid, submit `capability`/`payload` pinned to that
/// agent via the management override, and print the result.
fn run(id: &str, capability: &str, payload: Value, timeout_secs: u64) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let agents = client.list_agents(false)?;
    let agent = output::resolve_agent(&agents, id)?;
    let uid = agent.uid.clone();

    let raw = client.run_slavemode(capability, payload, &uid, Duration::from_secs(timeout_secs))?;
    output::print_slavemode_result(capability, &raw)
}

/// Parse a JSON argument that is either a literal JSON object or, when
/// prefixed with `@`, a path to a file containing one (curl-style).
fn parse_json_arg(arg: &str) -> Result<Value> {
    let raw = if let Some(path) = arg.strip_prefix('@') {
        fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?
    } else {
        arg.to_string()
    };
    let value: Value = serde_json::from_str(&raw).context("invalid JSON")?;
    if !value.is_object() {
        bail!("expected a JSON object");
    }
    Ok(value)
}

pub fn force_rescan(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.force-rescan", json!({}), timeout)
}

pub fn update(id: &str, check: bool, timeout: u64) -> Result<()> {
    run(id, "slavemode.agent-update", json!({ "check": check }), timeout)
}

pub fn caps_get(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.special-caps-ctrl", json!({ "get": true }), timeout)
}

pub fn caps_set(id: &str, cap_json: &str, timeout: u64) -> Result<()> {
    let cap = parse_json_arg(cap_json)?;
    run(id, "slavemode.special-caps-ctrl", json!({ "set": cap }), timeout)
}

pub fn caps_delete(id: &str, name: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.special-caps-ctrl", json!({ "delete": name }), timeout)
}

pub fn ollama_list(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.ollama-list", json!({}), timeout)
}

pub fn ollama_pull(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.ollama-pull", json!({ "model": model }), timeout)
}

pub fn ollama_delete(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.ollama-delete", json!({ "model": model }), timeout)
}

pub fn onnx_list(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.onnx-models-list", json!({}), timeout)
}

pub fn onnx_prepare(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.onnx-models-prepare", json!({ "model": model }), timeout)
}

pub fn onnx_delete(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.onnx-models-delete", json!({ "model": model }), timeout)
}
