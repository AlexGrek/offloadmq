pub mod agent;
pub mod agent_log_storage;
pub mod apikeys;
pub mod app_storage;
pub mod bucket_storage;
pub mod compact;
pub mod heuristic_storage;
pub mod persistent_task_storage;
pub mod service_message_storage;

/// Default sled page-cache size per database, in MiB. sled's own default is
/// 1 GiB *per DB*, which with seven databases dwarfs the pod memory limit.
const DEFAULT_SLED_CACHE_MB: u64 = 64;

/// Page-cache budget for every sled DB (env: `SLED_CACHE_MB`, default 64).
/// Zero or unparsable values fall back to the default.
pub fn sled_cache_mb() -> u64 {
    std::env::var("SLED_CACHE_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&mb| mb > 0)
        .unwrap_or(DEFAULT_SLED_CACHE_MB)
}

/// Open a sled database with `cache_mb` MiB of page cache.
pub fn open_sled_with_cache(
    path: impl AsRef<std::path::Path>,
    cache_mb: u64,
) -> sled::Result<sled::Db> {
    sled::Config::new()
        .path(path)
        .cache_capacity(cache_mb * 1024 * 1024)
        .open()
}

/// Open a sled database with the configured (`SLED_CACHE_MB`) cache cap.
/// Use this instead of `sled::open` everywhere.
pub fn open_sled(path: impl AsRef<std::path::Path>) -> sled::Result<sled::Db> {
    open_sled_with_cache(path, sled_cache_mb())
}
