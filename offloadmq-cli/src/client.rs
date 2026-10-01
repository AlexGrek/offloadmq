use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Result, bail};
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::models::{
    Agent, AgentLogRecord, AgentLogsResponse, HeuristicRecordsResponse, HeuristicStats,
    HeuristicStatsResponse, PodLogs, PodStatus, RunnerStat, RunnerStatsResponse,
    StorageBucketsResponse, StorageQuotas, TasksOverview,
};

/// Percent-encode one URL path segment. Capabilities can contain `/`
/// (namespaced models like `hf.co/org/model`) and `:` (tags like `qwen3:8b`),
/// both of which must be encoded or they'd be read as extra path segments —
/// see docs/tasks-api.md's note on capability path segments.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Per-request HTTP timeout in seconds; `--http-timeout` / `OMQCLI_HTTP_TIMEOUT`
/// override it (see `set_http_timeout`).
static HTTP_TIMEOUT_SECS: AtomicU64 = AtomicU64::new(15);

pub fn set_http_timeout(secs: u64) {
    HTTP_TIMEOUT_SECS.store(secs.max(1), Ordering::Relaxed);
}

/// Server-side filter for `GET /management/tasks/list`. The server caps every
/// list (default 200, max 1000) and reports truncation in `meta`.
#[derive(Debug, Default, Clone, Copy)]
pub struct TaskQuery {
    /// `active`, `terminal` or `all`; `None` leaves it to the server (`all`).
    pub status: Option<&'static str>,
    pub limit: Option<usize>,
}

impl TaskQuery {
    /// Everything the server will hand over in one response.
    pub const MAX: usize = 1000;

    pub fn active() -> Self {
        Self {
            status: Some("active"),
            limit: Some(Self::MAX),
        }
    }

    pub fn everything() -> Self {
        Self {
            status: Some("all"),
            limit: Some(Self::MAX),
        }
    }
}

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
            .timeout(Duration::from_secs(
                HTTP_TIMEOUT_SECS.load(Ordering::Relaxed),
            ))
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

    pub fn list_tasks(&self, query: TaskQuery) -> Result<TasksOverview> {
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(status) = query.status {
            params.push(("status", status.to_string()));
        }
        if let Some(limit) = query.limit {
            params.push(("limit", limit.to_string()));
        }
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/tasks/list"))
                .query(&params)
                .send()?,
        )?;
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
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/storage/quotas"))
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn storage_buckets(&self) -> Result<StorageBucketsResponse> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/storage/buckets"))
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn storage_quotas_for_key(&self, api_key: Option<&str>) -> Result<StorageQuotas> {
        let mut request = self.http.get(self.url("/management/storage/quotas"));
        if let Some(api_key) = api_key {
            request = request.query(&[("api_key", api_key)]);
        }
        let resp = Self::check_status(request.send()?)?;
        Ok(resp.json()?)
    }

    pub fn delete_storage_bucket(&self, bucket_uid: &str) -> Result<Value> {
        let path = format!(
            "/management/storage/bucket/{}",
            encode_path_segment(bucket_uid)
        );
        let resp = Self::check_status(self.http.delete(self.url(&path)).send()?)?;
        Ok(resp.json()?)
    }

    pub fn delete_storage_key_buckets(&self, api_key: &str) -> Result<Value> {
        let path = format!(
            "/management/storage/key/{}/buckets",
            encode_path_segment(api_key)
        );
        let resp = Self::check_status(self.http.delete(self.url(&path)).send()?)?;
        Ok(resp.json()?)
    }

    pub fn purge_storage_buckets(&self) -> Result<Value> {
        let resp = Self::check_status(
            self.http
                .delete(self.url("/management/storage/buckets"))
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn agent_logs_latest(&self, limit: i64) -> Result<Vec<AgentLogRecord>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/agent_logs/latest"))
                .query(&[("limit", limit)])
                .send()?,
        )?;
        Ok(resp.json::<AgentLogsResponse>()?.items)
    }

    pub fn agent_logs_by_agent(&self, agent_id: &str, limit: i64) -> Result<Vec<AgentLogRecord>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/agent_logs/by_agent"))
                .query(&[("agent_id", agent_id), ("limit", &limit.to_string())])
                .send()?,
        )?;
        Ok(resp.json::<AgentLogsResponse>()?.items)
    }

    pub fn agent_logs_by_severity(
        &self,
        severity: &str,
        limit: i64,
    ) -> Result<Vec<AgentLogRecord>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/agent_logs/by_severity"))
                .query(&[("severity", severity), ("limit", &limit.to_string())])
                .send()?,
        )?;
        Ok(resp.json::<AgentLogsResponse>()?.items)
    }

    pub fn pod_status(&self, component: &str) -> Result<PodStatus> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/k8s/self/pod"))
                .query(&[("component", component)])
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn pod_logs(
        &self,
        component: &str,
        tail_lines: u32,
        container: Option<&str>,
        previous: bool,
        timestamps: bool,
    ) -> Result<PodLogs> {
        let mut params = vec![
            ("component", component.to_string()),
            ("tail_lines", tail_lines.to_string()),
            ("previous", previous.to_string()),
            ("timestamps", timestamps.to_string()),
        ];
        if let Some(container) = container.filter(|s| !s.is_empty()) {
            params.push(("container", container.to_string()));
        }
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/k8s/self/logs"))
                .query(&params)
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn heuristic_records(
        &self,
        capability: Option<&str>,
        runner_id: Option<&str>,
        machine_id: Option<&str>,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<HeuristicRecordsResponse> {
        let mut params = vec![("limit", limit.to_string())];
        for (name, value) in [
            ("capability", capability),
            ("runner_id", runner_id),
            ("machine_id", machine_id),
            ("cursor", cursor),
        ] {
            if let Some(value) = value.filter(|s| !s.is_empty()) {
                params.push((name, value.to_string()));
            }
        }
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/heuristics/records"))
                .query(&params)
                .send()?,
        )?;
        Ok(resp.json()?)
    }

    pub fn heuristic_runner_stats(&self) -> Result<Vec<HeuristicStats>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/heuristics/stats/runners"))
                .send()?,
        )?;
        Ok(resp.json::<HeuristicStatsResponse>()?.items)
    }

    pub fn heuristic_machine_stats(&self) -> Result<Vec<HeuristicStats>> {
        let resp = Self::check_status(
            self.http
                .get(self.url("/management/heuristics/stats/machines"))
                .send()?,
        )?;
        Ok(resp.json::<HeuristicStatsResponse>()?.items)
    }

    pub fn delete_agent(&self, agent_id: &str) -> Result<()> {
        let path = format!("/management/agents/delete/{agent_id}");
        Self::check_status(self.http.post(self.url(&path)).send()?)?;
        Ok(())
    }

    /// Cancel one task regardless of who owns it (management bypasses the
    /// client-API-key ownership check the client-facing cancel endpoint has).
    /// Returns the raw `{id, status, message}` response.
    pub fn cancel_task(&self, cap: &str, id: &str) -> Result<Value> {
        let path = format!(
            "/management/tasks/cancel/{}/{}",
            encode_path_segment(cap),
            encode_path_segment(id)
        );
        let resp = Self::check_status(self.http.post(self.url(&path)).send()?)?;
        Ok(resp.json()?)
    }

    /// Clear every task — urgent and regular, assigned and unassigned.
    /// Destructive; callers should confirm with the operator first.
    pub fn reset_tasks(&self) -> Result<()> {
        Self::check_status(self.http.post(self.url("/management/tasks/reset")).send()?)?;
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
