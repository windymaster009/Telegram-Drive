use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppRole {
    Admin,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

impl ApprovalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }
}

impl From<String> for ApprovalStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            _ => Self::Pending,
        }
    }
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
pub struct GoogleLoginRequest {
    pub code: String,
    pub redirect_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserApprovalRequest {
    pub approval_status: ApprovalStatus,
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
pub struct PublicQrRequest {
    pub identifier: String,
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
    pub telegram_username: Option<String>,
    pub disabled: bool,
    pub role: AppRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPatchRequest {
    pub display_name: Option<String>,
    pub telegram_username: Option<String>,
    pub disabled: Option<bool>,
    pub role: Option<AppRole>,
    pub password: Option<String>,
    pub approval_status: Option<ApprovalStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionAssignment {
    pub folder_id: String,
    pub folder_label: String,
    pub access_level: AccessLevel,
    pub is_private: bool,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub icon: Option<String>,
    pub is_password_protected: bool,
    pub can_manage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRecordView {
    pub folder_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub owner_id: String,
    pub owner_name: Option<String>,
    pub is_password_protected: bool,
    pub parent_folder_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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
    pub telegram_username: Option<String>,
    pub google_id: Option<String>,
    pub email: Option<String>,
    pub avatar: Option<String>,
    pub role: AppRole,
    pub disabled: bool,
    pub approval_status: ApprovalStatus,
    pub is_approved: bool,
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
pub struct QrStatusResponse {
    pub approved: bool,
    pub expired: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TelegramJobType {
    CreateFolder,
    UploadFile,
    RenameFolder,
    DeleteFolder,
    DeleteFile,
    MoveFiles,
    CopyFiles,
}

impl TelegramJobType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CreateFolder => "create_folder",
            Self::UploadFile => "upload_file",
            Self::RenameFolder => "rename_folder",
            Self::DeleteFolder => "delete_folder",
            Self::DeleteFile => "delete_file",
            Self::MoveFiles => "move_files",
            Self::CopyFiles => "copy_files",
        }
    }
}

impl From<String> for TelegramJobType {
    fn from(value: String) -> Self {
        match value.as_str() {
            "create_folder" => Self::CreateFolder,
            "upload_file" => Self::UploadFile,
            "rename_folder" => Self::RenameFolder,
            "delete_folder" => Self::DeleteFolder,
            "delete_file" => Self::DeleteFile,
            "move_files" => Self::MoveFiles,
            "copy_files" => Self::CopyFiles,
            _ => Self::UploadFile,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TelegramJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Delayed,
}

impl TelegramJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Delayed => "delayed",
        }
    }
}

impl From<String> for TelegramJobStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "delayed" => Self::Delayed,
            _ => Self::Queued,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramJobView {
    pub id: String,
    pub job_type: TelegramJobType,
    pub user_id: String,
    pub payload_json: String,
    pub status: TelegramJobStatus,
    pub priority: i32,
    pub attempts: i32,
    pub max_attempts: i32,
    pub run_after: i64,
    pub locked_at: Option<i64>,
    pub locked_by: Option<String>,
    pub error_message: Option<String>,
    pub result_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramJobStatusResponse {
    pub job: TelegramJobView,
    pub result: Option<serde_json::Value>,
}
