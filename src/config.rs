use std::env;

use dotenvy::dotenv;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub jwt_secret: String,
    pub database_root_path: String,
    pub agent_api_keys: Vec<String>,
    pub client_api_keys: Vec<String>,
    pub host: String,
    pub port: u16,
}


impl AppConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        // Load .env file if it exists
        dotenv().ok();

        let jwt_secret = env::var("JWT_SECRET")
            .unwrap_or_else(|_| "default_jwt_secret_change_in_production".to_string());

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

        Ok(Self {
            jwt_secret,
            database_root_path,
            agent_api_keys,
            client_api_keys,
            host,
            port,
        })
    }
}
