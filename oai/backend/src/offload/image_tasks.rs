use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    offload::{post_cancel, CancelTaskResponse},
};

#[derive(Debug, Clone)]
pub struct OffloadImageClient {
    http: Client,
    base_url: String,
    api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffloadTaskId {
    pub cap: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct OffloadPollResponse {
    pub status: String,
    pub stage: Option<String>,
    pub output: Option<serde_json::Value>,
    pub log: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBucketResponse {
    pub bucket_uid: String,
}

#[derive(Debug, Deserialize)]
pub struct UploadFileResponse {
    pub file_uid: String,
}

impl OffloadImageClient {
    pub fn new(http: Client, base_url: String, api_key: String) -> Self {
        Self { http, base_url: base_url.trim_end_matches('/').to_string(), api_key }
    }

    pub async fn create_bucket(
        &self,
        rm_after_task: bool,
    ) -> Result<CreateBucketResponse, AppError> {
        let url = if rm_after_task {
            format!("{}/api/storage/bucket/create?rm_after_task=true", self.base_url)
        } else {
            format!("{}/api/storage/bucket/create", self.base_url)
        };
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", &self.api_key)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!(
                "create bucket failed: {text}"
            )));
        }
        resp.json()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))
    }

    pub async fn upload_bucket_file(
        &self,
        bucket_uid: &str,
        bytes: Vec<u8>,
        filename: &str,
        content_type: &str,
    ) -> Result<UploadFileResponse, AppError> {
        let url = format!("{}/api/storage/bucket/{}/upload", self.base_url, bucket_uid);
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str(content_type)
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        let form = reqwest::multipart::Form::new().part("file", part);

        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", &self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("upload failed: {text}")));
        }
        resp.json()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))
    }

    pub async fn download_bucket_file(
        &self,
        bucket_uid: &str,
        file_uid: &str,
    ) -> Result<(Vec<u8>, String), AppError> {
        let url = format!(
            "{}/api/storage/bucket/{}/file/{}",
            self.base_url, bucket_uid, file_uid
        );
        let resp = self
            .http
            .get(&url)
            .header("X-API-Key", &self.api_key)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("download failed: {text}")));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        Ok((bytes.to_vec(), content_type))
    }

    pub async fn submit_img_task(
        &self,
        capability: &str,
        payload: serde_json::Value,
        input_bucket_uid: Option<&str>,
        output_bucket_uid: &str,
        data_preparation: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> Result<(OffloadTaskId, serde_json::Value), AppError> {
        let mut body = serde_json::json!({
            "apiKey": self.api_key,
            "capability": capability,
            "urgent": false,
            "payload": payload,
            "output_bucket": output_bucket_uid,
        });
        if let Some(input_bucket) = input_bucket_uid {
            body["file_bucket"] = serde_json::json!([input_bucket]);
        }
        if let Some(prep) = data_preparation.filter(|m| !m.is_empty()) {
            body["dataPreparation"] = serde_json::Value::Object(prep.clone());
        }
        let url = format!("{}/api/task/submit", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("submit failed: {text}")));
        }
        let val: serde_json::Value =
            resp.json().await.map_err(|e| AppError::ExternalService(e.to_string()))?;
        let cap = val["id"]["cap"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.cap".into()))?
            .to_string();
        let id = val["id"]["id"]
            .as_str()
            .ok_or_else(|| AppError::ExternalService("missing id.id".into()))?
            .to_string();
        Ok((OffloadTaskId { cap, id }, body))
    }

    pub async fn poll_task(&self, task_id: &OffloadTaskId) -> Result<OffloadPollResponse, AppError> {
        let cap_encoded = urlencoding::encode(&task_id.cap);
        let url = format!("{}/api/task/poll/{}/{}", self.base_url, cap_encoded, task_id.id);
        let body = serde_json::json!({ "apiKey": self.api_key });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::ExternalService(format!("poll failed: {text}")));
        }
        resp.json()
            .await
            .map_err(|e| AppError::ExternalService(e.to_string()))
    }

    pub async fn cancel_task(&self, task_id: &OffloadTaskId) -> Result<CancelTaskResponse, AppError> {
        post_cancel(&self.http, &self.base_url, &self.api_key, &task_id.cap, &task_id.id).await
    }
}
