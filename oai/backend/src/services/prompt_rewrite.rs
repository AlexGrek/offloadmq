//! Rewrite the current generation prompt using user-selected modification prompts.
use serde::Deserialize;

use crate::{
    db::prompts,
    error::{AppError, ResultExt},
    offload::{ChatMessage, base_capability},
    services::offload_factory,
    state::AppState,
};

#[derive(Deserialize)]
pub struct RewritePromptParams {
    pub capability: String,
    pub prompt: String,
    pub system_prompt: String,
    pub user_prompt: String,
}

fn modification_messages(params: &RewritePromptParams) -> Result<Vec<ChatMessage>, AppError> {
    if !base_capability(params.capability.trim()).starts_with("llm.") {
        return Err(AppError::BadRequest("An LLM capability is required".into()));
    }
    for (name, value) in [
        ("prompt", &params.prompt),
        ("system_prompt", &params.system_prompt),
        ("user_prompt", &params.user_prompt),
    ] {
        if value.trim().is_empty() || value.chars().count() > 32_000 {
            return Err(AppError::BadRequest(format!(
                "{name} must contain 1–32000 characters"
            )));
        }
    }
    // Replace only the modification template; placeholders in the original
    // generation prompt must survive until image submission.
    let content = if params.user_prompt.contains("{}") {
        params.user_prompt.replace("{}", &params.prompt)
    } else {
        format!(
            "{}\n\nCurrent prompt:\n{}",
            params.user_prompt.trim(),
            params.prompt
        )
    };
    Ok(vec![
        ChatMessage {
            role: "system".into(),
            content: params.system_prompt.clone(),
        },
        ChatMessage {
            role: "user".into(),
            content,
        },
    ])
}

pub async fn rewrite_prompt(
    state: &AppState,
    user_id: i64,
    params: RewritePromptParams,
) -> Result<String, AppError> {
    let messages = modification_messages(&params)?;
    for (bucket, content) in [
        ("imggen-prompt-modification-system", &params.system_prompt),
        ("imggen-prompt-modification-user", &params.user_prompt),
    ] {
        prompts::record_use(&state.db, || state.next_id(), user_id, bucket, content)
            .await
            .log_warn("record prompt modification use");
    }
    offload_factory::chat_client(state)
        .await?
        .submit_chat_blocking(params.capability.trim(), messages)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> RewritePromptParams {
        RewritePromptParams {
            capability: "llm.test[tools]".into(),
            prompt: "A {color} bird named {?}".into(),
            system_prompt: "Return only a rewritten prompt".into(),
            user_prompt: "Make this more vivid: {}".into(),
        }
    }

    #[test]
    fn uses_both_modification_prompts_and_preserves_input_placeholders() {
        let params = params();
        let messages = modification_messages(&params).unwrap();
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, params.system_prompt);
        assert_eq!(messages[1].role, "user");
        assert_eq!(
            messages[1].content,
            "Make this more vivid: A {color} bird named {?}"
        );
    }

    #[test]
    fn always_includes_input_even_without_template_placeholder() {
        let mut params = params();
        params.user_prompt = "Translate to English".into();
        assert_eq!(
            modification_messages(&params).unwrap()[1].content,
            "Translate to English\n\nCurrent prompt:\nA {color} bird named {?}"
        );
    }

    #[test]
    fn rejects_blank_fields_and_non_llm_models() {
        let mut params = params();
        params.prompt = "  ".into();
        assert!(modification_messages(&params).is_err());
        params.prompt = "bird".into();
        params.capability = "imggen.test".into();
        assert!(modification_messages(&params).is_err());
    }
}
