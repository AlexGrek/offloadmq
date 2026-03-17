use anyhow::anyhow;
use opendal::{Operator, services};

use crate::config::StorageConfig;

/// Thin wrapper around an opendal Operator providing bucket-scoped file operations.
/// Files are stored at path `{bucket_id}/{file_id}` inside the configured root.
#[derive(Clone)]
pub struct FileStore {
    op: Operator,
}

impl FileStore {
    pub fn new(config: &StorageConfig) -> anyhow::Result<Self> {
        let op = match config.backend.as_str() {
            "local" | "" => {
                Operator::new(services::Fs::default().root(&config.local_root))?.finish()
            }
            "webdav" => {
                let endpoint = config
                    .webdav_endpoint
                    .as_deref()
                    .ok_or_else(|| anyhow!("STORAGE_WEBDAV_ENDPOINT required for webdav backend"))?;

                let builder = services::Webdav::default().endpoint(endpoint);
                let builder = match &config.webdav_username {
                    Some(u) => builder.username(u),
                    None => builder,
                };
                let builder = match &config.webdav_password {
                    Some(p) => builder.password(p),
                    None => builder,
                };
                Operator::new(builder)?.finish()
            }
            "s3" => {
                let bucket = config
                    .s3_bucket
                    .as_deref()
                    .ok_or_else(|| anyhow!("STORAGE_S3_BUCKET required for s3 backend"))?;
                let region = config
                    .s3_region
                    .as_deref()
                    .ok_or_else(|| anyhow!("STORAGE_S3_REGION required for s3 backend"))?;

                let builder = services::S3::default().bucket(bucket).region(region);
                let builder = match &config.s3_access_key_id {
                    Some(ak) => builder.access_key_id(ak),
                    None => builder,
                };
                let builder = match &config.s3_secret_access_key {
                    Some(sk) => builder.secret_access_key(sk),
                    None => builder,
                };
                let builder = match &config.s3_endpoint {
                    Some(ep) => builder.endpoint(ep),
                    None => builder,
                };
                Operator::new(builder)?.finish()
            }
            other => return Err(anyhow!("Unknown storage backend: {}", other)),
        };
        Ok(Self { op })
    }

    fn path(bucket_id: &str, file_id: &str) -> String {
        format!("{}/{}", bucket_id, file_id)
    }

    pub async fn put(&self, bucket_id: &str, file_id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        self.op.write(&Self::path(bucket_id, file_id), data).await?;
        Ok(())
    }

    pub async fn get(&self, bucket_id: &str, file_id: &str) -> anyhow::Result<Vec<u8>> {
        let data = self.op.read(&Self::path(bucket_id, file_id)).await?;
        Ok(data.to_vec())
    }

    pub async fn delete_file(&self, bucket_id: &str, file_id: &str) -> anyhow::Result<()> {
        self.op.delete(&Self::path(bucket_id, file_id)).await?;
        Ok(())
    }

    /// Recursively deletes all files in the bucket directory.
    pub async fn delete_bucket(&self, bucket_id: &str) -> anyhow::Result<()> {
        // Ignore errors (bucket directory may not exist if no files were ever uploaded).
        self.op
            .remove_all(&format!("{}/", bucket_id))
            .await
            .ok();
        Ok(())
    }
}
