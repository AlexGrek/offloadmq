use anyhow::{Result, bail};
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

use crate::models::Agent;

pub struct Client {
    http: HttpClient,
    server: String,
}

impl Client {
    pub fn new(server: &str, key: &str) -> Result<Client> {
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {key}"))?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);

        let http = HttpClient::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;

        Ok(Client {
            http,
            server: server.trim_end_matches('/').to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.server, path)
    }

    /// Bubble up a readable error for non-2xx responses instead of a generic status error.
    fn check_status(resp: reqwest::blocking::Response) -> Result<reqwest::blocking::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().unwrap_or_default();
        let hint = match status.as_u16() {
            401 | 403 => " (check the key stored via `omqcli auth --key ...`)",
            404 => " (not found)",
            _ => "",
        };
        bail!("server returned {status}{hint}: {body}");
    }

    pub fn server_version(&self) -> Result<String> {
        let resp = Self::check_status(self.http.get(self.url("/management/version")).send()?)?;
        let v: serde_json::Value = resp.json()?;
        Ok(v.get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string())
    }

    pub fn list_agents(&self, online_only: bool) -> Result<Vec<Agent>> {
        let path = if online_only {
            "/management/agents/list/online"
        } else {
            "/management/agents/list"
        };
        let resp = Self::check_status(self.http.get(self.url(path)).send()?)?;
        Ok(resp.json()?)
    }

    pub fn list_capabilities(&self, extended: bool) -> Result<Vec<String>> {
        let path = if extended {
            "/management/capabilities/list/online_ext"
        } else {
            "/management/capabilities/list/online"
        };
        let resp = Self::check_status(self.http.get(self.url(path)).send()?)?;
        Ok(resp.json()?)
    }

    pub fn delete_agent(&self, agent_id: &str) -> Result<()> {
        let path = format!("/management/agents/delete/{agent_id}");
        Self::check_status(self.http.post(self.url(&path)).send()?)?;
        Ok(())
    }
}
