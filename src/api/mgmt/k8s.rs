use axum::{Json, extract::Query, response::IntoResponse};
use serde::Deserialize;

use crate::{error::AppError, services::k8s_self};

#[derive(Deserialize)]
pub struct K8sComponentQuery {
    #[serde(default)]
    pub component: k8s_self::K8sComponent,
}

#[derive(Deserialize)]
pub struct SelfPodLogsQuery {
    #[serde(default)]
    pub component: k8s_self::K8sComponent,
    #[serde(default = "default_log_tail_lines")]
    pub tail_lines: u32,
    pub container: Option<String>,
    #[serde(default)]
    pub previous: bool,
    #[serde(default)]
    pub timestamps: bool,
}

fn default_log_tail_lines() -> u32 {
    500
}

/// GET /management/k8s/self/pod — pod status for a stack component (in-cluster only).
pub async fn k8s_self_pod(
    Query(q): Query<K8sComponentQuery>,
) -> Result<impl IntoResponse, AppError> {
    let cluster = k8s_self::K8sClusterAccess::from_env()?;
    let pod = cluster.resolve_pod(q.component).await?;
    let status = k8s_self::get_pod_status(&cluster, &pod).await?;
    Ok(Json(status))
}

/// GET /management/k8s/self/logs — container logs for a stack component (in-cluster only).
pub async fn k8s_self_logs(
    Query(query): Query<SelfPodLogsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let cluster = k8s_self::K8sClusterAccess::from_env()?;
    let pod = cluster.resolve_pod(query.component).await?;
    let pod_status = k8s_self::get_pod_status(&cluster, &pod).await?;
    let container_name = query
        .container
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&pod.default_container);
    let previous_exit = if query.previous {
        pod_status
            .containers
            .iter()
            .find(|c| c.name == container_name)
            .and_then(|c| c.last_state.clone())
    } else {
        None
    };
    let logs = k8s_self::get_pod_logs(
        &cluster,
        &pod,
        k8s_self::LogQuery {
            tail_lines: query.tail_lines,
            container: query.container,
            previous: query.previous,
            timestamps: query.timestamps,
        },
        previous_exit,
    )
    .await?;
    Ok(Json(logs))
}
