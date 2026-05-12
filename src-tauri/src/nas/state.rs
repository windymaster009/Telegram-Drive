use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Mutex;

use crate::commands::TelegramState;

use super::crypto::{decode_jwt, ensure_master_key, issue_jwt, session_encryption_key_from_env};
use super::db::Database;
use super::models::{AuthClaims, LoginResponse};

#[derive(Clone)]
pub struct PreviewDownloadJob {
    pub path: PathBuf,
    pub tail_path: Option<PathBuf>,
    pub file_name: String,
    pub mime_type: String,
    pub total_size: u64,
    pub downloaded: Arc<AtomicU64>,
    pub tail_downloaded: Arc<AtomicU64>,
    pub complete: Arc<AtomicBool>,
    pub cancelled: Arc<AtomicBool>,
    pub error: Arc<Mutex<Option<String>>>,
}

#[derive(Clone)]
pub struct DesktopGoogleLoginResult {
    pub response: Option<LoginResponse>,
    pub error: Option<String>,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct NasState {
    pub db: Database,
    pub app_data_dir: PathBuf,
    pub master_key: Arc<Vec<u8>>,
    pub jwt_key: Arc<Vec<u8>>,
    pub session_cookie_name: String,
    pub api_base_url: String,
    pub rate_limits: Arc<Mutex<HashMap<String, Vec<i64>>>>,
    pub desktop_google_logins: Arc<Mutex<HashMap<String, DesktopGoogleLoginResult>>>,
    pub preview_downloads: Arc<Mutex<HashMap<String, PreviewDownloadJob>>>,
    pub upload_gate: Arc<Mutex<()>>,
    pub last_telegram_upload_at: Arc<Mutex<Option<Instant>>>,
    pub telegram: Arc<TelegramState>,
}

impl NasState {
    pub async fn new(
        app_data_dir: PathBuf,
        api_base_url: String,
        telegram: Arc<TelegramState>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;

        let db = Database::new().await?;
        let master_key = ensure_master_key(&app_data_dir.join("master.key"))?;
        let jwt_key = match std::env::var("JWT_SECRET") {
            Ok(secret) if !secret.trim().is_empty() => secret.into_bytes(),
            _ => ensure_master_key(&app_data_dir.join("jwt.key"))?,
        };
        let telegram_session_key = session_encryption_key_from_env()?;
        {
            let mut key_guard = telegram.session_encryption_key.lock().await;
            *key_guard = Some(Arc::new(telegram_session_key));
        }
        {
            let mut path_guard = telegram.session_path.lock().await;
            *path_guard = Some(app_data_dir.join("telegram.session.enc"));
        }

        Ok(Self {
            db,
            app_data_dir,
            master_key: Arc::new(master_key),
            jwt_key: Arc::new(jwt_key),
            session_cookie_name: "td_session".to_string(),
            api_base_url,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            desktop_google_logins: Arc::new(Mutex::new(HashMap::new())),
            preview_downloads: Arc::new(Mutex::new(HashMap::new())),
            upload_gate: Arc::new(Mutex::new(())),
            last_telegram_upload_at: Arc::new(Mutex::new(None)),
            telegram,
        })
    }

    pub fn issue_session_jwt(&self, claims: &AuthClaims) -> Result<String, String> {
        issue_jwt(claims, self.jwt_key.as_ref())
    }

    pub fn decode_session_jwt(&self, token: &str) -> Result<AuthClaims, String> {
        decode_jwt(token, self.jwt_key.as_ref())
    }

    pub async fn allow_rate(&self, key: String, limit: usize, window_seconds: i64) -> bool {
        let now = crate::nas::crypto::now_ts();
        let mut guard = self.rate_limits.lock().await;
        let entries = guard.entry(key).or_default();
        entries.retain(|ts| *ts > now - window_seconds);
        if entries.len() >= limit {
            return false;
        }
        entries.push(now);
        true
    }
}
