//! Single place that builds OffloadMQ clients from the runtime admin settings.
//! Previously each call site (image routes, chat ws) re-implemented this.

use crate::{
    db::app_settings::{self, AppSettings},
    error::AppError,
    offload::{image_tasks::OffloadImageClient, OffloadClient},
    state::AppState,
};

/// Client for LLM chat / capability listing. Tolerates an empty API key — the
/// upstream server will reject the request, matching prior behavior.
pub async fn chat_client(state: &AppState) -> Result<OffloadClient, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let api_key = settings.client_api_token.unwrap_or_default();
    Ok(OffloadClient::new(state.http.clone(), settings.offloadmq_url, api_key))
}

/// Client for the image pipeline. Requires a configured client API token.
pub async fn image_client(state: &AppState) -> Result<OffloadImageClient, AppError> {
    let settings = app_settings::get(&state.db).await?;
    image_client_from_settings(state, settings)
}

pub fn image_client_from_settings(
    state: &AppState,
    settings: AppSettings,
) -> Result<OffloadImageClient, AppError> {
    let api_key = settings.client_api_token.unwrap_or_default();
    if api_key.is_empty() {
        return Err(AppError::BadRequest(
            "missing OffloadMQ client API token in admin settings".into(),
        ));
    }
    Ok(OffloadImageClient::new(state.http.clone(), settings.offloadmq_url, api_key))
}
