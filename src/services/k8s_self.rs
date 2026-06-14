//! In-cluster Kubernetes API access for OffloadMQ stack pods (server, management frontend).
//! Requires POD_NAMESPACE, mounted service account token, and Helm-set env vars.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

const SA_TOKEN_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const MAX_TAIL_LINES: u32 = 10_000;

/// Which stack pod to inspect (query param `component`, default `server`).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum K8sComponent {
    #[default]
    Server,
    Frontend,
}

#[derive(Clone)]
pub struct K8sClusterAccess {
    pub api_server: String,
    pub namespace: String,
    token: String,
    ca_pem: Vec<u8>,
}

#[derive(Clone)]
pub struct PodRef {
    pub component: K8sComponent,
    pub pod_name: String,
    pub default_container: String,
}

#[derive(Debug, Deserialize)]
struct K8sPodBody {
    metadata: K8sPodMeta,
    status: K8sPodStatus,
}

#[derive(Debug, Deserialize)]
struct K8sPodMeta {
    name: String,
    #[serde(default)]
    namespace: String,
}

#[derive(Debug, Deserialize)]
struct K8sPodList {
    items: Vec<K8sPodListItem>,
}

#[derive(Debug, Deserialize)]
struct K8sPodListItem {
    metadata: K8sPodMeta,
    status: K8sPodStatus,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct K8sPodStatus {
    phase: Option<String>,
    #[serde(rename = "podIP")]
    pod_ip: Option<String>,
    #[serde(rename = "hostIP")]
    host_ip: Option<String>,
    #[serde(rename = "startTime")]
    start_time: Option<String>,
    conditions: Vec<K8sPodCondition>,
    #[serde(rename = "containerStatuses")]
    container_statuses: Vec<K8sContainerStatus>,
}

#[derive(Debug, Deserialize)]
struct K8sPodCondition {
    #[serde(rename = "type")]
    condition_type: String,
    status: String,
    reason: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct K8sContainerStatus {
    name: String,
    ready: bool,
    #[serde(rename = "restartCount")]
    restart_count: i32,
    state: Option<serde_json::Value>,
    #[serde(rename = "lastState", default)]
    last_state: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerStateSummary {
    /// `running`, `waiting`, or `terminated`
    pub phase: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Serialize)]
pub struct SelfPodCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct SelfContainerStatus {
    pub name: String,
    pub ready: bool,
    pub restart_count: i32,
    pub current_state: Option<ContainerStateSummary>,
    pub last_state: Option<ContainerStateSummary>,
    pub has_previous_instance: bool,
}

#[derive(Serialize)]
pub struct SelfPodStatusResponse {
    pub component: String,
    pub name: String,
    pub namespace: String,
    pub phase: Option<String>,
    pub pod_ip: Option<String>,
    pub host_ip: Option<String>,
    pub start_time: Option<String>,
    pub ready: bool,
    pub conditions: Vec<SelfPodCondition>,
    pub containers: Vec<SelfContainerStatus>,
}

#[derive(Serialize)]
pub struct SelfPodLogsResponse {
    pub component: String,
    pub pod: String,
    pub namespace: String,
    pub container: String,
    pub tail_lines: u32,
    pub previous: bool,
    pub content: String,
    /// Populated when `previous` is true — exit status of the terminated instance.
    pub previous_exit: Option<ContainerStateSummary>,
}

pub struct LogQuery {
    pub tail_lines: u32,
    pub container: Option<String>,
    pub previous: bool,
    pub timestamps: bool,
}

impl K8sClusterAccess {
    pub fn from_env() -> Result<Self, AppError> {
        let namespace = env_required("POD_NAMESPACE")?;
        let host = env_required("KUBERNETES_SERVICE_HOST")?;
        let port = std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".into());
        let api_server = format!("https://{host}:{port}");

        let token = std::fs::read_to_string(SA_TOKEN_PATH).map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "service account token not available ({SA_TOKEN_PATH}): {e}"
            ))
        })?;
        let ca_pem = std::fs::read(SA_CA_PATH).map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "cluster CA not available ({SA_CA_PATH}): {e}"
            ))
        })?;

        Ok(Self {
            api_server,
            namespace,
            token: token.trim().to_string(),
            ca_pem,
        })
    }

    pub async fn resolve_pod(&self, component: K8sComponent) -> Result<PodRef, AppError> {
        let (pod_name, default_container) = match component {
            K8sComponent::Server => (
                env_required("POD_NAME")?,
                env_optional("K8S_SERVER_CONTAINER_NAME").unwrap_or_else(|| "offloadmq".into()),
            ),
            K8sComponent::Frontend => {
                let container = env_optional("K8S_FRONTEND_CONTAINER_NAME")
                    .unwrap_or_else(|| "frontend".into());
                let pod_name = if let Some(name) = env_optional("FRONTEND_POD_NAME") {
                    name
                } else {
                    let selector = env_optional("FRONTEND_LABEL_SELECTOR")
                        .unwrap_or_else(|| "app=offloadmq-frontend".into());
                    self.resolve_pod_name_by_label(&selector).await?
                };
                (pod_name, container)
            }
        };

        Ok(PodRef {
            component,
            pod_name,
            default_container,
        })
    }

    async fn resolve_pod_name_by_label(&self, label_selector: &str) -> Result<String, AppError> {
        let client = self.http_client()?;
        let url = format!(
            "{}/api/v1/namespaces/{}/pods?labelSelector={}",
            self.api_server,
            self.namespace,
            urlencoding::encode(label_selector)
        );
        let resp = self
            .auth(client.get(&url))
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes list pods failed: {e}")))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes list pods body: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Internal(anyhow::anyhow!(
                "kubernetes API LIST pods labelSelector={label_selector} returned {status}: {body}"
            )));
        }

        let parsed: K8sPodList = serde_json::from_str(&body).map_err(|e| {
            AppError::Internal(anyhow::anyhow!("kubernetes pod list JSON parse error: {e}"))
        })?;

        if parsed.items.is_empty() {
            return Err(AppError::Internal(anyhow::anyhow!(
                "no pods found for label selector {label_selector:?} in namespace {}",
                self.namespace
            )));
        }

        let pick = parsed
            .items
            .iter()
            .find(|p| p.status.phase.as_deref() == Some("Running"))
            .or(parsed.items.first())
            .expect("items non-empty");

        Ok(pick.metadata.name.clone())
    }

    fn pod_url(&self, pod_name: &str) -> String {
        format!(
            "{}/api/v1/namespaces/{}/pods/{pod_name}",
            self.api_server, self.namespace
        )
    }

    fn logs_url(&self, pod_name: &str, container: &str, query: &LogQuery) -> String {
        let tail = query.tail_lines.min(MAX_TAIL_LINES);
        let mut q = vec![
            ("container".to_string(), container.to_string()),
            ("tailLines".to_string(), tail.to_string()),
        ];
        if query.timestamps {
            q.push(("timestamps".to_string(), "true".to_string()));
        }
        if query.previous {
            q.push(("previous".to_string(), "true".to_string()));
        }
        let qs = q
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        format!(
            "{}/api/v1/namespaces/{}/pods/{pod_name}/log?{qs}",
            self.api_server, self.namespace
        )
    }

    fn http_client(&self) -> Result<Client, AppError> {
        let cert = reqwest::Certificate::from_pem(&self.ca_pem)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("invalid cluster CA: {e}")))?;
        Client::builder()
            .add_root_certificate(cert)
            .build()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes http client: {e}")))
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.bearer_auth(&self.token)
    }
}

