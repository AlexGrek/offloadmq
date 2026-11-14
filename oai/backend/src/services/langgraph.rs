//! Editable LangGraph programs executed only on opted-in OffloadMQ runners.
use crate::{
    db::{
        entities::langgraph_jobs::Entity,
        langgraph::{self, LanggraphJob},
        offload_jobs,
    },
    error::AppError,
    offload::{
        CapabilityInfo,
        task_status::{self, NormalizedPoll, OffloadPoller},
    },
    services::{
        image_paths, offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        prompt_usage, storage,
    },
    state::AppState,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputDefinition {
    #[serde(default)]
    pub data_file: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}
impl Default for OutputDefinition {
    fn default() -> Self {
        Self {
            data_file: None,
            files: vec![],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartJobParams {
    pub capability: String,
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    pub main_py: String,
    pub tools_py: String,
    pub pyproject: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub user_prompt: String,
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default = "empty_object")]
    pub resources: Value,
    #[serde(default)]
    pub output: OutputDefinition,
    #[serde(default = "default_runtime")]
    pub runtime_secs: u32,
}
fn empty_object() -> Value {
    json!({})
}
fn default_runtime() -> u32 {
    600
}
fn bad(message: impl Into<String>) -> AppError {
    AppError::BadRequest(message.into())
}
fn valid_model(s: &str) -> bool {
    !s.is_empty()
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '[' | ']'))
}
fn relative_path(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && !s.contains(['\\', ':'])
        && !s.chars().any(char::is_control)
        && s.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
        && s != "main.py"
        && s != "tools.py"
}

/// Only standard project dependencies are translated to the runner's requirements.
/// Reject uv sources/groups/extras instead of silently running a different project.
pub fn parse_dependencies(source: &str) -> Result<Vec<String>, AppError> {
    if source.len() > 65536 {
        return Err(bad("pyproject.toml exceeds 64 KiB"));
    }
    let doc: toml::Value =
        toml::from_str(source).map_err(|e| bad(format!("Invalid pyproject.toml: {e}")))?;
    for section in ["tool", "build-system", "dependency-groups"] {
        if doc.get(section).is_some() {
            return Err(bad(format!(
                "{section} is unsupported; use [project].dependencies"
            )));
        }
    }
    let project = doc
        .get("project")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| bad("pyproject.toml needs a [project] table"))?;
    if project.contains_key("dynamic") || project.contains_key("optional-dependencies") {
        return Err(bad(
            "Dynamic and optional dependencies are unsupported; put runtime dependencies in [project].dependencies",
        ));
    }
    if let Some(version) = project.get("requires-python") {
        if version.as_str() != Some(">=3.11") && version.as_str() != Some("==3.11.*") {
            return Err(bad(
                "Runners use Python 3.11; omit requires-python or use >=3.11 / ==3.11.*",
            ));
        }
    }
    let deps = project
        .get("dependencies")
        .and_then(toml::Value::as_array)
        .ok_or_else(|| bad("[project].dependencies must be an array of strings"))?;
    if deps.len() > 128 {
        return Err(bad("At most 128 dependencies are allowed"));
    }
    deps.iter()
        .map(|v| {
            v.as_str()
                .filter(|s| {
                    !s.trim().is_empty() && s.len() <= 4096 && !s.contains(['\n', '\r', '\0'])
                })
                .map(str::to_owned)
                .ok_or_else(|| bad("Dependencies must be nonempty requirement strings"))
        })
        .collect()
}

