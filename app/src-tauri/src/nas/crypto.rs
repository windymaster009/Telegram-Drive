use aes_gcm_siv::aead::{Aead, KeyInit};
use aes_gcm_siv::{Aes256GcmSiv, Nonce};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use time::OffsetDateTime;

use super::models::AuthClaims;

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| err.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(hash).map_err(|err| err.to_string())?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    STANDARD_NO_PAD.encode(bytes)
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn ensure_master_key(path: &Path) -> Result<Vec<u8>, String> {
    if let Ok(existing) = fs::read(path) {
        return Ok(existing);
    }

    let mut bytes = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    fs::write(path, &bytes).map_err(|err| err.to_string())?;

    #[cfg(target_family = "unix")]
    {
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }

    Ok(bytes)
}

pub fn encrypt_secret(secret: &str, key: &[u8]) -> Result<String, String> {
    let cipher = Aes256GcmSiv::new_from_slice(key).map_err(|err| err.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), secret.as_bytes())
        .map_err(|err| err.to_string())?;

    Ok(format!(
        "{}:{}",
        STANDARD_NO_PAD.encode(nonce_bytes),
        STANDARD_NO_PAD.encode(ciphertext)
    ))
}

pub fn decrypt_secret(encrypted: &str, key: &[u8]) -> Result<String, String> {
    let (nonce_b64, data_b64) = encrypted
        .split_once(':')
        .ok_or("Invalid encrypted secret format")?;
    let nonce = STANDARD_NO_PAD
        .decode(nonce_b64)
        .map_err(|err| err.to_string())?;
    let data = STANDARD_NO_PAD
        .decode(data_b64)
        .map_err(|err| err.to_string())?;

    let cipher = Aes256GcmSiv::new_from_slice(key).map_err(|err| err.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), data.as_ref())
        .map_err(|err| err.to_string())?;
    String::from_utf8(plaintext).map_err(|err| err.to_string())
}

pub fn issue_jwt(
    claims: &AuthClaims,
    signing_key: &[u8],
) -> Result<String, String> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(signing_key),
    )
    .map_err(|err| err.to_string())
}

pub fn decode_jwt(token: &str, signing_key: &[u8]) -> Result<AuthClaims, String> {
    decode::<AuthClaims>(
        token,
        &DecodingKey::from_secret(signing_key),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|err| err.to_string())
}

pub fn now_ts() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}
