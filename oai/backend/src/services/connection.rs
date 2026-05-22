//! Connectivity probes for the admin "check connection" panel. Each probe
//! hits a cheap authenticated endpoint and reports whether the token works.

use reqwest::Client;

pub struct TokenProbe {
    pub ok: bool,
    pub error: Option<String>,
}

/// Probes a client API token against `POST /api/capabilities/online` (Task API auth:
/// `apiKey` in JSON body, same as other `/api/*` routes).
pub async fn probe_client_token(http: &Client, base_url: &str, token: &str) -> TokenProbe {
    let url = format!("{}/api/capabilities/online", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "apiKey": token });
    let result = http.post(&url).json(&body).send().await;
    classify(result, "Invalid client token")
}

/// Probes a management token against `/management/version`.
pub async fn probe_management_token(http: &Client, base_url: &str, token: &str) -> TokenProbe {
    let url = format!("{}/management/version", base_url.trim_end_matches('/'));
    let result = http
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await;
    classify(result, "Invalid management token")
}

fn classify(result: Result<reqwest::Response, reqwest::Error>, unauthorized_msg: &str) -> TokenProbe {
    match result {
        Ok(resp) if resp.status().is_success() => TokenProbe { ok: true, error: None },
        Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
            TokenProbe { ok: false, error: Some(unauthorized_msg.to_string()) }
        }
        Ok(resp) => TokenProbe {
            ok: false,
            error: Some(format!("Unexpected status {}", resp.status())),
        },
        Err(e) => TokenProbe { ok: false, error: Some(e.to_string()) },
    }
}
