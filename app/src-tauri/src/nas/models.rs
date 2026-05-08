use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppRole {
    Admin,
    User,
}

impl AppRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::User => "user",
        }
    }
}

impl From<String> for AppRole {
    fn from(value: String) -> Self {
        match value.as_str() {
            "admin" => Self::Admin,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatus {
    pub setup_required: bool,
    pub owner_configured: bool,
    pub owner_connected: bool,
    pub api_base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapRequest {
    pub username: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerConfigRequest {
    pub api_id: i32,
    pub api_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserUpsertRequest {
    pub username: String,
    pub password: Option<String>,
    pub display_name: String,
    pub disabled: bool,
    pub role: AppRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPatchRequest {
    pub display_name: Option<String>,
    pub disabled: Option<bool>,
    pub role: Option<AppRole>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionAssignment {
    pub folder_id: String,
    pub folder_label: String,
    pub access_level: AccessLevel,
    pub is_private: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessLevel {
    ReadOnly,
    ReadWrite,
}

impl AccessLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::ReadWrite => "read_write",
        }
    }
}

impl From<String> for AccessLevel {
    fn from(value: String) -> Self {
        match value.as_str() {
            "read_write" => Self::ReadWrite,
            _ => Self::ReadOnly,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionUpdateRequest {
    pub permissions: Vec<PermissionAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user: AppUser,
    pub csrf_token: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: AppRole,
    pub disabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSession {
    pub id: String,
    pub user_id: String,
    pub username: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_at: i64,
    pub user_agent: String,
    pub ip_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QrTokenResponse {
    pub token: String,
    pub login_url: String,
    pub expires_at: i64,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeResponse {
    pub user: AppUser,
    pub permissions: Vec<PermissionAssignment>,
    pub owner_connected: bool,
    pub csrf_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub actor_user_id: Option<String>,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub metadata_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthClaims {
    pub sub: String,
    pub sid: String,
    pub role: String,
    pub exp: usize,
}
