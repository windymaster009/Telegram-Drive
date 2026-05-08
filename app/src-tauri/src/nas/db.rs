use sqlite::{Connection, State};
use std::path::PathBuf;
use tokio::task;
use uuid::Uuid;

use super::models::{
    AccessLevel, AppRole, AppSession, AppUser, AuditEntry, PermissionAssignment,
};

#[derive(Clone)]
pub struct Database {
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session: AppSession,
    pub csrf_token: String,
    pub role: AppRole,
    pub disabled: bool,
}

#[derive(Debug, Clone)]
pub struct QrRedemption {
    pub user: AppUser,
    pub permissions: Vec<PermissionAssignment>,
}

impl Database {
    pub async fn new(path: PathBuf) -> Result<Self, String> {
        let db = Self { path };
        db.init().await?;
        Ok(db)
    }

    async fn with_conn<T, F>(&self, func: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(Connection) -> Result<T, String> + Send + 'static,
    {
        let path = self.path.clone();
        task::spawn_blocking(move || {
            let conn = sqlite::open(path).map_err(|err| err.to_string())?;
            conn.execute("PRAGMA foreign_keys = ON")
                .map_err(|err| err.to_string())?;
            func(conn)
        })
        .await
        .map_err(|err| err.to_string())?
    }

    pub async fn init(&self) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                CREATE TABLE IF NOT EXISTS roles (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  description TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                  id TEXT PRIMARY KEY,
                  username TEXT NOT NULL UNIQUE,
                  display_name TEXT NOT NULL,
                  telegram_username TEXT,
                  password_hash TEXT NOT NULL,
                  role_id TEXT NOT NULL REFERENCES roles(id),
                  disabled INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  csrf_token TEXT NOT NULL,
                  user_agent TEXT NOT NULL,
                  ip_address TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  last_seen_at INTEGER NOT NULL,
                  revoked_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS qr_tokens (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  token_hash TEXT NOT NULL UNIQUE,
                  expires_at INTEGER NOT NULL,
                  max_uses INTEGER NOT NULL DEFAULT 1,
                  current_uses INTEGER NOT NULL DEFAULT 0,
                  require_approval INTEGER NOT NULL DEFAULT 0,
                  approved_at INTEGER,
                  revoked_at INTEGER,
                  created_at INTEGER NOT NULL,
                  created_by TEXT REFERENCES users(id),
                  last_used_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS permissions (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  folder_id TEXT NOT NULL,
                  folder_label TEXT NOT NULL,
                  access_level TEXT NOT NULL,
                  is_private INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS shared_folders (
                  id TEXT PRIMARY KEY,
                  folder_id TEXT NOT NULL UNIQUE,
                  owner_user_id TEXT REFERENCES users(id),
                  display_name TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_logs (
                  id TEXT PRIMARY KEY,
                  actor_user_id TEXT REFERENCES users(id),
                  action TEXT NOT NULL,
                  target_type TEXT NOT NULL,
                  target_id TEXT NOT NULL,
                  metadata_json TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS secrets (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(|err| err.to_string())?;
            add_column_if_missing(
                &conn,
                "users",
                "telegram_username",
                "ALTER TABLE users ADD COLUMN telegram_username TEXT",
            )?;
            add_column_if_missing(
                &conn,
                "qr_tokens",
                "require_approval",
                "ALTER TABLE qr_tokens ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0",
            )?;
            add_column_if_missing(
                &conn,
                "qr_tokens",
                "approved_at",
                "ALTER TABLE qr_tokens ADD COLUMN approved_at INTEGER",
            )?;

            execute_bind3(
                &conn,
                "INSERT OR IGNORE INTO roles (id, name, description) VALUES (?1, ?2, ?3)",
                "admin",
                "admin",
                "Full administrative access",
            )?;
            execute_bind3(
                &conn,
                "INSERT OR IGNORE INTO roles (id, name, description) VALUES (?1, ?2, ?3)",
                "user",
                "user",
                "Standard NAS user",
            )?;
            Ok(())
        })
        .await
    }

    pub async fn setup_required(&self) -> Result<bool, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT COUNT(*) FROM users")
                .map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(statement.read::<i64, _>(0).map_err(|err| err.to_string())? == 0),
                State::Done => Ok(true),
            }
        })
        .await
    }

