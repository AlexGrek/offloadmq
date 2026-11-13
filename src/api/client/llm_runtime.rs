//! Submission contract for explicitly trusted runner-local Python applications.
use std::collections::HashMap;

use serde::Deserialize;

use crate::{error::AppError, schema::TaskSubmissionRequest};

#[derive(Deserialize)]
struct RuntimePayload {
    entrypoint: String,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    files: HashMap<String, String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    user_prompt: String,
    allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    output: RuntimeOutput,
}

#[derive(Default, Deserialize)]
struct RuntimeOutput {
    data_file: Option<String>,
    #[serde(default)]
    files: Vec<String>,
}

fn relative_path(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '\0'])
        && !name.starts_with('/')
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != ".." && part != ".")
}

pub(super) fn validate(req: &TaskSubmissionRequest) -> Result<(), AppError> {
    let Some(model) = req.capability.strip_prefix("llm-runtime.") else {
        return Ok(());
    };
    let invalid = |message: &str| AppError::Validation(format!("llm-runtime: {message}"));
    if model.is_empty() || model.contains(['[', ']']) {
        return Err(invalid(
            "capability requires an Ollama model without attributes",
        ));
    }
    crate::mq::runtime_models::selected_models(&req.capability, &req.payload)
        .map_err(|message| invalid(&message))?;
    let payload: RuntimePayload =
        serde_json::from_value(req.payload.clone()).map_err(|err| invalid(&err.to_string()))?;
    for path in std::iter::once(&payload.entrypoint)
        .chain(payload.files.keys())
        .chain(payload.output.files.iter())
        .chain(payload.output.data_file.iter())
    {
        if !relative_path(path) {
            return Err(invalid(
                "app and output paths must be relative, without traversal",
            ));
        }
    }
    if !payload.output.files.is_empty() && req.output_bucket.as_deref().is_none_or(str::is_empty) {
        return Err(invalid("output.files requires output_bucket"));
    }
    // Deserialization validates these fields; their interpretation belongs to the app.
    let _ = (
        payload.dependencies,
        payload.args,
        payload.system_prompt,
        payload.user_prompt,
        payload.allowed_tools,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_submission_contract() {
        let mut req = TaskSubmissionRequest {
            capability: "llm-runtime.qwen3:8b".into(),
            payload: json!({"entrypoint":"main.py", "dependencies":["langgraph"],
                            "allowed_tools":[], "output":{"files":["result.txt"]}}),
            ..Default::default()
        };
        assert!(validate(&req).is_err());
        req.output_bucket = Some("owned-bucket".into());
        assert!(validate(&req).is_ok());
        req.payload["entrypoint"] = json!("../main.py");
        assert!(validate(&req).is_err());
        req.payload["entrypoint"] = json!("main.py");
        req.payload["allowed_tools"] = json!("all");
        assert!(validate(&req).is_err());
        req.capability = "llm.qwen3:8b".into();
        assert!(validate(&req).is_ok());
    }

    #[test]
    fn portable_relative_paths() {
        for path in ["", "/etc/passwd", "../a", "a/../b", "C:\\a", "a\\b", "a\0b"] {
            assert!(!relative_path(path), "{path:?}");
        }
        assert!(relative_path("app/main.py"));
    }
}