pub async fn get_pod_status(
    cluster: &K8sClusterAccess,
    pod: &PodRef,
) -> Result<SelfPodStatusResponse, AppError> {
    let client = cluster.http_client()?;
    let resp = cluster
        .auth(client.get(cluster.pod_url(&pod.pod_name)))
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes API request failed: {e}")))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes API response body: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "kubernetes API GET pod {} returned {status}: {body}",
            pod.pod_name
        )));
    }

    let parsed: K8sPodBody = serde_json::from_str(&body).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("kubernetes pod JSON parse error: {e}"))
    })?;

    let ready = parsed
        .status
        .conditions
        .iter()
        .any(|c| c.condition_type == "Ready" && c.status == "True");

    Ok(SelfPodStatusResponse {
        component: component_label(pod.component),
        name: parsed.metadata.name,
        namespace: parsed.metadata.namespace,
        phase: parsed.status.phase,
        pod_ip: parsed.status.pod_ip,
        host_ip: parsed.status.host_ip,
        start_time: parsed.status.start_time,
        ready,
        conditions: parsed
            .status
            .conditions
            .into_iter()
            .map(|c| SelfPodCondition {
                condition_type: c.condition_type,
                status: c.status,
                reason: c.reason,
                message: c.message,
            })
            .collect(),
        containers: parsed
            .status
            .container_statuses
            .into_iter()
            .map(map_container_status)
            .collect(),
    })
}

fn map_container_status(c: K8sContainerStatus) -> SelfContainerStatus {
    let current_state = c.state.as_ref().and_then(parse_container_state);
    let last_state = c.last_state.as_ref().and_then(parse_container_state);
    let has_previous_instance =
        c.restart_count > 0 || last_state.as_ref().is_some_and(|s| s.phase == "terminated");
    SelfContainerStatus {
        name: c.name,
        ready: c.ready,
        restart_count: c.restart_count,
        current_state,
        last_state,
        has_previous_instance,
    }
}

