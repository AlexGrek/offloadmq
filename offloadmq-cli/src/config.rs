use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const DEFAULT_SERVER: &str = "http://localhost:3069";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    pub server: Option<String>,
    pub key: Option<String>,
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("could not determine home directory")?;
        Ok(home.join(".omqcli.yaml"))
    }

    pub fn load() -> Result<Config> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(Config::default());
        }
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let cfg: Config = serde_yaml::from_str(&raw)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        Ok(cfg)
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        let raw = serde_yaml::to_string(self)?;
        fs::write(&path, raw).with_context(|| format!("failed to write {}", path.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&path, perms);
        }

        Ok(())
    }

    /// Server base URL and management key, or an actionable error if not configured.
    pub fn require(&self) -> Result<(String, String)> {
        let key = self.key.clone().ok_or_else(|| {
            anyhow::anyhow!("not authenticated — run `omqcli auth --key <management-key>` first")
        })?;
        let server = self
            .server
            .clone()
            .unwrap_or_else(|| DEFAULT_SERVER.to_string());
        Ok((server, key))
    }
}

pub fn require_valid_url(url: &str) -> Result<()> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("server URL must start with http:// or https:// (got {url:?})");
    }
    Ok(())
}
