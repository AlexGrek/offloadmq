use serde::{Deserialize, Serialize};

use crate::{db::app_settings, error::AppError, state::AppState};

#[derive(Debug, Serialize)]
pub struct RunnerSummary {
    pub uid: String,
    pub uid_short: String,
    pub display_name: Option<String>,
    pub tier: u8,
    pub capacity: u32,
    pub last_contact: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MgmtAgent {
    uid: String,
    uid_short: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    tier: u8,
    #[serde(default)]
    capacity: u32,
    #[serde(default)]
    last_contact: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MgmtAgentsEnvelope {
    #[serde(default)]
    runners: Vec<MgmtAgent>,
    #[serde(default)]
    agents: Vec<MgmtAgent>,
}

pub async fn list_online_runners(state: &AppState) -> Result<Vec<RunnerSummary>, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let token = settings
        .management_api_token
        .as_deref()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::BadRequest("management_api_token is not configured".into()))?;

    let base_url = settings.offloadmq_url.trim_end_matches('/');
    let url = format!("{base_url}/management/agents/list/online");
    let resp = state
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| AppError::ExternalService(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(AppError::ExternalService(format!(
            "management endpoint returned {}",
            resp.status()
        )));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| AppError::ExternalService(e.to_string()))?;

    let mut agents: Vec<MgmtAgent> = match serde_json::from_str::<Vec<MgmtAgent>>(&body) {
        Ok(items) => items,
        Err(primary_err) => {
            match serde_json::from_str::<MgmtAgentsEnvelope>(&body) {
                Ok(env) if !env.runners.is_empty() => env.runners,
                Ok(env) if !env.agents.is_empty() => env.agents,
                Ok(_) => {
                    return Err(AppError::ExternalService(
                        "management response had no runners".into(),
                    ))
                }
                Err(envelope_err) => {
                    let preview = body.chars().take(220).collect::<String>();
                    return Err(AppError::ExternalService(format!(
                        "failed to parse management runners response (array_err: {primary_err}; envelope_err: {envelope_err}; body_preview: {preview})"
                    )));
                }
            }
        }
    };

    agents.sort_by(|a, b| {
        b.tier
            .cmp(&a.tier)
            .then_with(|| a.display_name.cmp(&b.display_name))
            .then_with(|| a.uid_short.cmp(&b.uid_short))
    });

    Ok(agents
        .into_iter()
        .map(|a| RunnerSummary {
            uid: a.uid,
            uid_short: a.uid_short,
            display_name: a.display_name,
            tier: a.tier,
            capacity: a.capacity,
            last_contact: a.last_contact,
            capabilities: a.capabilities,
        })
        .collect())
}
