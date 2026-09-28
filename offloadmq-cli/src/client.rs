use std::time::Duration;

use anyhow::{Result, bail};
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::models::{Agent, RunnerStat, RunnerStatsResponse, StorageQuotas, TasksOverview};

pub struct Client {
    http: HttpClient,
    server: String,
    key: String,
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
            key: key.to_string(),
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

    pub fn list_tasks(&self) -> Result<TasksOverview> {
        let resp = Self::check_status(self.http.get(self.url("/management/tasks/list")).send()?)?;
        Ok(resp.json()?)
    }

    /// Per-(capability, runner) execution stats. Callers aggregate across
    /// capabilities themselves to get one success rate per agent.
    pub fn runner_stats(&self) -> Result<Vec<RunnerStat>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/heuristics/stats/runners"))
                .send()?,
        )?;
        let parsed: RunnerStatsResponse = resp.json()?;
        Ok(parsed.items)
    }

    pub fn storage_quotas(&self) -> Result<StorageQuotas> {
        let resp =
            Self::check_status(self.http.get(self.url("/management/storage/quotas")).send()?)?;
        Ok(resp.json()?)
    }

    pub fn delete_agent(&self, agent_id: &str) -> Result<()> {
        let path = format!("/management/agents/delete/{agent_id}");
        Self::check_status(self.http.post(self.url(&path)).send()?)?;
        Ok(())
    }

    /// Submit a `slavemode.*` task pinned to `agent_uid` and block until it
    /// reaches a terminal state, using the management token (`X-MGMT-API-KEY`)
    /// so no client API key is required. Returns the raw JSON task result —
    /// its shape depends on the capability (see docs/slavemode-capabilities.md).
    ///
    /// `timeout` doubles as `maxWaitSecs`: the max silence the server tolerates
    /// between pickup/progress events before failing the task, so it must be
    /// long enough to span the gaps between an agent's progress updates (e.g.
    /// a model download), not just the total task duration.
    pub fn run_slavemode(
        &self,
        capability: &str,
        mut payload: Value,
        agent_uid: &str,
        timeout: Duration,
    ) -> Result<Value> {
        if !payload.is_object() {
            bail!("slavemode payload must be a JSON object");
        }
        payload
            .as_object_mut()
            .unwrap()
            .insert("runner".to_string(), Value::String(agent_uid.to_string()));

        let body = serde_json::json!({
            "apiKey": "mgmt",
            "capability": capability,
            "payload": payload,
            "urgent": true,
            "maxWaitSecs": timeout.as_secs(),
        });

        let resp = self
            .http
            .post(self.url("/api/task/submit_blocking"))
            .header("X-MGMT-API-KEY", &self.key)
            .timeout(timeout + Duration::from_secs(15))
            .json(&body)
            .send()?;
        let resp = Self::check_status(resp)?;
        Ok(resp.json()?)
    }
}
