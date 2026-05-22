use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

#[derive(Clone)]
pub struct Auth {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
    expiry_seconds: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub exp: usize,
}

impl Auth {
    pub fn new(jwt_secret: &[u8], expiry_days: u64) -> Self {
        Auth {
            encoding_key: EncodingKey::from_secret(jwt_secret),
            decoding_key: DecodingKey::from_secret(jwt_secret),
            expiry_seconds: (expiry_days * 86400) as usize,
        }
    }

    pub fn hash_password(&self, password: &str) -> Result<String, AppError> {
        hash(password, DEFAULT_COST).map_err(AppError::Bcrypt)
    }

    pub fn verify_password(&self, password: &str, hash: &str) -> Result<bool, AppError> {
        verify(password, hash).map_err(AppError::Bcrypt)
    }

    pub fn create_token(&self, user_id: i64) -> Result<String, AppError> {
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize
            + self.expiry_seconds;
        let claims = Claims { sub: user_id, exp };
        encode(&Header::default(), &claims, &self.encoding_key).map_err(AppError::Jwt)
    }

    pub fn decode_token(&self, token: &str) -> Result<Claims, AppError> {
        decode::<Claims>(token, &self.decoding_key, &Validation::default())
            .map(|d| d.claims)
            .map_err(AppError::Jwt)
    }
}
