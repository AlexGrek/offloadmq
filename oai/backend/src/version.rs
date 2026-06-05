use std::sync::OnceLock;

/// Build/deploy version of the backend.
///
/// Read once from the `OAI_BUILD_VERSION` env var, which is baked into the
/// Docker image at build time (see `oai/Dockerfile` + `Taskfile.yml`). The
/// value is the short git hash — the same identity the frontend bundle is
/// stamped with (`VITE_APP_VERSION`) and the Docker image is tagged with, so
/// the SPA can compare its own baked version against this endpoint and reload
/// when a newer build has been deployed.
///
/// Falls back to `"dev"` when unset (local `cargo run` / `task dev`).
pub fn build_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        std::env::var("OAI_BUILD_VERSION")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "dev".to_string())
    })
}