fn parse_container_state(value: &serde_json::Value) -> Option<ContainerStateSummary> {
    if let Some(running) = value.get("running") {
        return Some(ContainerStateSummary {
            phase: "running".into(),
            reason: None,
            message: None,
            exit_code: None,
            started_at: running
                .get("startedAt")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            finished_at: None,
        });
    }
    if let Some(waiting) = value.get("waiting") {
        return Some(ContainerStateSummary {
            phase: "waiting".into(),
            reason: waiting
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            message: waiting
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            exit_code: None,
            started_at: None,
            finished_at: None,
        });
    }
    if let Some(terminated) = value.get("terminated") {
        return Some(ContainerStateSummary {
            phase: "terminated".into(),
            reason: terminated
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            message: terminated
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            exit_code: terminated
                .get("exitCode")
                .and_then(|v| v.as_i64())
                .map(|n| n as i32),
            started_at: terminated
                .get("startedAt")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            finished_at: terminated
                .get("finishedAt")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    None
}

pub async fn get_pod_logs(
    cluster: &K8sClusterAccess,
    pod: &PodRef,
    query: LogQuery,
    previous_exit: Option<ContainerStateSummary>,
) -> Result<SelfPodLogsResponse, AppError> {
    let tail_lines = query.tail_lines.clamp(1, MAX_TAIL_LINES);
    let container = query
        .container
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&pod.default_container)
        .to_string();

    let log_query = LogQuery {
        tail_lines,
        container: Some(container.clone()),
        previous: query.previous,
        timestamps: query.timestamps,
    };

    let client = cluster.http_client()?;
    let resp = cluster
        .auth(client.get(cluster.logs_url(
            &pod.pod_name,
            &container,
            &log_query,
        )))
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes log request failed: {e}")))?;

    let status = resp.status();
    let content = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("kubernetes log response body: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "kubernetes API GET log {} returned {status}: {content}",
            pod.pod_name
        )));
    }

    Ok(SelfPodLogsResponse {
        component: component_label(pod.component),
        pod: pod.pod_name.clone(),
        namespace: cluster.namespace.clone(),
        container,
        tail_lines,
        previous: query.previous,
        content,
        previous_exit: if query.previous {
            previous_exit
        } else {
            None
        },
    })
}

fn component_label(component: K8sComponent) -> String {
    match component {
        K8sComponent::Server => "server",
        K8sComponent::Frontend => "frontend",
    }
    .to_string()
}

fn env_required(name: &str) -> Result<String, AppError> {
    let value = std::env::var(name).map_err(|_| {
        AppError::Internal(anyhow::anyhow!(
            "{name} is not set; stack pod introspection only works inside Kubernetes"
        ))
    })?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(AppError::Internal(anyhow::anyhow!("{name} is empty")));
    }
    Ok(value)
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_labels_are_stable() {
        assert_eq!(component_label(K8sComponent::Server), "server");
        assert_eq!(component_label(K8sComponent::Frontend), "frontend");
    }

    #[test]
    fn k8s_component_deserializes_lowercase() {
        let server: K8sComponent = serde_json::from_value(serde_json::json!("server")).unwrap();
        let frontend: K8sComponent = serde_json::from_value(serde_json::json!("frontend")).unwrap();
        assert_eq!(server, K8sComponent::Server);
        assert_eq!(frontend, K8sComponent::Frontend);
    }

    #[test]
    fn parse_container_state_terminated_includes_exit_code() {
        let value = serde_json::json!({
            "terminated": {
                "exitCode": 137,
                "reason": "OOMKilled",
                "startedAt": "2026-03-01T10:00:00Z",
                "finishedAt": "2026-03-01T10:05:00Z"
            }
        });
        let parsed = parse_container_state(&value).expect("terminated state");
        assert_eq!(parsed.phase, "terminated");
        assert_eq!(parsed.exit_code, Some(137));
        assert_eq!(parsed.reason.as_deref(), Some("OOMKilled"));
        assert_eq!(parsed.finished_at.as_deref(), Some("2026-03-01T10:05:00Z"));
    }

    #[test]
    fn map_container_status_marks_previous_instance_after_restart() {
        let mapped = map_container_status(K8sContainerStatus {
            name: "offloadmq".into(),
            ready: true,
            restart_count: 1,
            state: Some(serde_json::json!({ "running": { "startedAt": "2026-03-01T10:05:01Z" } })),
            last_state: Some(serde_json::json!({
                "terminated": { "exitCode": 1, "reason": "Error", "finishedAt": "2026-03-01T10:05:00Z" }
            })),
        });
        assert!(mapped.has_previous_instance);
        assert_eq!(mapped.last_state.as_ref().and_then(|s| s.exit_code), Some(1));
    }
}
