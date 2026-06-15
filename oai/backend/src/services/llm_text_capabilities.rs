//! Shared LLM capability listing for text-model features (compare, debate, chat).

use std::collections::HashSet;

use crate::{
    db::llm_capabilities,
    error::AppError,
    offload::LlmCapabilityInfo,
    services::offload_factory,
    state::AppState,
};

pub async fn list_text_llm_capabilities(
    state: &AppState,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let online = client.list_llm_capabilities().await?;
    llm_capabilities::sync_online(&state.db, &online).await?;
    let online_bases: HashSet<String> = online.iter().map(|c| c.base.clone()).collect();
    llm_capabilities::list_for_display(&state.db, &online_bases).await
}
