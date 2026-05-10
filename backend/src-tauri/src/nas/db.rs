use futures::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, DateTime},
    options::{ClientOptions, IndexOptions, UpdateOptions},
    Client, Collection, IndexModel,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::crypto::verify_password;
use super::models::{
    AccessLevel, AppRole, AppSession, AppUser, ApprovalStatus, AuditEntry, FolderRecordView,
    PermissionAssignment,
};

#[derive(Clone)]
pub struct Database {
    users: Collection<UserRecord>,
    sessions: Collection<SessionRecordDoc>,
    permissions: Collection<PermissionRecord>,
    folders: Collection<FolderRecord>,
    qr_tokens: Collection<QrTokenRecord>,
    secrets: Collection<SecretRecord>,
    audit_logs: Collection<AuditRecord>,
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session: AppSession,
    pub csrf_token: String,
    pub role: AppRole,
    pub disabled: bool,
    pub approval_status: ApprovalStatus,
    pub is_approved: bool,
}

#[derive(Debug, Clone)]
pub struct QrRedemption {
    pub user: AppUser,
    pub permissions: Vec<PermissionAssignment>,
}

#[derive(Debug, Clone)]
pub struct GoogleUserProfile {
    pub google_id: String,
    pub email: String,
    pub name: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserRecord {
    id: String,
    username: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    telegram_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    google_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
    role: AppRole,
    disabled: bool,
    approval_status: ApprovalStatus,
    is_approved: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecordDoc {
    id: String,
    user_id: String,
    csrf_token: String,
    user_agent: String,
    ip_address: String,
    created_at: i64,
    expires_at: i64,
    last_seen_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PermissionRecord {
    id: String,
    user_id: String,
    folder_id: String,
    folder_label: String,
    access_level: AccessLevel,
    is_private: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderRecord {
    id: String,
    #[serde(rename = "telegramFolderId")]
    telegram_folder_id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "ownerName", skip_serializing_if = "Option::is_none")]
    owner_name: Option<String>,
    #[serde(rename = "passwordHash", skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
    #[serde(rename = "isPasswordProtected")]
    is_password_protected: bool,
    #[serde(rename = "parentFolderId", skip_serializing_if = "Option::is_none")]
    parent_folder_id: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: DateTime,
    #[serde(rename = "updatedAt")]
    updated_at: DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QrTokenRecord {
    id: String,
    user_id: String,
    token_hash: String,
    expires_at: i64,
    max_uses: i64,
    current_uses: i64,
    require_approval: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    approved_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at: Option<i64>,
    created_at: i64,
    created_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretRecord {
    key: String,
    value: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuditRecord {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor_user_id: Option<String>,
    action: String,
    target_type: String,
    target_id: String,
    metadata_json: String,
    created_at: i64,
}

impl Database {
    pub async fn new() -> Result<Self, String> {
        let uri = std::env::var("MONGODB_URI")
            .map_err(|_| "MONGODB_URI is required in backend/.env".to_string())?;
        let db_name =
            std::env::var("MONGODB_DB_NAME").unwrap_or_else(|_| "telegram_drive".to_string());
        let mut options = ClientOptions::parse(uri)
            .await
            .map_err(|err| err.to_string())?;
        options.app_name = Some("Telegram Drive Backend".to_string());
        let client = Client::with_options(options).map_err(|err| err.to_string())?;
        let db = client.database(&db_name);

        let database = Self {
            users: db.collection("users"),
            sessions: db.collection("sessions"),
            permissions: db.collection("permissions"),
            folders: db.collection("folders"),
            qr_tokens: db.collection("qr_tokens"),
            secrets: db.collection("secrets"),
            audit_logs: db.collection("audit_logs"),
        };
        database.init().await?;
        Ok(database)
    }

    async fn init(&self) -> Result<(), String> {
        self.ensure_unique_index(&self.users, "google_id").await?;
        self.ensure_unique_index(&self.users, "email").await?;
        self.ensure_unique_index(&self.sessions, "id").await?;
        self.ensure_unique_index(&self.folders, "telegramFolderId")
            .await?;
        self.ensure_unique_index(&self.qr_tokens, "token_hash")
            .await?;
        self.ensure_unique_index(&self.secrets, "key").await?;
        Ok(())
    }

    async fn ensure_unique_index<T>(
        &self,
        collection: &Collection<T>,
        field: &str,
    ) -> Result<(), String>
    where
        T: Send + Sync,
    {
        let options = IndexOptions::builder()
            .unique(true)
            .sparse(true)
            .name(format!("unique_{}", field))
            .build();
        let model = IndexModel::builder()
            .keys(doc! { field: 1 })
            .options(options)
            .build();
        collection
            .create_index(model, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn setup_required(&self) -> Result<bool, String> {
        Ok(false)
    }

    pub async fn owner_configured(&self) -> Result<bool, String> {
        Ok(self.get_secret("owner_api_id".to_string()).await?.is_some()
            && self
                .get_secret("owner_api_hash".to_string())
                .await?
                .is_some())
    }

    pub async fn upsert_google_user(&self, profile: GoogleUserProfile) -> Result<AppUser, String> {
        let now = crate::nas::crypto::now_ts();
        if let Some(mut existing) = self
            .users
            .find_one(
                doc! {
                    "$or": [
                        { "google_id": &profile.google_id },
                        { "email": profile.email.to_lowercase() }
                    ]
                },
                None,
            )
            .await
            .map_err(|err| err.to_string())?
        {
            existing.google_id = Some(profile.google_id);
            existing.email = Some(profile.email.to_lowercase());
            existing.display_name = profile.name;
            existing.avatar = profile.avatar;
            existing.updated_at = now;
            self.users
                .replace_one(doc! { "id": &existing.id }, &existing, None)
                .await
                .map_err(|err| err.to_string())?;
            return Ok(existing.into());
        }

        let user = UserRecord {
            id: Uuid::new_v4().to_string(),
            username: profile.email.to_lowercase(),
            display_name: profile.name,
            telegram_username: None,
            password_hash: None,
            google_id: Some(profile.google_id),
            email: Some(profile.email.to_lowercase()),
            avatar: profile.avatar,
            role: AppRole::User,
            disabled: false,
            approval_status: ApprovalStatus::Pending,
            is_approved: false,
            created_at: now,
            updated_at: now,
        };
        self.users
            .insert_one(&user, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(user.into())
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
        let now = crate::nas::crypto::now_ts();
        let is_approved = role == AppRole::Admin;
        let user = UserRecord {
            id: Uuid::new_v4().to_string(),
            username,
            display_name,
            telegram_username,
            password_hash: Some(password_hash),
            google_id: None,
            email: None,
            avatar: None,
            role,
            disabled,
            approval_status: if is_approved {
                ApprovalStatus::Approved
            } else {
                ApprovalStatus::Pending
            },
            is_approved,
            created_at: now,
            updated_at: now,
        };
        self.users
            .insert_one(&user, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(user.into())
    }

    pub async fn list_users(&self) -> Result<Vec<AppUser>, String> {
        let mut cursor = self
            .users
            .find(doc! {}, None)
            .await
            .map_err(|err| err.to_string())?;
        let mut users = Vec::new();
        while let Some(user) = cursor.try_next().await.map_err(|err| err.to_string())? {
            users.push(user.into());
        }
        Ok(users)
    }

    pub async fn get_user_by_username(
        &self,
        username: String,
    ) -> Result<Option<(AppUser, String)>, String> {
        let Some(user) = self
            .users
            .find_one(doc! { "username": username }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        let Some(password_hash) = user.password_hash.clone() else {
            return Ok(None);
        };
        Ok(Some((user.into(), password_hash)))
    }

    pub async fn get_user_by_id(&self, user_id: String) -> Result<Option<AppUser>, String> {
        Ok(self
            .users
            .find_one(doc! { "id": user_id }, None)
            .await
            .map_err(|err| err.to_string())?
            .map(Into::into))
    }

    pub async fn get_user_by_login_identifier(
        &self,
        identifier: String,
    ) -> Result<Option<AppUser>, String> {
        let normalized = identifier.trim().trim_start_matches('@').to_lowercase();
        let telegram = format!("@{}", normalized);
        Ok(self
            .users
            .find_one(
                doc! { "$or": [{ "username": &normalized }, { "email": &normalized }, { "telegram_username": telegram }] },
                None,
            )
            .await
            .map_err(|err| err.to_string())?
            .map(Into::into))
    }

    pub async fn patch_user(
        &self,
        user_id: String,
        display_name: Option<String>,
        telegram_username: Option<String>,
        disabled: Option<bool>,
        role: Option<AppRole>,
        password_hash: Option<String>,
        approval_status: Option<ApprovalStatus>,
    ) -> Result<(), String> {
        let mut set = doc! { "updated_at": crate::nas::crypto::now_ts() };
        if let Some(value) = display_name {
            set.insert("display_name", value);
        }
        if let Some(value) = telegram_username {
            set.insert("telegram_username", value);
        }
        if let Some(value) = disabled {
            set.insert("disabled", value);
        }
        if let Some(value) = role {
            set.insert("role", value.as_str());
        }
        if let Some(value) = password_hash {
            set.insert("password_hash", value);
        }
        if let Some(value) = approval_status {
            set.insert("approval_status", value.as_str());
            set.insert("is_approved", value == ApprovalStatus::Approved);
        }
        self.users
            .update_one(doc! { "id": user_id }, doc! { "$set": set }, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn set_user_approval(
        &self,
        user_id: String,
        approval_status: ApprovalStatus,
    ) -> Result<(), String> {
        self.patch_user(user_id, None, None, None, None, None, Some(approval_status))
            .await
    }

    pub async fn delete_user(&self, user_id: String) -> Result<(), String> {
        self.users
            .delete_one(doc! { "id": &user_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        self.sessions
            .delete_many(doc! { "user_id": &user_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        self.permissions
            .delete_many(doc! { "user_id": &user_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn create_session(
        &self,
        user: &AppUser,
        csrf_token: String,
        ip_address: String,
        user_agent: String,
        ttl_seconds: i64,
    ) -> Result<AppSession, String> {
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
        let record = SessionRecordDoc {
            id: session.id.clone(),
            user_id: session.user_id.clone(),
            csrf_token,
            user_agent: session.user_agent.clone(),
            ip_address: session.ip_address.clone(),
            created_at: session.created_at,
            expires_at: session.expires_at,
            last_seen_at: session.last_seen_at,
            revoked_at: None,
        };
        self.sessions
            .insert_one(record, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(session)
    }

    pub async fn get_session(&self, session_id: String) -> Result<Option<SessionRecord>, String> {
        let Some(session) = self
            .sessions
            .find_one(doc! { "id": session_id, "revoked_at": Bson::Null }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        let Some(user) = self
            .users
            .find_one(doc! { "id": &session.user_id }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        Ok(Some(SessionRecord {
            session: AppSession {
                id: session.id,
                user_id: session.user_id,
                username: user.username.clone(),
                created_at: session.created_at,
                expires_at: session.expires_at,
                last_seen_at: session.last_seen_at,
                user_agent: session.user_agent,
                ip_address: session.ip_address,
            },
            csrf_token: session.csrf_token,
            role: user.role,
            disabled: user.disabled,
            approval_status: user.approval_status,
            is_approved: user.is_approved,
        }))
    }

    pub async fn touch_session(&self, session_id: String) -> Result<(), String> {
        self.sessions
            .update_one(
                doc! { "id": session_id },
                doc! { "$set": { "last_seen_at": crate::nas::crypto::now_ts() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn revoke_session(&self, session_id: String) -> Result<(), String> {
        self.sessions
            .update_one(
                doc! { "id": session_id },
                doc! { "$set": { "revoked_at": crate::nas::crypto::now_ts() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn list_sessions(&self) -> Result<Vec<AppSession>, String> {
        let mut cursor = self
            .sessions
            .find(doc! { "revoked_at": Bson::Null }, None)
            .await
            .map_err(|err| err.to_string())?;
        let mut sessions = Vec::new();
        while let Some(session) = cursor.try_next().await.map_err(|err| err.to_string())? {
            let username = self
                .users
                .find_one(doc! { "id": &session.user_id }, None)
                .await
                .map_err(|err| err.to_string())?
                .map(|user| user.username)
                .unwrap_or_else(|| "unknown".to_string());
            sessions.push(AppSession {
                id: session.id,
                user_id: session.user_id,
                username,
                created_at: session.created_at,
                expires_at: session.expires_at,
                last_seen_at: session.last_seen_at,
                user_agent: session.user_agent,
                ip_address: session.ip_address,
            });
        }
        Ok(sessions)
    }

    pub async fn create_qr_token(
        &self,
        user_id: String,
        token_hash: String,
        created_by: String,
        expires_at: i64,
        require_approval: bool,
    ) -> Result<(), String> {
        self.qr_tokens
            .insert_one(
                QrTokenRecord {
                    id: Uuid::new_v4().to_string(),
                    user_id,
                    token_hash,
                    expires_at,
                    max_uses: 1,
                    current_uses: 0,
                    require_approval,
                    approved_at: None,
                    revoked_at: None,
                    created_at: crate::nas::crypto::now_ts(),
                    created_by,
                    last_used_at: None,
                },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn revoke_qr_tokens_for_user(&self, user_id: String) -> Result<(), String> {
        self.qr_tokens
            .update_many(
                doc! { "user_id": user_id, "revoked_at": Bson::Null },
                doc! { "$set": { "revoked_at": crate::nas::crypto::now_ts() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn redeem_qr_token(
        &self,
        token_hash: String,
    ) -> Result<Option<QrRedemption>, String> {
        let Some(token) = self
            .qr_tokens
            .find_one(doc! { "token_hash": &token_hash }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        if token.revoked_at.is_some()
            || token.expires_at < crate::nas::crypto::now_ts()
            || token.current_uses >= token.max_uses
            || (token.require_approval && token.approved_at.is_none())
        {
            return Ok(None);
        }
        self.qr_tokens
            .update_one(
                doc! { "token_hash": &token_hash },
                doc! { "$inc": { "current_uses": 1 }, "$set": { "last_used_at": crate::nas::crypto::now_ts() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        let Some(user) = self.get_user_by_id(token.user_id.clone()).await? else {
            return Ok(None);
        };
        let permissions = self.get_permissions(token.user_id).await?;
        Ok(Some(QrRedemption { user, permissions }))
    }

    pub async fn approve_qr_token(&self, token_hash: String) -> Result<bool, String> {
        let result = self
            .qr_tokens
            .update_one(
                doc! { "token_hash": token_hash, "revoked_at": Bson::Null, "approved_at": Bson::Null },
                doc! { "$set": { "approved_at": crate::nas::crypto::now_ts() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(result.modified_count > 0)
    }

    pub async fn get_qr_status(&self, token_hash: String) -> Result<Option<(bool, bool)>, String> {
        let Some(token) = self
            .qr_tokens
            .find_one(doc! { "token_hash": token_hash }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        let expired = token.revoked_at.is_some()
            || token.expires_at < crate::nas::crypto::now_ts()
            || token.current_uses >= token.max_uses;
        Ok(Some((token.approved_at.is_some(), expired)))
    }

    pub async fn get_permissions(
        &self,
        user_id: String,
    ) -> Result<Vec<PermissionAssignment>, String> {
        let mut cursor = self
            .permissions
            .find(doc! { "user_id": &user_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        let mut permissions = Vec::new();
        while let Some(permission) = cursor.try_next().await.map_err(|err| err.to_string())? {
            let folder = self
                .get_folder_by_telegram_id(permission.folder_id.clone())
                .await?;
            permissions.push(PermissionAssignment {
                folder_id: permission.folder_id.clone(),
                folder_label: folder
                    .as_ref()
                    .map(|folder| folder.name.clone())
                    .unwrap_or(permission.folder_label),
                access_level: permission.access_level,
                is_private: permission.is_private,
                owner_id: folder.as_ref().map(|folder| folder.owner_id.clone()),
                owner_name: folder.as_ref().and_then(|folder| folder.owner_name.clone()),
                icon: folder.as_ref().and_then(|folder| folder.icon.clone()),
                is_password_protected: folder
                    .as_ref()
                    .map(|folder| folder.is_password_protected)
                    .unwrap_or(false),
                can_manage: folder
                    .as_ref()
                    .map(|folder| folder.owner_id.as_str() == user_id.as_str())
                    .unwrap_or(false),
            });
        }
        Ok(permissions)
    }

    pub async fn set_permissions(
        &self,
        user_id: String,
        permissions: Vec<PermissionAssignment>,
    ) -> Result<(), String> {
        self.permissions
            .delete_many(doc! { "user_id": &user_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        if permissions.is_empty() {
            return Ok(());
        }
        let now = crate::nas::crypto::now_ts();
        let docs = permissions.into_iter().map(|permission| PermissionRecord {
            id: Uuid::new_v4().to_string(),
            user_id: user_id.clone(),
            folder_id: permission.folder_id,
            folder_label: permission.folder_label,
            access_level: permission.access_level,
            is_private: permission.is_private,
            created_at: now,
            updated_at: now,
        });
        self.permissions
            .insert_many(docs, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn upsert_folder_metadata(
        &self,
        telegram_folder_id: String,
        name: String,
        parent_folder_id: Option<String>,
        owner: &AppUser,
    ) -> Result<FolderRecordView, String> {
        let now = DateTime::now();
        if let Some(existing) = self
            .folders
            .find_one(doc! { "telegramFolderId": &telegram_folder_id }, None)
            .await
            .map_err(|err| err.to_string())?
        {
            self.folders
                .update_one(
                    doc! { "telegramFolderId": &telegram_folder_id },
                    doc! { "$set": { "name": &name, "parentFolderId": parent_folder_id.clone(), "updatedAt": now } },
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            if existing.owner_id == "local-desktop-admin" && owner.id != "local-desktop-admin" {
                let owner_name = folder_owner_name(owner);
                self.folders
                    .update_one(
                        doc! { "telegramFolderId": &telegram_folder_id },
                        doc! { "$set": { "ownerId": &owner.id, "ownerName": owner_name, "updatedAt": now } },
                        None,
                    )
                    .await
                    .map_err(|err| err.to_string())?;
                return Ok(FolderRecord {
                    name,
                    parent_folder_id,
                    owner_id: owner.id.clone(),
                    owner_name: Some(folder_owner_name(owner)),
                    updated_at: now,
                    ..existing
                }
                .into());
            }
            return Ok(FolderRecord {
                name,
                parent_folder_id,
                updated_at: now,
                ..existing
            }
            .into());
        }

        let record = FolderRecord {
            id: Uuid::new_v4().to_string(),
            telegram_folder_id,
            name,
            icon: None,
            owner_id: owner.id.clone(),
            owner_name: Some(folder_owner_name(owner)),
            password_hash: None,
            is_password_protected: false,
            parent_folder_id,
            created_at: now,
            updated_at: now,
        };
        self.folders
            .insert_one(&record, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(record.into())
    }

    pub async fn get_folder_by_telegram_id(
        &self,
        telegram_folder_id: String,
    ) -> Result<Option<FolderRecordView>, String> {
        Ok(self
            .folders
            .find_one(doc! { "telegramFolderId": telegram_folder_id }, None)
            .await
            .map_err(|err| err.to_string())?
            .map(Into::into))
    }

    pub async fn rename_folder_metadata(
        &self,
        telegram_folder_id: String,
        name: String,
    ) -> Result<(), String> {
        self.folders
            .update_one(
                doc! { "telegramFolderId": telegram_folder_id },
                doc! { "$set": { "name": name, "updatedAt": DateTime::now() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn set_folder_icon(
        &self,
        telegram_folder_id: String,
        icon: Option<String>,
    ) -> Result<(), String> {
        self.folders
            .update_one(
                doc! { "telegramFolderId": telegram_folder_id },
                doc! { "$set": { "icon": icon, "updatedAt": DateTime::now() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn set_folder_password_hash(
        &self,
        telegram_folder_id: String,
        password_hash: Option<String>,
    ) -> Result<(), String> {
        let protected = password_hash.is_some();
        self.folders
            .update_one(
                doc! { "telegramFolderId": telegram_folder_id },
                doc! { "$set": { "passwordHash": password_hash, "isPasswordProtected": protected, "updatedAt": DateTime::now() } },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn verify_folder_password(
        &self,
        telegram_folder_id: String,
        password: String,
    ) -> Result<bool, String> {
        let Some(folder) = self
            .folders
            .find_one(doc! { "telegramFolderId": telegram_folder_id }, None)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(false);
        };
        let Some(password_hash) = folder.password_hash else {
            return Ok(true);
        };
        verify_password(&password, &password_hash)
    }

    pub async fn delete_folder_metadata(&self, telegram_folder_id: String) -> Result<(), String> {
        self.folders
            .delete_one(doc! { "telegramFolderId": telegram_folder_id }, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn store_secret(&self, key: String, value: String) -> Result<(), String> {
        let options = UpdateOptions::builder().upsert(true).build();
        self.secrets
            .update_one(
                doc! { "key": &key },
                doc! { "$set": { "key": key, "value": value, "updated_at": crate::nas::crypto::now_ts() } },
                options,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn get_secret(&self, key: String) -> Result<Option<String>, String> {
        Ok(self
            .secrets
            .find_one(doc! { "key": key }, None)
            .await
            .map_err(|err| err.to_string())?
            .map(|record| record.value))
    }

    pub async fn delete_secret(&self, key: String) -> Result<(), String> {
        self.secrets
            .delete_one(doc! { "key": key }, None)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn add_audit_log(
        &self,
        actor_user_id: Option<String>,
        action: String,
        target_type: String,
        target_id: String,
        metadata_json: String,
    ) -> Result<(), String> {
        self.audit_logs
            .insert_one(
                AuditRecord {
                    id: Uuid::new_v4().to_string(),
                    actor_user_id,
                    action,
                    target_type,
                    target_id,
                    metadata_json,
                    created_at: crate::nas::crypto::now_ts(),
                },
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub async fn list_audit_logs(&self) -> Result<Vec<AuditEntry>, String> {
        let mut cursor = self
            .audit_logs
            .find(doc! {}, None)
            .await
            .map_err(|err| err.to_string())?;
        let mut rows = Vec::new();
        while let Some(record) = cursor.try_next().await.map_err(|err| err.to_string())? {
            rows.push(AuditEntry {
                id: record.id,
                actor_user_id: record.actor_user_id,
                action: record.action,
                target_type: record.target_type,
                target_id: record.target_id,
                metadata_json: record.metadata_json,
                created_at: record.created_at,
            });
        }
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        rows.truncate(200);
        Ok(rows)
    }
}

impl From<UserRecord> for AppUser {
    fn from(user: UserRecord) -> Self {
        Self {
            id: user.id,
            username: user.username,
            display_name: user.display_name,
            telegram_username: user.telegram_username,
            google_id: user.google_id,
            email: user.email,
            avatar: user.avatar,
            role: user.role,
            disabled: user.disabled,
            approval_status: user.approval_status,
            is_approved: user.is_approved,
            created_at: user.created_at,
        }
    }
}

impl From<FolderRecord> for FolderRecordView {
    fn from(folder: FolderRecord) -> Self {
        Self {
            folder_id: folder.telegram_folder_id,
            name: folder.name,
            icon: folder.icon,
            owner_id: folder.owner_id,
            owner_name: folder.owner_name,
            is_password_protected: folder.is_password_protected,
            parent_folder_id: folder.parent_folder_id,
            created_at: folder.created_at.timestamp_millis(),
            updated_at: folder.updated_at.timestamp_millis(),
        }
    }
}

fn folder_owner_name(owner: &AppUser) -> String {
    owner
        .email
        .clone()
        .filter(|email| !email.trim().is_empty())
        .unwrap_or_else(|| owner.display_name.clone())
}
