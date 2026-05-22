//! OpenDAL operator built from environment variables.
//!
//! `STORAGE_BACKEND`:
//! - unset (default) | `fs` | `local` — filesystem under `STORAGE_FS_ROOT`
//! - `s3` — Garage / S3-compatible
//! - `none` | `disabled` — turn off storage (image uploads will fail)

use anyhow::{bail, Result};
use opendal::{services, Operator};

fn resolve_backend() -> String {
    match std::env::var("STORAGE_BACKEND") {
        Ok(v) if v.is_empty() => "fs".to_string(),
        Ok(v) => v,
        Err(_) => "fs".to_string(),
    }
}

pub fn build_operator() -> Result<Option<Operator>> {
    let backend = resolve_backend();
    if backend == "none" || backend == "disabled" {
        tracing::info!("storage: disabled (STORAGE_BACKEND={backend})");
        return Ok(None);
    }

    let op = match backend.as_str() {
        "fs" | "local" => {
            let root =
                std::env::var("STORAGE_FS_ROOT").unwrap_or_else(|_| "./.data/storage".into());
            std::fs::create_dir_all(&root)?;
            tracing::info!("storage: fs backend root={root}");
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
        other => bail!("Unknown STORAGE_BACKEND: {other}. Use 'fs', 'local', 's3', or 'none'"),
    };

    tracing::info!("storage: {} backend ready", backend);
    Ok(Some(op))
}
