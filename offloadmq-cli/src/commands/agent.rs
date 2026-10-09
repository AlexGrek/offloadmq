use std::fs;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::client::Client;
use crate::config::Config;
use crate::output;

/// Resolve `id` to an agent uid and submit `capability`/`payload` pinned to
/// that agent via the management override, returning the raw task response.
fn submit(id: &str, capability: &str, payload: Value, timeout_secs: u64) -> Result<Value> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let agents = client.list_agents(false)?;
    let agent = output::resolve_agent(&agents, id)?;
    let uid = agent.uid.clone();

    client.run_slavemode(capability, payload, &uid, Duration::from_secs(timeout_secs))
}

/// [`submit`], then print the result.
fn run(id: &str, capability: &str, payload: Value, timeout_secs: u64) -> Result<()> {
    let raw = submit(id, capability, payload, timeout_secs)?;
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

/// Bundles in a `comfy import` file: a single bundle object, or an array of them
/// (what `comfy export -o -` prints for several workflows).
fn read_bundles(path: &str) -> Result<Vec<Value>> {
    let raw = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
    let value: Value =
        serde_json::from_str(&raw).with_context(|| format!("{path}: invalid JSON"))?;
    match value {
        Value::Array(items) => Ok(items),
        obj @ Value::Object(_) => Ok(vec![obj]),
        _ => bail!("{path}: expected a bundle object or an array of bundles"),
    }
}

pub fn force_rescan(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.force-rescan", json!({}), timeout)
}

pub fn update(id: &str, check: bool, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.agent-update",
        json!({ "check": check }),
        timeout,
    )
}

pub fn caps_get(id: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.special-caps-ctrl",
        json!({ "get": true }),
        timeout,
    )
}

pub fn caps_set(id: &str, cap_json: &str, timeout: u64) -> Result<()> {
    let cap = parse_json_arg(cap_json)?;
    run(
        id,
        "slavemode.special-caps-ctrl",
        json!({ "set": cap }),
        timeout,
    )
}

pub fn caps_delete(id: &str, name: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.special-caps-ctrl",
        json!({ "delete": name }),
        timeout,
    )
}

/// File name for an exported bundle: `<name>.omqwf.json`, `<ns>.<name>.omqwf.json`
/// for namespaced workflows. Anything outside `[A-Za-z0-9._-]` becomes `_` so a
/// hostile agent cannot steer the write outside the output directory.
fn bundle_file_name(bundle: &Value) -> String {
    let field = |k: &str| bundle.get(k).and_then(Value::as_str).unwrap_or("");
    let (ns, name) = (field("namespace"), field("name"));
    let stem = if ns.is_empty() {
        name.to_string()
    } else {
        format!("{ns}.{name}")
    };
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{}.omqwf.json", safe.trim_start_matches('.'))
}

pub fn comfy_export(
    id: &str,
    workflow: Option<&str>,
    output_path: Option<&str>,
    timeout: u64,
) -> Result<()> {
    const CAP: &str = "slavemode.comfy-export";
    let payload = match workflow {
        Some(w) => json!({ "workflow": w }),
        None => json!({}),
    };
    let raw = submit(id, CAP, payload, timeout)?;
    if raw.get("status").and_then(Value::as_str) != Some("completed") {
        return output::print_slavemode_result(CAP, &raw);
    }
    let bundles = raw
        .get("result")
        .or_else(|| raw.get("output"))
        .and_then(|r| r.get("bundles"))
        .and_then(Value::as_array)
        .context("agent returned no bundles")?;

    if output_path == Some("-") {
        let doc = match bundles.as_slice() {
            [one] => one.clone(),
            _ => Value::Array(bundles.clone()),
        };
        println!("{}", serde_json::to_string_pretty(&doc)?);
        return Ok(());
    }

    // `-o file` is honoured for a single bundle; otherwise `-o` (or `.`) is a directory.
    let single_file = match (bundles.as_slice(), output_path) {
        ([_], Some(p)) if !Path::new(p).is_dir() && !p.ends_with(['/', '\\']) => Some(p),
        _ => None,
    };
    let dir = Path::new(output_path.unwrap_or("."));
    if single_file.is_none() {
        fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    }
    for bundle in bundles {
        let dest = match single_file {
            Some(p) => Path::new(p).to_path_buf(),
            None => dir.join(bundle_file_name(bundle)),
        };
        fs::write(&dest, serde_json::to_string_pretty(bundle)?)
            .with_context(|| format!("failed to write {}", dest.display()))?;
        println!("exported -> {}", dest.display());
    }
    println!("{} workflow(s) exported", bundles.len());
    Ok(())
}

pub fn comfy_import(
    id: &str,
    files: &[String],
    overwrite: bool,
    name: Option<&str>,
    namespace: Option<&str>,
    timeout: u64,
) -> Result<()> {
    let mut bundles = Vec::new();
    for f in files {
        bundles.extend(read_bundles(f)?);
    }
    if (name.is_some() || namespace.is_some()) && bundles.len() != 1 {
        bail!("--name / --namespace apply to a single bundle only");
    }
    let mut payload = json!({ "bundles": bundles, "overwrite": overwrite });
    if let Some(n) = name {
        payload["name"] = json!(n);
    }
    if let Some(ns) = namespace {
        payload["namespace"] = json!(ns);
    }
    run(id, "slavemode.comfy-import", payload, timeout)
}

pub fn ollama_list(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.ollama-list", json!({}), timeout)
}

pub fn ollama_pull(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.ollama-pull",
        json!({ "model": model }),
        timeout,
    )
}

pub fn ollama_delete(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.ollama-delete",
        json!({ "model": model }),
        timeout,
    )
}

pub fn onnx_list(id: &str, timeout: u64) -> Result<()> {
    run(id, "slavemode.onnx-models-list", json!({}), timeout)
}

pub fn onnx_prepare(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.onnx-models-prepare",
        json!({ "model": model }),
        timeout,
    )
}

pub fn onnx_delete(id: &str, model: &str, timeout: u64) -> Result<()> {
    run(
        id,
        "slavemode.onnx-models-delete",
        json!({ "model": model }),
        timeout,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_file_names_are_namespaced_and_sanitised() {
        assert_eq!(
            bundle_file_name(&json!({"name": "my-sdxl", "namespace": ""})),
            "my-sdxl.omqwf.json"
        );
        assert_eq!(
            bundle_file_name(&json!({"name": "depth", "namespace": "img-utils"})),
            "img-utils.depth.omqwf.json"
        );
        // A hostile agent must not be able to leave the output directory.
        let name = bundle_file_name(&json!({"name": "../../etc/passwd", "namespace": ""}));
        assert!(!name.contains('/') && !name.starts_with('.'), "{name}");
    }

    #[test]
    fn read_bundles_accepts_object_or_array() {
        let dir = std::env::temp_dir().join(format!("omqcli-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let one = dir.join("one.json");
        let many = dir.join("many.json");
        fs::write(&one, r#"{"format":"x"}"#).unwrap();
        fs::write(&many, r#"[{"a":1},{"b":2}]"#).unwrap();
        assert_eq!(read_bundles(one.to_str().unwrap()).unwrap().len(), 1);
        assert_eq!(read_bundles(many.to_str().unwrap()).unwrap().len(), 2);
        fs::write(&one, "3").unwrap();
        assert!(read_bundles(one.to_str().unwrap()).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