pub fn runtime_payload(req: &StartJobParams) -> Result<Value, AppError> {
    let model = req
        .capability
        .strip_prefix("llm-runtime.")
        .filter(|m| valid_model(m))
        .ok_or_else(|| bad("Choose an llm-runtime model"))?;
    if req.models.len() > 16
        || req.models.iter().any(|(role, model)| {
            role.is_empty()
                || role.len() > 64
                || role.chars().any(|c| c.is_whitespace() || c.is_control())
                || !valid_model(model)
        })
    {
        return Err(bad("Invalid named model selection (at most 16 roles)"));
    }
    if req.main_py.trim().is_empty() || req.main_py.len() + req.tools_py.len() > 1024 * 1024 {
        return Err(bad(
            "main.py is required; combined code must be at most 1 MiB",
        ));
    }
    if req.system_prompt.len() > 65536 || req.user_prompt.len() > 65536 {
        return Err(bad("Prompts must be at most 64 KiB each"));
    }
    if !(1..=3600).contains(&req.runtime_secs) {
        return Err(bad("Runtime must be between 1 and 3600 seconds"));
    }
    if req.resources.to_string().len() > 65536 {
        return Err(bad("Resources JSON exceeds 64 KiB"));
    }
    if req.allowed_tools.as_ref().is_some_and(|tools| {
        tools.len() > 128
            || tools
                .iter()
                .any(|t| t.is_empty() || t.len() > 128 || t.chars().any(char::is_control))
    }) {
        return Err(bad("Invalid tool allowlist"));
    }
    let mut paths = HashSet::new();
    if req.output.files.len() > 16 {
        return Err(bad("At most 16 output files are allowed"));
    }
    for path in req.output.files.iter().chain(req.output.data_file.iter()) {
        if path.len() > 512 || !relative_path(path) || !paths.insert(path) {
            return Err(bad(
                "Outputs need unique relative paths, excluding main.py and tools.py",
            ));
        }
    }
    Ok(json!({
        "model": model, "models": req.models,
        "entrypoint": "main.py", "files": {"main.py": req.main_py, "tools.py": req.tools_py},
        "dependencies": parse_dependencies(&req.pyproject)?,
        "system_prompt": req.system_prompt, "user_prompt": req.user_prompt,
        "allowed_tools": req.allowed_tools, "resources": req.resources, "output": req.output,
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: usize,
}
fn stored_artifacts(job: &LanggraphJob) -> Result<Vec<Artifact>, AppError> {
    serde_json::from_str(&job.artifacts_json)
        .map_err(|e| AppError::Internal(format!("Invalid artifact metadata: {e}")))
}
struct LanggraphReconciler;
#[async_trait]
impl JobReconciler for LanggraphReconciler {
    type Entity = Entity;
    fn label(&self) -> &'static str {
        "langgraph"
    }
    fn failure_fallback(&self) -> &'static str {
        "LangGraph runtime failed"
    }
    async fn poller(&self, state: &AppState) -> Result<Box<dyn OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::chat_client(state).await?))
    }
    async fn on_poll(
        &self,
        state: &AppState,
        job: &LanggraphJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        if matches!(poll.status.as_str(), "failed" | "canceled") {
            if let Some(output) = &poll.output {
                langgraph::set_output(
                    &state.db,
                    job.id,
                    output.to_string(),
                    job.artifacts_json.clone(),
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn on_completed(
        &self,
        state: &AppState,
        job: &LanggraphJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        let output = poll
            .output
            .as_ref()
            .filter(|v| v.get("stdout").and_then(Value::as_str).is_some())
            .ok_or_else(|| bad("Runtime returned no stdout"))?;
        let req: StartJobParams = serde_json::from_str(&job.request_json)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let client = offload_factory::image_client(state).await?;
        let mut artifacts = vec![];
        let files = output
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("Runtime returned invalid artifact metadata"))?;
        if files.len() != req.output.files.len() {
            return Err(bad("Runtime returned an unexpected artifact count"));
        }
        for (i, file) in files.iter().enumerate() {
            let name = file["filename"]
                .as_str()
                .ok_or_else(|| bad("Missing artifact filename"))?;
            let bucket = file["bucket_uid"]
                .as_str()
                .filter(|b| Some(*b) == job.offload_bucket_uid.as_deref())
                .ok_or_else(|| bad("Unexpected artifact bucket"))?;
            if name != req.output.files[i] {
                return Err(bad("Unexpected artifact filename"));
            }
            let uid = file["file_uid"]
                .as_str()
                .filter(|s| {
                    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
                .ok_or_else(|| bad("Invalid artifact id"))?;
            let (bytes, content_type) = client.download_bucket_file(bucket, uid).await?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err(bad("Artifact exceeds 64 MiB"));
            }
            artifacts.push(Artifact {
                filename: name.into(),
                content_type,
                size_bytes: bytes.len(),
            });
            storage::write(
                storage::operator(state)?,
                &image_paths::langgraph_artifact_path(job.user_id, job.id, i),
                bytes,
            )
            .await?;
        }
        langgraph::set_output(
            &state.db,
            job.id,
            output.to_string(),
            serde_json::to_string(&artifacts).map_err(|e| AppError::Internal(e.to_string()))?,
        )
        .await?;
        offload_jobs::update_status::<Entity>(&state.db, job.id, "completed", None, None).await
    }
}

pub async fn list_capabilities(state: &AppState) -> Result<Vec<CapabilityInfo>, AppError> {
    offload_factory::chat_client(state)
        .await?
        .list_capabilities_with_prefix("llm-runtime.")
        .await
}
pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    let payload = runtime_payload(&req)?;
    let client = offload_factory::chat_client(state).await?;
    let caps = client.list_capabilities_with_prefix("llm-runtime.").await?;
    let needed = std::iter::once(req.capability.clone())
        .chain(req.models.values().map(|m| format!("llm-runtime.{m}")));
    for cap in needed {
        if !caps.iter().any(|c| c.base == cap) {
            return Err(bad(format!("Runtime model is unavailable: {cap}")));
        }
    }
    if !req.output.files.is_empty() {
        storage::operator(state)?;
    }
    let request_json =
        serde_json::to_string(&req).map_err(|e| AppError::Internal(e.to_string()))?;
    let id = state.next_id();
    langgraph::create_job(
        &state.db,
        id,
        user_id,
        &req.capability,
        &req.user_prompt,
        request_json,
    )
    .await?;
    let mut bucket: Option<String> = None;
    let submission = async {
        if !req.output.files.is_empty() {
            bucket = Some(
                offload_factory::image_client(state)
                    .await?
                    .create_bucket(false)
                    .await?
                    .bucket_uid,
            );
        }
        let task = client
            .submit_runtime(
                &req.capability,
                payload,
                bucket.as_deref(),
                req.runtime_secs,
            )
            .await?;
        // If recording the link fails, cancel the upstream task before releasing its bucket.
        if let Err(e) = offload_jobs::set_offload_task::<Entity>(
            &state.db,
            id,
            &task.cap,
            &task.id,
            bucket.as_deref(),
        )
        .await
        {
            if let Err(cancel_error) = client.cancel_task(&task).await {
                tracing::warn!("langgraph: failed to cancel unlinked task: {cancel_error}");
            }
            return Err(e);
        }
        state.watch.track(&task.cap, &task.id).await;
        Ok::<_, AppError>(())
    }
    .await;
    if let Err(e) = submission {
        if let Some(bucket) = &bucket {
            if let Err(cleanup) = client.delete_bucket(bucket).await {
                tracing::warn!("langgraph: bucket cleanup failed: {cleanup}");
            }
        }
        offload_jobs::update_status::<Entity>(&state.db, id, "failed", None, Some(&e.to_string()))
            .await?;
        return Err(e);
    }
    prompt_usage::note_use(state, user_id, "langgraph-system", &req.system_prompt).await;
    prompt_usage::note_use(state, user_id, "langgraph-user", &req.user_prompt).await;
    Ok(id)
}
pub async fn get_job(state: &AppState, user_id: i64, id: i64) -> Result<LanggraphJob, AppError> {
    offload_jobs::get_job::<Entity>(&state.db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}
pub async fn retry_job(state: &AppState, user_id: i64, id: i64) -> Result<i64, AppError> {
    let job = get_job(state, user_id, id).await?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(bad("Only failed or canceled runs can be retried"));
    }
    let req = serde_json::from_str(&job.request_json)
        .map_err(|e| AppError::Internal(format!("Invalid saved request: {e}")))?;
    start_job(state, user_id, req).await
}
pub async fn poll_job(state: &AppState, user_id: i64, id: i64) -> Result<LanggraphJob, AppError> {
    offload_job::poll_job(&LanggraphReconciler, state, user_id, id).await
}
pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&LanggraphReconciler, state, user_id, id).await
}
pub async fn list_jobs(state: &AppState, user_id: i64) -> Result<Vec<LanggraphJob>, AppError> {
    offload_jobs::list_jobs::<Entity>(&state.db, user_id, 100).await
}
pub async fn run_background_reconcile_pass(state: &AppState, batch: u64) -> Result<(), AppError> {
    offload_job::reconcile_pass(&LanggraphReconciler, state, batch).await
}
pub async fn delete_job(state: &AppState, user_id: i64, id: i64) -> Result<(), AppError> {
    let job = get_job(state, user_id, id).await?;
    if !task_status::is_terminal(&job.status) {
        return Err(bad("Cancel the run before deleting it"));
    }
    // Clean deterministic paths too: a partial download may precede a failed DB write.
    let req: StartJobParams =
        serde_json::from_str(&job.request_json).map_err(|e| AppError::Internal(e.to_string()))?;
    if !req.output.files.is_empty() {
        let op = storage::operator(state)?;
        for i in 0..req.output.files.len() {
            storage::delete(op, &image_paths::langgraph_artifact_path(user_id, id, i)).await?;
        }
    }
    offload_jobs::delete_job::<Entity>(&state.db, id, user_id).await
}
pub async fn artifact_bytes(
    state: &AppState,
    user_id: i64,
    id: i64,
    index: usize,
) -> Result<(Vec<u8>, Artifact), AppError> {
    let job = get_job(state, user_id, id).await?;
    let artifact = stored_artifacts(&job)?
        .get(index)
        .cloned()
        .ok_or(AppError::NotFound)?;
    let bytes = storage::read(
        storage::operator(state)?,
        &image_paths::langgraph_artifact_path(user_id, id, index),
    )
    .await?;
    Ok((bytes, artifact))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> StartJobParams {
        serde_json::from_value(json!({
            "capability": "llm-runtime.qwen3:8b", "models": {"critic": "gemma3:12b"},
            "main_py": "from tools import dummy\nprint(dummy())", "tools_py": "def dummy(): return 'ok'",
            "pyproject": "[project]\ndependencies = ['langgraph', 'langchain-ollama>=0.3']",
            "system_prompt": "system", "user_prompt": "user", "allowed_tools": [],
            "resources": {"question": 42}, "output": {"data_file":"result.json", "files":["exports/report.md"]}, "runtime_secs":120
        })).unwrap()
    }
    #[test]
    fn builds_runtime_contract_with_input_models_and_sources() {
        let p = runtime_payload(&request()).unwrap();
        assert_eq!(p["model"], "qwen3:8b");
        assert_eq!(p["models"]["critic"], "gemma3:12b");
        assert_eq!(p["entrypoint"], "main.py");
        assert!(
            p["files"]["tools.py"]
                .as_str()
                .unwrap()
                .contains("def dummy")
        );
        assert_eq!(
            p["dependencies"],
            json!(["langgraph", "langchain-ollama>=0.3"])
        );
        assert_eq!(p["allowed_tools"], json!([]));
        assert_eq!(p["output"]["files"], json!(["exports/report.md"]));
        let mut r = request();
        r.allowed_tools = None;
        assert!(runtime_payload(&r).unwrap()["allowed_tools"].is_null());
    }
    #[test]
    fn pyproject_rejects_malformed_or_unsupported_dependency_configuration() {
        for s in [
            "[project",
            "[project]\ndependencies=[7]",
            "[project]\ndynamic=['dependencies']",
            "[project]\ndependencies=[]\n[tool.uv.sources]",
            "[project]\ndependencies=[]\n[dependency-groups]",
            "[project]\ndependencies=[]\noptional-dependencies={test=['pytest']}",
            "[project]\ndependencies=[]\nrequires-python='>=3.12'",
        ] {
            assert!(parse_dependencies(s).is_err(), "{s}");
        }
        assert!(
            parse_dependencies("[project]\ndependencies=[]")
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn rejects_output_escape_duplicate_and_source_overwrites() {
        for path in [
            "../x",
            "/tmp/x",
            "a/../../x",
            "C:\\x",
            "main.py",
            "tools.py",
            "a\0b",
            "a//b",
            "./x",
        ] {
            let mut r = request();
            r.output.files = vec![path.into()];
            assert!(runtime_payload(&r).is_err(), "{path}");
        }
        let mut r = request();
        r.output.data_file = Some(r.output.files[0].clone());
        assert!(runtime_payload(&r).is_err());
    }
    #[test]
    fn rejects_invalid_models_and_limits() {
        let mut r = request();
        r.capability = "llm.qwen3:8b".into();
        assert!(runtime_payload(&r).is_err());
        r = request();
        r.models.insert("bad role".into(), "model".into());
        assert!(runtime_payload(&r).is_err());
        r = request();
        r.models.insert("critic".into(), "model[tools]".into());
        assert!(runtime_payload(&r).is_err());
        r = request();
        r.runtime_secs = 0;
        assert!(runtime_payload(&r).is_err());
        r = request();
        r.runtime_secs = 3601;
        assert!(runtime_payload(&r).is_err());
        r = request();
        r.main_py.clear();
        assert!(runtime_payload(&r).is_err());
    }
}
