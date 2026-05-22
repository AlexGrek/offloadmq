//! In-cluster Kubernetes API access for OAI stack pods (app, Postgres, Garage).
//! Requires POD_NAMESPACE, mounted service account token, and Helm-set pod name env vars.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

const SA_TOKEN_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const MAX_TAIL_LINES: u32 = 10_000;

/// Which stack pod to inspect (query param `component`, default `app`).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum K8sComponent {
    #[default]
    App,
    Postgres,
    Garage,
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
    namespace: String,
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
    pub state: Option<serde_json::Value>,
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
    pub content: String,
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
            AppError::ExternalService(format!(
                "service account token not available ({SA_TOKEN_PATH}): {e}"
            ))
        })?;
        let ca_pem = std::fs::read(SA_CA_PATH).map_err(|e| {
            AppError::ExternalService(format!(
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

    pub fn resolve_pod(&self, component: K8sComponent) -> Result<PodRef, AppError> {
        let (pod_name, default_container) = match component {
            K8sComponent::App => (
                env_required("POD_NAME")?,
                env_optional("K8S_CONTAINER_NAME").unwrap_or_else(|| "oai".into()),
            ),
            K8sComponent::Postgres => (
                env_required("POSTGRES_POD_NAME")?,
                env_optional("POSTGRES_CONTAINER_NAME").unwrap_or_else(|| "postgres".into()),
            ),
            K8sComponent::Garage => (
                env_required("GARAGE_POD_NAME")?,
                env_optional("GARAGE_CONTAINER_NAME").unwrap_or_else(|| "garage".into()),
            ),
        };

        Ok(PodRef {
            component,
            pod_name,
            default_container,
        })
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
            .map_err(|e| AppError::Internal(format!("invalid cluster CA: {e}")))?;
        Client::builder()
            .add_root_certificate(cert)
            .build()
            .map_err(|e| AppError::Internal(format!("kubernetes http client: {e}")))
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
        .map_err(|e| AppError::ExternalService(format!("kubernetes API request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        AppError::ExternalService(format!("kubernetes API response body: {e}"))
    })?;

    if !status.is_success() {
        return Err(AppError::ExternalService(format!(
            "kubernetes API GET pod {} returned {status}: {body}",
            pod.pod_name
        )));
    }

    let parsed: K8sPodBody = serde_json::from_str(&body).map_err(|e| {
        AppError::ExternalService(format!("kubernetes pod JSON parse error: {e}"))
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
            .map(|c| SelfContainerStatus {
                name: c.name,
                ready: c.ready,
                restart_count: c.restart_count,
                state: c.state,
            })
            .collect(),
    })
}

pub async fn get_pod_logs(
    cluster: &K8sClusterAccess,
    pod: &PodRef,
    query: LogQuery,
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
        .map_err(|e| AppError::ExternalService(format!("kubernetes log request failed: {e}")))?;

    let status = resp.status();
    let content = resp.text().await.map_err(|e| {
        AppError::ExternalService(format!("kubernetes log response body: {e}"))
    })?;

    if !status.is_success() {
        return Err(AppError::ExternalService(format!(
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
        content,
    })
}

fn component_label(component: K8sComponent) -> String {
    match component {
        K8sComponent::App => "app",
        K8sComponent::Postgres => "postgres",
        K8sComponent::Garage => "garage",
    }
    .to_string()
}

fn env_required(name: &str) -> Result<String, AppError> {
    let value = std::env::var(name).map_err(|_| {
        AppError::ExternalService(format!(
            "{name} is not set; stack pod introspection only works inside Kubernetes"
        ))
    })?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(AppError::ExternalService(format!("{name} is empty")));
    }
    Ok(value)
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}
