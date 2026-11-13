//! Models selected by runtime task input, shared by validation and scheduling.
use serde_json::Value;

use crate::utils::base_capability;

fn model_name(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .filter(|name| {
            !name.is_empty()
                && !name
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '[' | ']'))
        })
        .ok_or_else(|| {
            "model names must be non-empty strings without whitespace or capability attributes"
                .into()
        })
}

pub fn selected_models(capability: &str, payload: &Value) -> Result<Vec<String>, String> {
    let Some(routing_model) = capability.strip_prefix("llm-runtime.") else {
        return Ok(Vec::new());
    };
    let fallback = Value::String(routing_model.into());
    let primary = model_name(payload.get("model").unwrap_or(&fallback))?;
    if primary != routing_model {
        return Err("payload.model must match the model in capability".into());
    }
    let mut selected = vec![primary.to_string()];
    if let Some(models) = payload.get("models") {
        let roles = models
            .as_object()
            .ok_or("models must map role names to Ollama model names")?;
        for (role, model) in roles {
            if role.is_empty() || role.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err("model role names must be non-empty and contain no whitespace".into());
            }
            selected.push(model_name(model)?.to_string());
        }
    }
    selected.sort();
    selected.dedup();
    Ok(selected)
}

pub fn matches(capability: &str, payload: &Value, caps: &[String]) -> bool {
    let Ok(models) = selected_models(capability, payload) else {
        return false;
    };
    models.iter().all(|model| {
        caps.iter()
            .any(|cap| base_capability(cap) == format!("llm-runtime.{model}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_models_are_validated_and_all_required_on_one_runner() {
        let cap = "llm-runtime.qwen3:8b";
        let payload =
            json!({"model":"qwen3:8b", "models":{"planner":"qwen3:8b", "critic":"gemma3:12b"}});
        assert_eq!(
            selected_models(cap, &payload).unwrap(),
            ["gemma3:12b", "qwen3:8b"]
        );
        assert!(!matches(cap, &payload, &[cap.into()]));
        assert!(matches(
            cap,
            &payload,
            &[cap.into(), "llm-runtime.gemma3:12b".into()]
        ));
        assert!(matches("llm.test", &json!({"models":false}), &[]));
        for invalid in [
            json!({"model":"other"}),
            json!({"model":null}),
            json!({"models":[]}),
            json!({"models":{"critic":null}}),
            json!({"models":{"critic":""}}),
            json!({"models":{"":"gemma3:12b"}}),
        ] {
            assert!(selected_models(cap, &invalid).is_err(), "{invalid}");
        }
        assert_eq!(selected_models(cap, &json!({})).unwrap(), ["qwen3:8b"]);
    }
    #[tokio::test]
    async fn urgent_tasks_require_every_selected_model() {
        let queue = crate::mq::urgent::UrgentTaskStore::new();
        let task = crate::models::UnassignedTask {
            id: crate::schema::TaskId::new_with_cap("llm-runtime.qwen3:8b".into()),
            data: crate::schema::TaskSubmissionRequest {
                payload: json!({"model":"qwen3:8b", "models":{"critic":"gemma3:12b"}}),
                ..Default::default()
            },
            created_at: chrono::Utc::now(),
        };
        queue.add_task(task.clone(), 60, None).await.unwrap();
        assert!(
            queue
                .find_with_capabilities(&[task.id.cap.clone()], "runner")
                .await
                .is_none()
        );
        assert!(
            queue
                .find_with_capabilities(&[task.id.cap, "llm-runtime.gemma3:12b".into()], "runner")
                .await
                .is_some()
        );
        queue.hard_clear().await;
    }
}
