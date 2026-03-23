use std::env;

use dotenvy::dotenv;

#[derive(Clone, Debug)]
pub struct StorageConfig {
    /// Backend type: "local" (default), "webdav", or "s3"
    pub backend: String,
    /// Root directory for local filesystem backend (env: STORAGE_LOCAL_ROOT)
    pub local_root: String,
    // WebDAV options
    pub webdav_endpoint: Option<String>,
    pub webdav_username: Option<String>,
    pub webdav_password: Option<String>,
    // S3 options
    pub s3_bucket: Option<String>,
    pub s3_region: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_endpoint: Option<String>,
    /// Max number of buckets per API key (env: STORAGE_MAX_BUCKETS_PER_KEY, default: 256)
    pub max_buckets_per_key: usize,
    /// Max bytes per bucket (env: STORAGE_BUCKET_SIZE_BYTES, default: 1073741824 = 1 GiB)
    pub bucket_size_bytes: u64,
    /// Bucket TTL in minutes (env: STORAGE_BUCKET_TTL_MINUTES, default: 1440 = 24 h)
    pub bucket_ttl_minutes: u64,
}

impl StorageConfig {
    pub fn from_env(database_root_path: &str) -> Self {
        let backend = env::var("STORAGE_BACKEND").unwrap_or_else(|_| "local".to_string());
        let local_root = env::var("STORAGE_LOCAL_ROOT")
            .unwrap_or_else(|_| format!("{}/file_storage", database_root_path));
        let max_buckets_per_key = env::var("STORAGE_MAX_BUCKETS_PER_KEY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(256usize);
        let bucket_size_bytes = env::var("STORAGE_BUCKET_SIZE_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_073_741_824u64); // 1 GiB
        let bucket_ttl_minutes = env::var("STORAGE_BUCKET_TTL_MINUTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1440u64); // 24 h
        Self {
            backend,
            local_root,
            webdav_endpoint: env::var("STORAGE_WEBDAV_ENDPOINT").ok(),
            webdav_username: env::var("STORAGE_WEBDAV_USERNAME").ok(),
            webdav_password: env::var("STORAGE_WEBDAV_PASSWORD").ok(),
            s3_bucket: env::var("STORAGE_S3_BUCKET").ok(),
            s3_region: env::var("STORAGE_S3_REGION").ok(),
            s3_access_key_id: env::var("STORAGE_S3_ACCESS_KEY_ID").ok(),
            s3_secret_access_key: env::var("STORAGE_S3_SECRET_ACCESS_KEY").ok(),
            s3_endpoint: env::var("STORAGE_S3_ENDPOINT").ok(),
            max_buckets_per_key,
            bucket_size_bytes,
            bucket_ttl_minutes,
        }
    }
}

#[derive(Clone, Debug)]
pub struct HeuristicsConfig {
    /// Heuristic records older than this many days are cleaned up (env: HEURISTICS_TTL_DAYS, default: 7)
    pub ttl_days: u32,
    /// Maximum number of heuristic records to keep per (runner, capability) pair
    /// (env: HEURISTICS_MAX_RECORDS_PER_RUNNER_CAP, default: 500)
    pub max_records_per_runner_cap: u32,
    /// Cleanup job interval in hours, randomized between [min, max]
    /// Min hours (env: HEURISTICS_CLEANUP_INTERVAL_MIN_HOURS, default: 16)
    pub cleanup_interval_min_hours: u32,
    /// Max hours (env: HEURISTICS_CLEANUP_INTERVAL_MAX_HOURS, default: 22)
    pub cleanup_interval_max_hours: u32,
}

impl HeuristicsConfig {
    pub fn from_env() -> Self {
        let ttl_days = env::var("HEURISTICS_TTL_DAYS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(7u32);
        let max_records_per_runner_cap = env::var("HEURISTICS_MAX_RECORDS_PER_RUNNER_CAP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(500u32);
        let cleanup_interval_min_hours = env::var("HEURISTICS_CLEANUP_INTERVAL_MIN_HOURS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(16u32);
        let cleanup_interval_max_hours = env::var("HEURISTICS_CLEANUP_INTERVAL_MAX_HOURS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(22u32);

        Self {
            ttl_days,
            max_records_per_runner_cap,
            cleanup_interval_min_hours,
            cleanup_interval_max_hours,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub jwt_secret: String,
    pub database_root_path: String,
    pub agent_api_keys: Vec<String>,
    pub client_api_keys: Vec<String>,
    pub management_token: String,
    pub host: String,
    pub port: u16,
    /// Maximum request body size in bytes for the client API (env: MAX_REQUEST_BODY_BYTES).
    pub max_request_body_bytes: usize,
    pub storage: StorageConfig,
    pub heuristics: HeuristicsConfig,
}


impl AppConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        // Load .env file if it exists
        dotenv().ok();

        let jwt_secret = env::var("JWT_SECRET")
            .unwrap_or_else(|_| "default_jwt_secret_change_in_production".to_string());

        let management_token = env::var("MGMT_TOKEN")
            .unwrap_or_else(|_| "default_mgmt_token_change_in_production".to_string());

        let database_root_path = env::var("DATABASE_ROOT_PATH")
            .unwrap_or_else(|_| "./data".to_string());

        let agent_api_keys = env::var("AGENT_API_KEYS")
            .unwrap_or_else(|_| String::new())
            .split(':')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        let client_api_keys = env::var("CLIENT_API_KEYS")
            .unwrap_or_else(|_| String::new())
            .split(':')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        let host = env::var("HOST")
            .unwrap_or_else(|_| "0.0.0.0".to_string());

        let port = env::var("PORT")
            .unwrap_or_else(|_| "3069".to_string())
            .parse::<u16>()?;

        let max_request_body_bytes = env::var("MAX_REQUEST_BODY_BYTES")
            .unwrap_or_else(|_| "5000000".to_string())
            .parse::<usize>()?;

        let storage = StorageConfig::from_env(&database_root_path);
        let heuristics = HeuristicsConfig::from_env();

        Ok(Self {
            jwt_secret,
            database_root_path,
            agent_api_keys,
            client_api_keys,
            host,
            port,
            management_token,
            max_request_body_bytes,
            storage,
            heuristics,
        })
    }
}
