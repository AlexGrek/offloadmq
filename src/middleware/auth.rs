// src/auth/mod.rs
use bcrypt::{DEFAULT_COST, hash, verify};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

// Token expiration time (e.g., 7 days)
const ONE_WEEK: usize = 60 * 60 * 24 * 7;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

// Auth struct holds the JWT keys
#[derive(Clone)]
pub struct Auth {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Auth")
            .field("encoding_key", &"<EncodingKey>")
            .field("decoding_key", &"<DecodingKey>")
            .finish()
    }
}

impl Auth {
    /// Creates a new Auth instance with the given JWT secret.
    pub fn new(jwt_secret: &[u8]) -> Self {
        let encoding_key = EncodingKey::from_secret(jwt_secret);
        let decoding_key = DecodingKey::from_secret(jwt_secret);
        Auth {
            encoding_key,
            decoding_key,
        }
    }

    /// Hashes a plain text password using bcrypt.
    pub fn hash_password(&self, password: &str) -> Result<String, AppError> {
        // bcrypt::hash is a synchronous operation
        hash(password, DEFAULT_COST).map_err(|e| AppError::BcryptError(e))
    }

    /// Verifies a plain text password against a bcrypt hash.
    pub fn verify_password(&self, password: &str, hash: &str) -> Result<bool, AppError> {
        // bcrypt::verify is a synchronous operation
        verify(password, hash).map_err(|e| AppError::BcryptError(e))
    }

    /// Creates a new JWT token for the given user email.
    pub fn create_token(&self, user_email: &str) -> Result<(String, usize), AppError> {
        // Calculate expiration time
        let expiration_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap() // Safe to unwrap unless system time is before epoch
            .as_secs() as usize
            + ONE_WEEK;

        let claims = Claims {
            sub: user_email.to_owned(), // Subject is the user's email
            exp: expiration_time,       // Expiration time
        };

        // Encode the claims into a JWT
        encode(&Header::default(), &claims, &self.encoding_key)
            .map(|str| (str, expiration_time))
            .map_err(|e| AppError::Jwt(e))
    }

    /// Decodes and validates a JWT token, returning the claims if valid.
    pub fn decode_token(&self, token: &str) -> Result<Claims, AppError> {
        // Decode the token and validate it (signature, expiration)
        decode::<Claims>(token, &self.decoding_key, &Validation::default())
            .map(|data| data.claims) // Extract the claims from the token data
            .map_err(|e| AppError::Jwt(e)) // Convert jsonwebtoken error to AppError
    }
}
