use bcrypt::{hash, verify, DEFAULT_COST};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{error::AppError, services::subprocess::blocking};

#[derive(Clone)]
pub struct Auth {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
    expiry_seconds: usize,
    /// Valid bcrypt hash of a throwaway string, used to spend the same time on a
    /// login for an unknown user as on one for a real user (see `verify_dummy`).
    dummy_hash: String,
    /// HMAC key for signed URLs (MCP file links), derived from the JWT secret so no
    /// extra secret has to be configured — but never equal to it.
    link_key: [u8; 32],
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
            // If hashing ever fails this is empty and `verify_dummy` just returns
            // early — the timing side channel returns, nothing else breaks.
            dummy_hash: hash("oai-timing-equalizer", DEFAULT_COST).unwrap_or_default(),
            link_key: {
                let mut h = Sha256::new();
                h.update(b"oai-signed-link-v1\0");
                h.update(jwt_secret);
                h.finalize().into()
            },
        }
    }

    /// Burns one bcrypt verification against a dummy hash. Call when there is no
    /// real hash to check, so "unknown login" isn't measurably faster than "wrong
    /// password" and can't be used to enumerate accounts.
    pub async fn verify_dummy(&self, password: String) {
        let dummy = self.dummy_hash.clone();
        // Result is deliberately ignored: only the time spent matters.
        let _ = blocking(move || Ok(verify(&password, &dummy).unwrap_or(false))).await;
    }

    // bcrypt at DEFAULT_COST is ~250 ms of pure CPU, so it runs on the blocking pool;
    // called inline it would pin an async worker thread per concurrent login.

    pub async fn hash_password(&self, password: String) -> Result<String, AppError> {
        blocking(move || hash(&password, DEFAULT_COST).map_err(AppError::Bcrypt)).await
    }

    pub async fn verify_password(&self, password: String, hash: String) -> Result<bool, AppError> {
        blocking(move || verify(&password, &hash).map_err(AppError::Bcrypt)).await
    }

    pub fn create_token(&self, user_id: i64) -> Result<String, AppError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| AppError::Internal(format!("system clock before UNIX epoch: {e}")))?;
        let exp = now.as_secs() as usize + self.expiry_seconds;
        let claims = Claims { sub: user_id, exp };
        encode(&Header::default(), &claims, &self.encoding_key).map_err(AppError::Jwt)
    }

    /// HMAC-SHA256 of `message` under the signed-link key, hex-encoded.
    pub fn sign_link(&self, message: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.link_key).expect("HMAC accepts any key size");
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Constant-time check of a [`sign_link`](Self::sign_link) signature.
    pub fn verify_link(&self, message: &str, signature_hex: &str) -> bool {
        let Ok(sig) = hex::decode(signature_hex) else {
            return false;
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.link_key).expect("HMAC accepts any key size");
        mac.update(message.as_bytes());
        mac.verify_slice(&sig).is_ok()
    }

    pub fn decode_token(&self, token: &str) -> Result<Claims, AppError> {
        decode::<Claims>(token, &self.decoding_key, &Validation::default())
            .map(|d| d.claims)
            .map_err(AppError::Jwt)
    }
}
