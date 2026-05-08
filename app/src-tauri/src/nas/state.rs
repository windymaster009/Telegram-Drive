use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::commands::TelegramState;

use super::crypto::{decode_jwt, ensure_master_key, issue_jwt};
use super::db::Database;
use super::models::AuthClaims;

#[derive(Clone)]
pub struct NasState {
    pub db: Database,
    pub app_data_dir: PathBuf,
    pub master_key: Arc<Vec<u8>>,
    pub jwt_key: Arc<Vec<u8>>,
    pub session_cookie_name: String,
    pub api_base_url: String,
    pub rate_limits: Arc<Mutex<HashMap<String, Vec<i64>>>>,
    pub telegram: Arc<TelegramState>,
}

impl NasState {
    pub async fn new(
        app_data_dir: PathBuf,
        api_base_url: String,
        telegram: Arc<TelegramState>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;

        let db = Database::new(app_data_dir.join("telegram_nas.sqlite3")).await?;
        let master_key = ensure_master_key(&app_data_dir.join("master.key"))?;
        let jwt_key = ensure_master_key(&app_data_dir.join("jwt.key"))?;

        Ok(Self {
            db,
            app_data_dir,
            master_key: Arc::new(master_key),
            jwt_key: Arc::new(jwt_key),
            session_cookie_name: "td_session".to_string(),
            api_base_url,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            telegram,
        })
    }

    pub fn issue_session_jwt(
        &self,
        claims: &AuthClaims,
    ) -> Result<String, String> {
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
