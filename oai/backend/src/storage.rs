//! OpenDAL operator built from environment variables.
//! STORAGE_BACKEND: "fs", "s3" (Garage S3-compatible), or unset/empty to disable.

use anyhow::{bail, Result};
use opendal::{services, Operator};

pub fn build_operator() -> Result<Option<Operator>> {
    let backend = std::env::var("STORAGE_BACKEND").unwrap_or_default();
    if backend.is_empty() || backend == "none" {
        tracing::info!("storage: disabled (set STORAGE_BACKEND=fs or s3 to enable)");
        return Ok(None);
    }

    let op = match backend.as_str() {
        "fs" => {
            let root =
                std::env::var("STORAGE_FS_ROOT").unwrap_or_else(|_| "./data/storage".into());
            std::fs::create_dir_all(&root)?;
            Operator::new(services::Fs::default().root(&root))?.finish()
        }
        "s3" => {
            // Garage is S3-compatible and uses path-style addressing (the default).
            let bucket = std::env::var("STORAGE_S3_BUCKET").unwrap_or_default();
            let region =
                std::env::var("STORAGE_S3_REGION").unwrap_or_else(|_| "us-east-1".into());
            let endpoint = std::env::var("STORAGE_S3_ENDPOINT").unwrap_or_default();
            let access_key = std::env::var("STORAGE_S3_ACCESS_KEY_ID").unwrap_or_default();
            let secret_key =
                std::env::var("STORAGE_S3_SECRET_ACCESS_KEY").unwrap_or_default();

            Operator::new(
                services::S3::default()
                    .bucket(&bucket)
                    .region(&region)
                    .endpoint(&endpoint)
                    .access_key_id(&access_key)
                    .secret_access_key(&secret_key),
            )?
            .finish()
        }
        other => bail!("Unknown STORAGE_BACKEND: {other}. Use 'fs' or 's3'"),
    };

    tracing::info!("storage: {} backend ready", backend);
    Ok(Some(op))
}