    pub async fn owner_configured(&self) -> Result<bool, String> {
        Ok(self.get_secret("owner_api_id".to_string()).await?.is_some())
    }

    pub async fn create_user(
        &self,
        username: String,
        display_name: String,
        telegram_username: Option<String>,
        password_hash: String,
        role: AppRole,
        disabled: bool,
    ) -> Result<AppUser, String> {
        self.with_conn(move |conn| {
            let now = crate::nas::crypto::now_ts();
            let user = AppUser {
                id: Uuid::new_v4().to_string(),
                username,
                display_name,
                telegram_username,
                role: role.clone(),
                disabled,
                created_at: now,
            };
            let mut statement = conn
                .prepare(
                    "INSERT INTO users (id, username, display_name, telegram_username, password_hash, role_id, disabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, user.id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, user.username.as_str())).map_err(|err| err.to_string())?;
            statement.bind((3, user.display_name.as_str())).map_err(|err| err.to_string())?;
            bind_optional_string(&mut statement, 4, user.telegram_username.as_ref())?;
            statement.bind((5, password_hash.as_str())).map_err(|err| err.to_string())?;
            statement.bind((6, role.as_str())).map_err(|err| err.to_string())?;
            statement.bind((7, if user.disabled { 1 } else { 0 })).map_err(|err| err.to_string())?;
            statement.bind((8, user.created_at)).map_err(|err| err.to_string())?;
            statement.bind((9, now)).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(user)
        })
        .await
    }

    pub async fn list_users(&self) -> Result<Vec<AppUser>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, username, display_name, telegram_username, role_id, disabled, created_at
                     FROM users ORDER BY created_at ASC",
                )
                .map_err(|err| err.to_string())?;
            let mut users = Vec::new();
            while let State::Row = statement.next().map_err(|err| err.to_string())? {
                users.push(AppUser {
                    id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                    username: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                    display_name: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    telegram_username: statement.read::<Option<String>, _>(3).map_err(|err| err.to_string())?,
                    role: AppRole::from(statement.read::<String, _>(4).map_err(|err| err.to_string())?),
                    disabled: statement.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
                    created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                });
            }
            Ok(users)
        })
        .await
    }

    pub async fn get_user_by_username(
        &self,
        username: String,
    ) -> Result<Option<(AppUser, String)>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, username, display_name, telegram_username, role_id, disabled, created_at, password_hash
                     FROM users WHERE username = ?1",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, username.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(Some((
                    AppUser {
                        id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                        username: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                        display_name: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                        telegram_username: statement.read::<Option<String>, _>(3).map_err(|err| err.to_string())?,
                        role: AppRole::from(statement.read::<String, _>(4).map_err(|err| err.to_string())?),
                        disabled: statement.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
                        created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                    },
                    statement.read::<String, _>(7).map_err(|err| err.to_string())?,
                ))),
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn get_user_by_id(&self, user_id: String) -> Result<Option<AppUser>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, username, display_name, telegram_username, role_id, disabled, created_at
                     FROM users WHERE id = ?1",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(Some(AppUser {
                    id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                    username: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                    display_name: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    telegram_username: statement.read::<Option<String>, _>(3).map_err(|err| err.to_string())?,
                    role: AppRole::from(statement.read::<String, _>(4).map_err(|err| err.to_string())?),
                    disabled: statement.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
                    created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                })),
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn get_user_by_login_identifier(
        &self,
        identifier: String,
    ) -> Result<Option<AppUser>, String> {
        self.with_conn(move |conn| {
            let normalized = identifier.trim().trim_start_matches('@').to_lowercase();
            let telegram = format!("@{}", normalized);
            let mut statement = conn
                .prepare(
                    "SELECT id, username, display_name, telegram_username, role_id, disabled, created_at
                     FROM users
                     WHERE lower(username) = ?1 OR lower(telegram_username) = ?2",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, normalized.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, telegram.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(Some(AppUser {
                    id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                    username: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                    display_name: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    telegram_username: statement.read::<Option<String>, _>(3).map_err(|err| err.to_string())?,
                    role: AppRole::from(statement.read::<String, _>(4).map_err(|err| err.to_string())?),
                    disabled: statement.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
                    created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                })),
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn patch_user(
        &self,
        user_id: String,
        display_name: Option<String>,
        telegram_username: Option<String>,
        disabled: Option<bool>,
        role: Option<AppRole>,
        password_hash: Option<String>,
    ) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut lookup = conn
                .prepare("SELECT display_name, telegram_username, disabled, role_id FROM users WHERE id = ?1")
                .map_err(|err| err.to_string())?;
            lookup.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            let (current_name, current_telegram_username, current_disabled, current_role) = match lookup.next().map_err(|err| err.to_string())? {
                State::Row => (
                    lookup.read::<String, _>(0).map_err(|err| err.to_string())?,
                    lookup.read::<Option<String>, _>(1).map_err(|err| err.to_string())?,
                    lookup.read::<i64, _>(2).map_err(|err| err.to_string())? != 0,
                    lookup.read::<String, _>(3).map_err(|err| err.to_string())?,
                ),
                State::Done => return Err("User not found".to_string()),
            };

            let mut update = conn
                .prepare("UPDATE users SET display_name = ?2, telegram_username = ?3, disabled = ?4, role_id = ?5, updated_at = ?6 WHERE id = ?1")
                .map_err(|err| err.to_string())?;
            update.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            update.bind((2, display_name.unwrap_or(current_name).as_str())).map_err(|err| err.to_string())?;
            let next_telegram_username = telegram_username.or(current_telegram_username);
            bind_optional_string(&mut update, 3, next_telegram_username.as_ref())?;
            update.bind((4, if disabled.unwrap_or(current_disabled) { 1 } else { 0 })).map_err(|err| err.to_string())?;
            update.bind((5, role.unwrap_or(AppRole::from(current_role)).as_str())).map_err(|err| err.to_string())?;
            update.bind((6, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            update.next().map_err(|err| err.to_string())?;

            if let Some(password_hash) = password_hash {
                let mut pw = conn
                    .prepare("UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1")
                    .map_err(|err| err.to_string())?;
                pw.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
                pw.bind((2, password_hash.as_str())).map_err(|err| err.to_string())?;
                pw.bind((3, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
                pw.next().map_err(|err| err.to_string())?;
            }

            Ok(())
        })
        .await
    }

    pub async fn delete_user(&self, user_id: String) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("DELETE FROM users WHERE id = ?1")
                .map_err(|err| err.to_string())?;
            statement.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn create_session(
        &self,
        user: &AppUser,
        csrf_token: String,
        ip_address: String,
        user_agent: String,
        ttl_seconds: i64,
    ) -> Result<AppSession, String> {
        let user = user.clone();
        self.with_conn(move |conn| {
            let now = crate::nas::crypto::now_ts();
            let session = AppSession {
                id: Uuid::new_v4().to_string(),
                user_id: user.id.clone(),
                username: user.username.clone(),
                created_at: now,
                expires_at: now + ttl_seconds,
                last_seen_at: now,
                user_agent,
                ip_address,
            };
            let mut statement = conn
                .prepare(
                    "INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip_address, created_at, expires_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, session.id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, session.user_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((3, csrf_token.as_str())).map_err(|err| err.to_string())?;
            statement.bind((4, session.user_agent.as_str())).map_err(|err| err.to_string())?;
            statement.bind((5, session.ip_address.as_str())).map_err(|err| err.to_string())?;
            statement.bind((6, session.created_at)).map_err(|err| err.to_string())?;
            statement.bind((7, session.expires_at)).map_err(|err| err.to_string())?;
            statement.bind((8, session.last_seen_at)).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(session)
        })
        .await
    }

    pub async fn get_session(&self, session_id: String) -> Result<Option<SessionRecord>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT s.id, s.user_id, s.csrf_token, s.user_agent, s.ip_address, s.created_at, s.expires_at, s.last_seen_at,
                            u.username, u.role_id, u.disabled
                     FROM sessions s
                     JOIN users u ON u.id = s.user_id
                     WHERE s.id = ?1 AND s.revoked_at IS NULL",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, session_id.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(Some(SessionRecord {
                    session: AppSession {
                        id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                        user_id: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                        username: statement.read::<String, _>(8).map_err(|err| err.to_string())?,
                        created_at: statement.read::<i64, _>(5).map_err(|err| err.to_string())?,
                        expires_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                        last_seen_at: statement.read::<i64, _>(7).map_err(|err| err.to_string())?,
                        user_agent: statement.read::<String, _>(3).map_err(|err| err.to_string())?,
                        ip_address: statement.read::<String, _>(4).map_err(|err| err.to_string())?,
                    },
                    csrf_token: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    role: AppRole::from(statement.read::<String, _>(9).map_err(|err| err.to_string())?),
                    disabled: statement.read::<i64, _>(10).map_err(|err| err.to_string())? != 0,
                })),
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn touch_session(&self, session_id: String) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1")
                .map_err(|err| err.to_string())?;
            statement.bind((1, session_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn revoke_session(&self, session_id: String) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("UPDATE sessions SET revoked_at = ?2 WHERE id = ?1")
                .map_err(|err| err.to_string())?;
            statement.bind((1, session_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn list_sessions(&self) -> Result<Vec<AppSession>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT s.id, s.user_id, u.username, s.created_at, s.expires_at, s.last_seen_at, s.user_agent, s.ip_address
                     FROM sessions s
                     JOIN users u ON u.id = s.user_id
                     WHERE s.revoked_at IS NULL
                     ORDER BY s.last_seen_at DESC",
                )
                .map_err(|err| err.to_string())?;
            let mut sessions = Vec::new();
            while let State::Row = statement.next().map_err(|err| err.to_string())? {
                sessions.push(AppSession {
                    id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                    user_id: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
                    username: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    created_at: statement.read::<i64, _>(3).map_err(|err| err.to_string())?,
                    expires_at: statement.read::<i64, _>(4).map_err(|err| err.to_string())?,
                    last_seen_at: statement.read::<i64, _>(5).map_err(|err| err.to_string())?,
                    user_agent: statement.read::<String, _>(6).map_err(|err| err.to_string())?,
                    ip_address: statement.read::<String, _>(7).map_err(|err| err.to_string())?,
                });
            }
            Ok(sessions)
        })
        .await
    }

    pub async fn create_qr_token(
        &self,
        user_id: String,
        token_hash: String,
        created_by: String,
        expires_at: i64,
        require_approval: bool,
    ) -> Result<(), String> {
        self.with_conn(move |conn| {
            let qr_id = Uuid::new_v4().to_string();
            let mut statement = conn
                .prepare(
                    "INSERT INTO qr_tokens (id, user_id, token_hash, expires_at, require_approval, created_at, created_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, qr_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, user_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((3, token_hash.as_str())).map_err(|err| err.to_string())?;
            statement.bind((4, expires_at)).map_err(|err| err.to_string())?;
            statement.bind((5, if require_approval { 1 } else { 0 })).map_err(|err| err.to_string())?;
            statement.bind((6, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.bind((7, created_by.as_str())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn revoke_qr_tokens_for_user(&self, user_id: String) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("UPDATE qr_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL")
                .map_err(|err| err.to_string())?;
            statement.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn redeem_qr_token(&self, token_hash: String) -> Result<Option<QrRedemption>, String> {
        self.with_conn(move |conn| {
            let mut lookup = conn
                .prepare(
                    "SELECT user_id, expires_at, max_uses, current_uses, revoked_at, require_approval, approved_at
                     FROM qr_tokens WHERE token_hash = ?1",
                )
                .map_err(|err| err.to_string())?;
            lookup.bind((1, token_hash.as_str())).map_err(|err| err.to_string())?;
            let (user_id, expires_at, max_uses, current_uses, revoked_at, require_approval, approved_at) = match lookup.next().map_err(|err| err.to_string())? {
                State::Row => (
                    lookup.read::<String, _>(0).map_err(|err| err.to_string())?,
                    lookup.read::<i64, _>(1).map_err(|err| err.to_string())?,
                    lookup.read::<i64, _>(2).map_err(|err| err.to_string())?,
                    lookup.read::<i64, _>(3).map_err(|err| err.to_string())?,
                    lookup.read::<Option<i64>, _>(4).map_err(|err| err.to_string())?,
                    lookup.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
                    lookup.read::<Option<i64>, _>(6).map_err(|err| err.to_string())?,
                ),
                State::Done => return Ok(None),
            };

            if revoked_at.is_some()
                || expires_at < crate::nas::crypto::now_ts()
                || current_uses >= max_uses
                || (require_approval && approved_at.is_none())
            {
                return Ok(None);
            }

            let mut touch = conn
                .prepare("UPDATE qr_tokens SET current_uses = current_uses + 1, last_used_at = ?2 WHERE token_hash = ?1")
                .map_err(|err| err.to_string())?;
            touch.bind((1, token_hash.as_str())).map_err(|err| err.to_string())?;
            touch.bind((2, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            touch.next().map_err(|err| err.to_string())?;

            let user = get_user(&conn, &user_id)?.ok_or("User not found")?;
            let permissions = load_permissions(&conn, &user_id)?;
            Ok(Some(QrRedemption { user, permissions }))
        })
        .await
    }

    pub async fn approve_qr_token(&self, token_hash: String) -> Result<bool, String> {
        self.with_conn(move |conn| {
            let now = crate::nas::crypto::now_ts();
            let mut statement = conn
                .prepare(
                    "UPDATE qr_tokens
                     SET approved_at = ?2
                     WHERE token_hash = ?1
                       AND revoked_at IS NULL
                       AND approved_at IS NULL
                       AND expires_at >= ?2
                       AND current_uses < max_uses",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, token_hash.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, now)).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(conn.change_count() > 0)
        })
        .await
    }

    pub async fn get_qr_status(&self, token_hash: String) -> Result<Option<(bool, bool)>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("SELECT approved_at, expires_at, revoked_at, current_uses, max_uses FROM qr_tokens WHERE token_hash = ?1")
                .map_err(|err| err.to_string())?;
            statement.bind((1, token_hash.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => {
                    let approved_at = statement.read::<Option<i64>, _>(0).map_err(|err| err.to_string())?;
                    let expires_at = statement.read::<i64, _>(1).map_err(|err| err.to_string())?;
                    let revoked_at = statement.read::<Option<i64>, _>(2).map_err(|err| err.to_string())?;
                    let current_uses = statement.read::<i64, _>(3).map_err(|err| err.to_string())?;
                    let max_uses = statement.read::<i64, _>(4).map_err(|err| err.to_string())?;
                    let expired = revoked_at.is_some()
                        || expires_at < crate::nas::crypto::now_ts()
                        || current_uses >= max_uses;
                    Ok(Some((approved_at.is_some(), expired)))
                }
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn get_permissions(&self, user_id: String) -> Result<Vec<PermissionAssignment>, String> {
        self.with_conn(move |conn| load_permissions(&conn, &user_id)).await
    }

    pub async fn set_permissions(
        &self,
        user_id: String,
        permissions: Vec<PermissionAssignment>,
    ) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute("BEGIN").map_err(|err| err.to_string())?;
            let mut clear = conn
                .prepare("DELETE FROM permissions WHERE user_id = ?1")
                .map_err(|err| err.to_string())?;
            clear.bind((1, user_id.as_str())).map_err(|err| err.to_string())?;
            clear.next().map_err(|err| err.to_string())?;

            let now = crate::nas::crypto::now_ts();
            for permission in permissions {
                let id = Uuid::new_v4().to_string();
                let mut statement = conn
                    .prepare(
                        "INSERT INTO permissions (id, user_id, folder_id, folder_label, access_level, is_private, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )
                    .map_err(|err| err.to_string())?;
                statement.bind((1, id.as_str())).map_err(|err| err.to_string())?;
                statement.bind((2, user_id.as_str())).map_err(|err| err.to_string())?;
                statement.bind((3, permission.folder_id.as_str())).map_err(|err| err.to_string())?;
                statement.bind((4, permission.folder_label.as_str())).map_err(|err| err.to_string())?;
                statement.bind((5, permission.access_level.as_str())).map_err(|err| err.to_string())?;
                statement.bind((6, if permission.is_private { 1 } else { 0 })).map_err(|err| err.to_string())?;
                statement.bind((7, now)).map_err(|err| err.to_string())?;
                statement.bind((8, now)).map_err(|err| err.to_string())?;
                statement.next().map_err(|err| err.to_string())?;
            }
            conn.execute("COMMIT").map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn store_secret(&self, key: String, value: String) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "INSERT INTO secrets (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, key.as_str())).map_err(|err| err.to_string())?;
            statement.bind((2, value.as_str())).map_err(|err| err.to_string())?;
            statement.bind((3, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn get_secret(&self, key: String) -> Result<Option<String>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("SELECT value FROM secrets WHERE key = ?1")
                .map_err(|err| err.to_string())?;
            statement.bind((1, key.as_str())).map_err(|err| err.to_string())?;
            match statement.next().map_err(|err| err.to_string())? {
                State::Row => Ok(Some(statement.read::<String, _>(0).map_err(|err| err.to_string())?)),
                State::Done => Ok(None),
            }
        })
        .await
    }

    pub async fn add_audit_log(
        &self,
        actor_user_id: Option<String>,
        action: String,
        target_type: String,
        target_id: String,
        metadata_json: String,
    ) -> Result<(), String> {
        self.with_conn(move |conn| {
            let id = Uuid::new_v4().to_string();
            let mut statement = conn
                .prepare(
                    "INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|err| err.to_string())?;
            statement.bind((1, id.as_str())).map_err(|err| err.to_string())?;
            match actor_user_id {
                Some(ref value) => statement.bind((2, value.as_str())).map_err(|err| err.to_string())?,
                None => statement.bind((2, sqlite::Value::Null)).map_err(|err| err.to_string())?,
            }
            statement.bind((3, action.as_str())).map_err(|err| err.to_string())?;
            statement.bind((4, target_type.as_str())).map_err(|err| err.to_string())?;
            statement.bind((5, target_id.as_str())).map_err(|err| err.to_string())?;
            statement.bind((6, metadata_json.as_str())).map_err(|err| err.to_string())?;
            statement.bind((7, crate::nas::crypto::now_ts())).map_err(|err| err.to_string())?;
            statement.next().map_err(|err| err.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn list_audit_logs(&self) -> Result<Vec<AuditEntry>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, actor_user_id, action, target_type, target_id, metadata_json, created_at
                     FROM audit_logs ORDER BY created_at DESC LIMIT 200",
                )
                .map_err(|err| err.to_string())?;
            let mut rows = Vec::new();
            while let State::Row = statement.next().map_err(|err| err.to_string())? {
                rows.push(AuditEntry {
                    id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
                    actor_user_id: statement.read::<Option<String>, _>(1).map_err(|err| err.to_string())?,
                    action: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
                    target_type: statement.read::<String, _>(3).map_err(|err| err.to_string())?,
                    target_id: statement.read::<String, _>(4).map_err(|err| err.to_string())?,
                    metadata_json: statement.read::<String, _>(5).map_err(|err| err.to_string())?,
                    created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
                });
            }
            Ok(rows)
        })
        .await
    }
}

fn get_user(conn: &Connection, user_id: &str) -> Result<Option<AppUser>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, username, display_name, telegram_username, role_id, disabled, created_at
             FROM users WHERE id = ?1",
        )
        .map_err(|err| err.to_string())?;
    statement.bind((1, user_id)).map_err(|err| err.to_string())?;
    match statement.next().map_err(|err| err.to_string())? {
        State::Row => Ok(Some(AppUser {
            id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
            username: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
            display_name: statement.read::<String, _>(2).map_err(|err| err.to_string())?,
            telegram_username: statement.read::<Option<String>, _>(3).map_err(|err| err.to_string())?,
            role: AppRole::from(statement.read::<String, _>(4).map_err(|err| err.to_string())?),
            disabled: statement.read::<i64, _>(5).map_err(|err| err.to_string())? != 0,
            created_at: statement.read::<i64, _>(6).map_err(|err| err.to_string())?,
        })),
        State::Done => Ok(None),
    }
}

fn load_permissions(conn: &Connection, user_id: &str) -> Result<Vec<PermissionAssignment>, String> {
    let mut statement = conn
        .prepare(
            "SELECT folder_id, folder_label, access_level, is_private
             FROM permissions WHERE user_id = ?1 ORDER BY folder_label ASC",
        )
        .map_err(|err| err.to_string())?;
    statement.bind((1, user_id)).map_err(|err| err.to_string())?;
    let mut permissions = Vec::new();
    while let State::Row = statement.next().map_err(|err| err.to_string())? {
        permissions.push(PermissionAssignment {
            folder_id: statement.read::<String, _>(0).map_err(|err| err.to_string())?,
            folder_label: statement.read::<String, _>(1).map_err(|err| err.to_string())?,
            access_level: AccessLevel::from(statement.read::<String, _>(2).map_err(|err| err.to_string())?),
            is_private: statement.read::<i64, _>(3).map_err(|err| err.to_string())? != 0,
        });
    }
    Ok(permissions)
}

fn execute_bind3(conn: &Connection, sql: &str, a: &str, b: &str, c: &str) -> Result<(), String> {
    let mut statement = conn.prepare(sql).map_err(|err| err.to_string())?;
    statement.bind((1, a)).map_err(|err| err.to_string())?;
    statement.bind((2, b)).map_err(|err| err.to_string())?;
    statement.bind((3, c)).map_err(|err| err.to_string())?;
    statement.next().map_err(|err| err.to_string())?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let mut statement = conn
        .prepare(format!("PRAGMA table_info({})", table))
        .map_err(|err| err.to_string())?;
    while let State::Row = statement.next().map_err(|err| err.to_string())? {
        let name = statement.read::<String, _>(1).map_err(|err| err.to_string())?;
        if name == column {
            return Ok(());
        }
    }
    conn.execute(alter_sql).map_err(|err| err.to_string())
}

fn bind_optional_string(
    statement: &mut sqlite::Statement<'_>,
    index: usize,
    value: Option<&String>,
) -> Result<(), String> {
    match value {
        Some(value) if !value.is_empty() => statement
            .bind((index, value.as_str()))
            .map_err(|err| err.to_string()),
        _ => statement
            .bind((index, sqlite::Value::Null))
            .map_err(|err| err.to_string()),
    }
}
