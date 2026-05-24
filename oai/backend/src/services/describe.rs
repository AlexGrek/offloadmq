use serde::Serialize;

use crate::{error::AppError, services::offload_factory, state::AppState};

#[derive(Debug, Serialize)]
pub struct DescribeCapability {
    pub base: String,
    pub tags: Vec<String>,
    pub raw: String,
}

pub async fn list_vision_capabilities(
    state: &AppState,
) -> Result<Vec<DescribeCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let caps = client.list_capabilities_with_prefix("llm.").await?;
    Ok(caps
        .into_iter()
        .filter(|c| c.tags.iter().any(|t| t.eq_ignore_ascii_case("vision")))
        .map(|c| DescribeCapability { base: c.base, tags: c.tags, raw: c.raw })
        .collect())
}

pub async fn submit_describe_task(
    state: &AppState,
    capability: &str,
    prompt: &str,
    image_bytes: Vec<u8>,
    filename: &str,
    content_type: &str,
) -> Result<(String, String), AppError> {
    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;
    img_client
        .upload_bucket_file(&bucket.bucket_uid, image_bytes, filename, content_type)
        .await?;
    let chat_client = offload_factory::chat_client(state).await?;
    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    let task_id =
        chat_client.submit_vision_task(capability, messages, &bucket.bucket_uid).await?;
    Ok((task_id.cap, task_id.id))
}
