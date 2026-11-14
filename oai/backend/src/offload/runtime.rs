//! Python runtime submission. Uses the same watch/poll transport as other jobs.
use super::{OffloadClient, TaskId};
use crate::error::AppError;

impl OffloadClient {
    pub async fn submit_runtime(
        &self,
        capability: &str,
        payload: serde_json::Value,
        output_bucket: Option<&str>,
        runtime_secs: u32,
    ) -> Result<TaskId, AppError> {
        let resp = self.http.post(format!("{}/api/task/submit", self.base_url))
            .json(&serde_json::json!({
                "apiKey": self.api_key, "capability": capability,
                "urgent": false, "restartable": false, "payload": payload,
                "output_bucket": output_bucket, "file_bucket": [], "fetchFiles": [], "artifacts": [],
                "timeoutSecs": 86400, "maxWaitSecs": 82800, "runtimeSecs": runtime_secs,
            })).send().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AppError::ExternalService(format!(
                "runtime submit failed: {}",
                resp.text().await.unwrap_or_default()
            )));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        Ok(TaskId {
            cap: v["id"]["cap"]
                .as_str()
                .ok_or_else(|| AppError::ExternalService("missing task capability".into()))?
                .into(),
            id: v["id"]["id"]
                .as_str()
                .ok_or_else(|| AppError::ExternalService("missing task id".into()))?
                .into(),
        })
    }
}
