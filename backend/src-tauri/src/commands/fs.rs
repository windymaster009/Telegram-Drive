use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{map_error, resolve_peer, resolve_peer_ref};
use crate::models::{FileMetadata, FolderMetadata};
use crate::nas::crypto::hash_password;
use crate::nas::models::{AccessLevel, AppRole, AppUser, ApprovalStatus, FolderRecordView};
use crate::nas::state::NasState;
use crate::TelegramState;
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use grammers_tl_types as tl;
use tauri::{Emitter, State};

const TEXT_MESSAGE_PREVIEW_CHARS: usize = 32;
const TEXT_MESSAGES_FILE_ID: i32 = -1;
const TEXT_MESSAGES_FILE_NAME: &str = "Text messages.txt";
const MODIFY_FOLDER_PERMISSION_ERROR: &str = "You do not have permission to modify this folder.";

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{:02X}", byte).chars().collect(),
        })
        .collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPasswordUpdate {
    pub password: Option<String>,
    pub remove_password: Option<bool>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderActor {
    pub user_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub role: AppRole,
}

async fn user_from_access_token(
    nas_state: &NasState,
    access_token: Option<String>,
) -> Result<AppUser, String> {
    let token = access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Missing session token".to_string())?;
    let claims = nas_state
        .decode_session_jwt(&token)
        .map_err(|_| "Invalid session".to_string())?;
    let session = nas_state
        .db
        .get_session(claims.sid)
        .await?
        .ok_or_else(|| "Session expired".to_string())?;
    let user = nas_state
        .db
        .get_user_by_id(session.session.user_id)
        .await?
        .ok_or_else(|| "Unknown user".to_string())?;
    if session.disabled
        || session.session.expires_at < crate::nas::crypto::now_ts()
        || !session.is_approved
    {
        log::warn!("Using stale desktop session for local folder attribution");
    }
    Ok(user)
}

fn local_desktop_admin() -> AppUser {
    AppUser {
        id: "local-desktop-admin".to_string(),
        username: "local-desktop-admin".to_string(),
        display_name: "Local desktop admin".to_string(),
        telegram_username: None,
        google_id: None,
        email: None,
        avatar: None,
        role: AppRole::Admin,
        disabled: false,
        approval_status: ApprovalStatus::Approved,
        is_approved: true,
        created_at: crate::nas::crypto::now_ts(),
    }
}

fn actor_to_user(actor: FolderActor) -> AppUser {
    let username = actor
        .email
        .clone()
        .unwrap_or_else(|| actor.display_name.clone());
    AppUser {
        id: actor.user_id,
        username,
        display_name: actor.display_name,
        telegram_username: None,
        google_id: None,
        email: actor.email,
        avatar: None,
        role: actor.role,
        disabled: false,
        approval_status: ApprovalStatus::Approved,
        is_approved: true,
        created_at: crate::nas::crypto::now_ts(),
    }
}

async fn user_from_access_token_or_desktop_admin(
    nas_state: &NasState,
    access_token: Option<String>,
    actor: Option<FolderActor>,
) -> AppUser {
    match user_from_access_token(nas_state, access_token).await {
        Ok(user) => user,
        Err(err) => {
            if let Some(actor) = actor {
                return actor_to_user(actor);
            }
            log::warn!(
                "Using local desktop admin for folder management because NAS token was not usable: {}",
                err
            );
            local_desktop_admin()
        }
    }
}

fn can_manage_folder(user: &AppUser, folder: &FolderRecordView) -> bool {
    user.role == AppRole::Admin || folder.owner_id == user.id
}

async fn ensure_can_manage_folder(
    nas_state: &NasState,
    user: &AppUser,
    folder_id: i64,
) -> Result<Option<FolderRecordView>, String> {
    let folder = nas_state
        .db
        .get_folder_by_telegram_id(folder_id.to_string())
        .await?;
    match folder {
        Some(folder) if can_manage_folder(user, &folder) => Ok(Some(folder)),
        Some(_) => Err(MODIFY_FOLDER_PERMISSION_ERROR.to_string()),
        None if user.role == AppRole::Admin => Ok(None),
        None => Err(MODIFY_FOLDER_PERMISSION_ERROR.to_string()),
    }
}

async fn ensure_can_manage_optional_folder(
    nas_state: &NasState,
    user: &AppUser,
    folder_id: Option<i64>,
) -> Result<(), String> {
    match folder_id {
        Some(folder_id) => ensure_can_manage_folder(nas_state, user, folder_id)
            .await
            .map(|_| ()),
        None if user.role == AppRole::Admin => Ok(()),
        None => Err(MODIFY_FOLDER_PERMISSION_ERROR.to_string()),
    }
}

async fn ensure_can_write_optional_folder(
    nas_state: &NasState,
    user: &AppUser,
    folder_id: Option<i64>,
) -> Result<(), String> {
    match folder_id {
        Some(folder_id) => {
            if ensure_can_manage_folder(nas_state, user, folder_id)
                .await
                .is_ok()
            {
                return Ok(());
            }
            let permissions = nas_state.db.get_permissions(user.id.clone()).await?;
            let folder_id = folder_id.to_string();
            if permissions.iter().any(|permission| {
                permission.folder_id == folder_id
                    && permission.access_level == AccessLevel::ReadWrite
            }) {
                Ok(())
            } else {
                Err(MODIFY_FOLDER_PERMISSION_ERROR.to_string())
            }
        }
        None if user.role == AppRole::Admin => Ok(()),
        None => Err(MODIFY_FOLDER_PERMISSION_ERROR.to_string()),
    }
}

fn folder_response(
    id: i64,
    fallback_name: String,
    parent_id: Option<i64>,
    metadata: Option<FolderRecordView>,
    user: Option<&AppUser>,
) -> FolderMetadata {
    let can_manage = match (&metadata, user) {
        (Some(folder), Some(user)) => can_manage_folder(user, folder),
        (None, Some(user)) => user.role == AppRole::Admin,
        _ => false,
    };
    FolderMetadata {
        id,
        parent_id,
        name: metadata
            .as_ref()
            .map(|folder| folder.name.clone())
            .unwrap_or(fallback_name),
        icon: metadata.as_ref().and_then(|folder| folder.icon.clone()),
        owner_id: metadata.as_ref().map(|folder| folder.owner_id.clone()),
        owner_name: metadata
            .as_ref()
            .and_then(|folder| folder.owner_name.clone()),
        is_password_protected: metadata
            .as_ref()
            .map(|folder| folder.is_password_protected)
            .unwrap_or(false),
        can_manage,
        created_at: metadata.as_ref().map(|folder| folder.created_at),
        updated_at: metadata.as_ref().map(|folder| folder.updated_at),
    }
}

fn text_message_name(message_id: i32, text: &str) -> String {
    let mut preview = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Text message")
        .trim()
        .chars()
        .take(TEXT_MESSAGE_PREVIEW_CHARS)
        .collect::<String>();

    preview = preview
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if preview.is_empty() {
        preview = "Text message".to_string();
    }

    format!("{}-{}.txt", preview, message_id)
}

fn strip_upload_temp_prefix(name: &str) -> String {
    if name.len() <= 37 {
        return name.to_string();
    }

    let prefix = &name[..36];
    let separator = name.as_bytes()[36];
    let uuidish = prefix.chars().enumerate().all(|(idx, ch)| {
        if matches!(idx, 8 | 13 | 18 | 23) {
            ch == '-' || ch == '_'
        } else {
            ch.is_ascii_hexdigit()
        }
    });

    if uuidish && (separator == b'-' || separator == b'_') {
        name[37..].to_string()
    } else {
        name.to_string()
    }
}

struct TextMessageEntry {
    id: i32,
    date: String,
    text: String,
}

fn format_text_messages(entries: &[TextMessageEntry]) -> String {
    entries
        .iter()
        .rev()
        .map(|entry| {
            format!(
                "============================================================\nMESSAGE #{}\nDATE: {}\n============================================================\n{}",
                entry.id,
                entry.date,
                entry.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n\n")
}

#[tauri::command]
pub async fn cmd_create_folder(
    name: String,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<FolderMetadata, String> {
    create_folder_inner(name, access_token, actor, state.inner(), nas_state.inner()).await
}

pub async fn create_folder_inner(
    name: String,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<FolderMetadata, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, actor).await;
    let client_opt = { state.client.lock().await.clone() };

    // --- MOCK ---
    if client_opt.is_none() {
        let mock_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        log::info!("[MOCK] Created folder '{}' with ID {}", name, mock_id);
        let metadata = nas_state
            .db
            .upsert_folder_metadata(mock_id.to_string(), name.clone(), None, &user)
            .await?;
        return Ok(folder_response(
            mock_id,
            name,
            None,
            Some(metadata),
            Some(&user),
        ));
    }
    // -----------
    let client = client_opt.unwrap();
    log::info!("Creating Telegram Channel: {}", name);

    let result = client
        .invoke(&tl::functions::channels::CreateChannel {
            broadcast: true,
            megagroup: false,
            title: format!("{} [TD]", name),
            about: "Telegram Drive Storage Folder\n[telegram-drive-folder]".to_string(),
            geo_point: None,
            address: None,
            for_import: false,
            forum: false,
            ttl_period: None, // Initial creation TTL
        })
        .await
        .map_err(map_error)?;

    let (chat_id, access_hash) = match result {
        tl::enums::Updates::Updates(u) => {
            let chat = u.chats.first().ok_or("No chat in updates")?;
            match chat {
                tl::enums::Chat::Channel(c) => (c.id, c.access_hash.unwrap_or(0)),
                _ => return Err("Created chat is not a channel".to_string()),
            }
        }
        _ => return Err("Unexpected response (not Updates::Updates)".to_string()),
    };

    // Explicitly Disable TTL
    let _input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
        channel_id: chat_id,
        access_hash,
    });

    let _ = client
        .invoke(&tl::functions::messages::SetHistoryTtl {
            peer: tl::enums::InputPeer::Channel(tl::types::InputPeerChannel {
                channel_id: chat_id,
                access_hash,
            }),
            period: 0,
        })
        .await;

    let metadata = nas_state
        .db
        .upsert_folder_metadata(chat_id.to_string(), name.clone(), None, &user)
        .await?;
    Ok(folder_response(
        chat_id,
        name,
        None,
        Some(metadata),
        Some(&user),
    ))
}

#[tauri::command]
pub async fn cmd_delete_folder(
    folder_id: i64,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
    access_token: Option<String>,
    actor: Option<FolderActor>,
) -> Result<bool, String> {
    delete_folder_inner(
        folder_id,
        access_token,
        actor,
        state.inner(),
        nas_state.inner(),
    )
    .await
}

pub async fn delete_folder_inner(
    folder_id: i64,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<bool, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, actor).await;
    ensure_can_manage_folder(nas_state, &user, folder_id).await?;
    let client_opt = { state.client.lock().await.clone() };

    if client_opt.is_none() {
        log::info!("[MOCK] Deleted folder ID {}", folder_id);
        let _ = nas_state
            .db
            .delete_folder_metadata(folder_id.to_string())
            .await;
        return Ok(true);
    }
    let client = client_opt.unwrap();
    log::info!("Deleting folder/channel: {}", folder_id);

    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;

    let input_channel = match peer {
        Peer::Channel(c) => {
            let chan = &c.raw;
            tl::enums::InputChannel::Channel(tl::types::InputChannel {
                channel_id: chan.id,
                access_hash: chan.access_hash.ok_or("No access hash for channel")?,
            })
        }
        _ => return Err("Only channels (folders) can be deleted.".to_string()),
    };

    client
        .invoke(&tl::functions::channels::DeleteChannel {
            channel: input_channel,
        })
        .await
        .map_err(|e| format!("Failed to delete channel: {}", e))?;

    nas_state
        .db
        .delete_folder_metadata(folder_id.to_string())
        .await?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    folder_id: i64,
    name: String,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<FolderMetadata, String> {
    rename_folder_inner(
        folder_id,
        name,
        access_token,
        actor,
        state.inner(),
        nas_state.inner(),
    )
    .await
}

pub async fn rename_folder_inner(
    folder_id: i64,
    name: String,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<FolderMetadata, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, actor).await;
    let existing = ensure_can_manage_folder(nas_state, &user, folder_id).await?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name is required".to_string());
    }

    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
        if let Peer::Channel(c) = peer {
            let chan = &c.raw;
            let input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
                channel_id: chan.id,
                access_hash: chan.access_hash.ok_or("No access hash for channel")?,
            });
            client
                .invoke(&tl::functions::channels::EditTitle {
                    channel: input_channel,
                    title: format!("{} [TD]", trimmed),
                })
                .await
                .map_err(|e| format!("Failed to rename folder: {}", e))?;
        }
    }

    nas_state
        .db
        .rename_folder_metadata(folder_id.to_string(), trimmed.to_string())
        .await?;
    let metadata = nas_state
        .db
        .get_folder_by_telegram_id(folder_id.to_string())
        .await?
        .or(existing);
    Ok(folder_response(
        folder_id,
        trimmed.to_string(),
        None,
        metadata,
        Some(&user),
    ))
}

#[tauri::command]
pub async fn cmd_set_folder_icon(
    folder_id: i64,
    icon: Option<String>,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    nas_state: State<'_, NasState>,
) -> Result<FolderMetadata, String> {
    set_folder_icon_inner(folder_id, icon, access_token, actor, nas_state.inner()).await
}

pub async fn set_folder_icon_inner(
    folder_id: i64,
    icon: Option<String>,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    nas_state: &NasState,
) -> Result<FolderMetadata, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, actor).await;
    let existing = ensure_can_manage_folder(nas_state, &user, folder_id).await?;
    let normalized = icon
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    nas_state
        .db
        .set_folder_icon(folder_id.to_string(), normalized)
        .await?;
    let metadata = nas_state
        .db
        .get_folder_by_telegram_id(folder_id.to_string())
        .await?
        .or(existing);
    Ok(folder_response(
        folder_id,
        metadata
            .as_ref()
            .map(|folder| folder.name.clone())
            .unwrap_or_else(|| "Folder".to_string()),
        None,
        metadata,
        Some(&user),
    ))
}

#[tauri::command]
pub async fn cmd_set_folder_password(
    folder_id: i64,
    payload: FolderPasswordUpdate,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    nas_state: State<'_, NasState>,
) -> Result<bool, String> {
    set_folder_password_inner(folder_id, payload, access_token, actor, nas_state.inner()).await
}

pub async fn set_folder_password_inner(
    folder_id: i64,
    payload: FolderPasswordUpdate,
    access_token: Option<String>,
    actor: Option<FolderActor>,
    nas_state: &NasState,
) -> Result<bool, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, actor).await;
    ensure_can_manage_folder(nas_state, &user, folder_id).await?;

    let remove_password = payload.remove_password.unwrap_or(false);
    if remove_password {
        nas_state
            .db
            .set_folder_password_hash(folder_id.to_string(), None)
            .await?;
        return Ok(true);
    }

    let password = payload
        .password
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Password is required".to_string())?;
    let password_hash = hash_password(password)?;
    nas_state
        .db
        .set_folder_password_hash(folder_id.to_string(), Some(password_hash))
        .await?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_verify_folder_password(
    folder_id: i64,
    password: String,
    nas_state: State<'_, NasState>,
) -> Result<bool, String> {
    verify_folder_password_inner(folder_id, password, nas_state.inner()).await
}

pub async fn verify_folder_password_inner(
    folder_id: i64,
    password: String,
    nas_state: &NasState,
) -> Result<bool, String> {
    nas_state
        .db
        .verify_folder_password(folder_id.to_string(), password)
        .await
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    id: String,
    percent: u8,
}

#[tauri::command]
pub async fn cmd_upload_file(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    access_token: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    upload_file_inner(
        path,
        folder_id,
        transfer_id,
        access_token,
        Some(app_handle),
        state.inner(),
        nas_state.inner(),
        Some(bw_state.inner()),
    )
    .await
}

pub async fn upload_file_inner(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    access_token: Option<String>,
    app_handle: Option<tauri::AppHandle>,
    state: &TelegramState,
    nas_state: &NasState,
    bw_state: Option<&BandwidthManager>,
) -> Result<String, String> {
    if let Some(token) = access_token.filter(|value| !value.trim().is_empty()) {
        match user_from_access_token(nas_state, Some(token)).await {
            Ok(user) => {
                ensure_can_manage_optional_folder(nas_state, &user, folder_id).await?;
            }
            Err(err) => {
                log::warn!(
                    "Upload permission check skipped because NAS session was not usable: {}",
                    err
                );
            }
        }
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if let Some(bw_state) = bw_state {
        bw_state.can_transfer(size)?;
    }

    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Uploaded file {} to {:?}", path, folder_id);
        if let Some(bw_state) = bw_state {
            bw_state.add_up(size);
        }
        return Ok("Mock upload successful".to_string());
    }
    let client = client_opt.unwrap();

    // Emit start progress
    if !tid.is_empty() {
        if let Some(app_handle) = &app_handle {
            let _ = app_handle.emit(
                "upload-progress",
                ProgressPayload {
                    id: tid.clone(),
                    percent: 0,
                },
            );
        }
    }

    let path_clone = path.clone();
    let client_clone = client.clone();

    let uploaded_file =
        tauri::async_runtime::spawn(async move { client_clone.upload_file(&path_clone).await })
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .map_err(map_error)?;

    let message = InputMessage::new().text("").file(uploaded_file);

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;

    client
        .send_message(peer, message)
        .await
        .map_err(map_error)?;

    if let Some(bw_state) = bw_state {
        bw_state.add_up(size);
    }

    // Emit completion
    if !tid.is_empty() {
        if let Some(app_handle) = &app_handle {
            let _ = app_handle.emit(
                "upload-progress",
                ProgressPayload {
                    id: tid,
                    percent: 100,
                },
            );
        }
    }

    Ok("File uploaded successfully".to_string())
}

#[tauri::command]
pub async fn cmd_upload_file_to_api(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    api_base_url: String,
    access_token: Option<String>,
    csrf_token: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload.bin")
        .to_string();
    let tid = transfer_id.unwrap_or_default();
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "upload-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 1,
            },
        );
    }

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|err| format!("Could not open file for upload: {}", err))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "upload-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 35,
            },
        );
    }

    let mut url = format!("{}/api/telegram/upload", api_base_url.trim_end_matches('/'));
    let mut params = Vec::new();
    if let Some(folder_id) = folder_id {
        params.push(format!("folder_id={}", folder_id));
    }
    params.push(format!("file_name={}", url_encode(&file_name)));
    if !params.is_empty() {
        url.push('?');
        url.push_str(&params.join("&"));
    }

    let client = reqwest::Client::new();
    let mut request = client
        .post(url)
        .header("content-type", "application/octet-stream")
        .header("content-length", size.to_string())
        .body(reqwest::Body::wrap_stream(stream));
    if let Some(token) = access_token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if let Some(csrf_token) = csrf_token.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-csrf-token", csrf_token);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("Upload request failed: {}", err))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Upload failed: {} {}", status, body));
    }

    if !tid.is_empty() {
        let _ = app_handle.emit(
            "upload-progress",
            ProgressPayload {
                id: tid,
                percent: 100,
            },
        );
    }
    Ok("File uploaded successfully".to_string())
}

#[tauri::command]
pub async fn cmd_download_file_from_api(
    message_id: i32,
    save_path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    api_base_url: String,
    access_token: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let folder = folder_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "home".to_string());
    let mut url = format!(
        "{}/api/telegram/stream/{}/{}",
        api_base_url.trim_end_matches('/'),
        folder,
        message_id
    );
    if let Some(token) = access_token.filter(|value| !value.trim().is_empty()) {
        url.push_str("?access_token=");
        url.push_str(&url_encode(&token));
    }

    let tid = transfer_id.unwrap_or_default();
    let client = reqwest::Client::new();
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Download request failed: {}", err))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Download failed: {} {}", status, body));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&save_path)
        .await
        .map_err(|err| format!("Could not create download file: {}", err))?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Download chunk failed: {}", err))?
    {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|err| format!("Could not write download file: {}", err))?;
        downloaded += chunk.len() as u64;
        if !tid.is_empty() && total_size > 0 {
            let percent = ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8;
            if percent != last_percent {
                last_percent = percent;
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        id: tid.clone(),
                        percent,
                    },
                );
            }
        }
    }

    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid,
                percent: 100,
            },
        );
    }
    Ok("Download successful".to_string())
}

#[tauri::command]
pub async fn cmd_delete_file(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
    access_token: Option<String>,
) -> Result<bool, String> {
    delete_file_inner(
        message_id,
        folder_id,
        access_token,
        state.inner(),
        nas_state.inner(),
    )
    .await
}

pub async fn delete_file_inner(
    message_id: i32,
    folder_id: Option<i64>,
    access_token: Option<String>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<bool, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, None).await;
    ensure_can_manage_optional_folder(nas_state, &user, folder_id).await?;
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Deleted message {} from folder {:?}",
            message_id,
            folder_id
        );
        return Ok(true);
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;
    client
        .delete_messages(peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_download_file(
    message_id: i32,
    save_path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Downloaded message {} from {:?} to {}",
            message_id,
            folder_id,
            save_path
        );
        if let Err(e) = std::fs::write(&save_path, b"Mock Content") {
            return Err(e.to_string());
        }
        return Ok("Download successful".to_string());
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;

    if message_id == TEXT_MESSAGES_FILE_ID {
        let mut text_messages = Vec::new();
        let mut msgs = client.iter_messages(peer);
        while let Some(msg) = msgs.next().await.map_err(|e| e.to_string())? {
            if msg.media().is_none() {
                let text = msg.text().trim();
                if !text.is_empty() {
                    text_messages.push(TextMessageEntry {
                        id: msg.id(),
                        date: msg.date().to_string(),
                        text: text.to_string(),
                    });
                }
            }
        }

        if text_messages.is_empty() {
            return Err("No text messages found".to_string());
        }

        let content = format_text_messages(&text_messages);
        bw_state.can_transfer(content.len() as u64)?;
        std::fs::write(&save_path, content.as_bytes()).map_err(|e| e.to_string())?;
        bw_state.add_down(content.len() as u64);

        if !tid.is_empty() {
            let _ = app_handle.emit(
                "download-progress",
                ProgressPayload {
                    id: tid,
                    percent: 100,
                },
            );
        }

        return Ok("Download successful".to_string());
    }

    // Use get_messages_by_id for efficient message lookup (same as server.rs)
    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;

    let msg = messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;

    let text = msg.text().to_string();

    let media = match msg.media() {
        Some(media) => media,
        None if !text.trim().is_empty() => {
            bw_state.can_transfer(text.len() as u64)?;
            std::fs::write(&save_path, text.as_bytes()).map_err(|e| e.to_string())?;
            bw_state.add_down(text.len() as u64);

            if !tid.is_empty() {
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        id: tid,
                        percent: 100,
                    },
                );
            }

            return Ok("Download successful".to_string());
        }
        None => return Err("No media or text in message".to_string()),
    };

    let total_size = match &media {
        Media::Document(d) => d.size() as u64,
        Media::Photo(_) => 1024 * 1024,
        _ => 0,
    };

    bw_state.can_transfer(total_size)?;

    // Emit start
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 0,
            },
        );
    }

    // Stream download with per-chunk progress
    let mut download_iter = client.iter_download(&media);
    let mut file = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;

    while let Some(chunk) = download_iter.next().await.transpose() {
        let bytes = chunk.map_err(|e| format!("Download chunk error: {}", e))?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;

        if !tid.is_empty() && total_size > 0 {
            let percent = ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8;
            // Only emit when percent actually changes to avoid event spam
            if percent != last_percent {
                last_percent = percent;
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        id: tid.clone(),
                        percent,
                    },
                );
            }
        }
    }

    bw_state.add_down(total_size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid,
                percent: 100,
            },
        );
    }

    Ok("Download successful".to_string())
}

#[tauri::command]
pub async fn cmd_move_files(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
    access_token: Option<String>,
) -> Result<bool, String> {
    move_files_inner(
        message_ids,
        source_folder_id,
        target_folder_id,
        access_token,
        state.inner(),
        nas_state.inner(),
    )
    .await
}

pub async fn move_files_inner(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    access_token: Option<String>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<bool, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, None).await;
    ensure_can_manage_optional_folder(nas_state, &user, source_folder_id).await?;
    ensure_can_manage_optional_folder(nas_state, &user, target_folder_id).await?;
    if source_folder_id == target_folder_id {
        return Ok(true);
    }
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Moved msgs {:?} from {:?} to {:?}",
            message_ids,
            source_folder_id,
            target_folder_id
        );
        return Ok(true);
    }
    let client = client_opt.unwrap();

    let source_peer = resolve_peer_ref(&client, source_folder_id, &state.peer_cache).await?;
    let target_peer = resolve_peer_ref(&client, target_folder_id, &state.peer_cache).await?;

    match client
        .forward_messages(target_peer, &message_ids, source_peer)
        .await
    {
        Ok(_) => {}
        Err(e) => return Err(format!("Forward failed: {}", e)),
    }

    let source_peer = resolve_peer_ref(&client, source_folder_id, &state.peer_cache).await?;
    match client.delete_messages(source_peer, &message_ids).await {
        Ok(_) => {}
        Err(e) => return Err(format!("Delete original failed: {}", e)),
    }

    Ok(true)
}

#[tauri::command]
pub async fn cmd_copy_files(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
    access_token: Option<String>,
) -> Result<bool, String> {
    copy_files_inner(
        message_ids,
        source_folder_id,
        target_folder_id,
        access_token,
        state.inner(),
        nas_state.inner(),
    )
    .await
}

pub async fn copy_files_inner(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    access_token: Option<String>,
    state: &TelegramState,
    nas_state: &NasState,
) -> Result<bool, String> {
    let user = user_from_access_token_or_desktop_admin(nas_state, access_token, None).await;
    ensure_can_write_optional_folder(nas_state, &user, target_folder_id).await?;
    if source_folder_id == target_folder_id {
        return Ok(true);
    }
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Copied msgs {:?} from {:?} to {:?}",
            message_ids,
            source_folder_id,
            target_folder_id
        );
        return Ok(true);
    }
    let client = client_opt.unwrap();

    let source_peer = resolve_peer_ref(&client, source_folder_id, &state.peer_cache).await?;
    let target_peer = resolve_peer_ref(&client, target_folder_id, &state.peer_cache).await?;

    match client
        .forward_messages(target_peer, &message_ids, source_peer)
        .await
    {
        Ok(_) => {}
        Err(e) => return Err(format!("Copy failed: {}", e)),
    }

    Ok(true)
}

#[tauri::command]
pub async fn cmd_get_files(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    get_files_inner(folder_id, state.inner()).await
}

pub async fn get_files_inner(
    folder_id: Option<i64>,
    state: &TelegramState,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Returning mock files for folder {:?}", folder_id);
        return Ok(Vec::new()); // No mock files for now
    }
    let client = client_opt.unwrap();
    let mut files = Vec::new();

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;

    let mut msgs = client.iter_messages(peer);
    let mut text_messages = Vec::new();
    while let Some(msg) = msgs.next().await.map_err(|e| e.to_string())? {
        if let Some(doc) = msg.media() {
            let (name, size, mime, ext) = match doc {
                Media::Document(d) => {
                    let n = strip_upload_temp_prefix(&d.name().to_string());
                    let s = d.size();
                    let m = d.mime_type().map(|s| s.to_string());
                    let e = std::path::Path::new(&n)
                        .extension()
                        .map(|os| os.to_str().unwrap_or("").to_string());
                    (n, s, m, e)
                }
                Media::Photo(_) => (
                    "Photo.jpg".to_string(),
                    0,
                    Some("image/jpeg".into()),
                    Some("jpg".into()),
                ),
                _ => ("Unknown".to_string(), 0, None, None),
            };
            files.push(FileMetadata {
                id: msg.id() as i64,
                folder_id,
                name,
                size: size as u64,
                mime_type: mime,
                file_ext: ext,
                created_at: msg.date().to_string(),
                icon_type: "file".into(),
                text_content: None,
            });
        } else {
            let text = msg.text().trim();
            if !text.is_empty() {
                text_messages.push(TextMessageEntry {
                    id: msg.id(),
                    date: msg.date().to_string(),
                    text: text.to_string(),
                });
            }
        }
    }

    if !text_messages.is_empty() {
        let content = format_text_messages(&text_messages);
        let created_at = text_messages
            .first()
            .map(|entry| entry.date.clone())
            .unwrap_or_default();

        files.push(FileMetadata {
            id: TEXT_MESSAGES_FILE_ID as i64,
            folder_id,
            name: TEXT_MESSAGES_FILE_NAME.to_string(),
            size: content.len() as u64,
            mime_type: Some("text/plain".into()),
            file_ext: Some("txt".into()),
            created_at,
            icon_type: "file".into(),
            text_content: Some(content),
        });
    }

    Ok(files)
}

#[tauri::command]
pub async fn cmd_search_global(
    query: String,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    search_global_inner(query, state.inner()).await
}

pub async fn search_global_inner(
    query: String,
    state: &TelegramState,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();
    let mut files = Vec::new();

    log::info!("Searching global for: {}", query);

    let result = client
        .invoke(&tl::functions::messages::SearchGlobal {
            q: query,
            filter: tl::enums::MessagesFilter::InputMessagesFilterDocument,
            min_date: 0,
            max_date: 0,
            offset_rate: 0,
            offset_peer: tl::enums::InputPeer::Empty,
            offset_id: 0,
            limit: 50,
            folder_id: None,
            broadcasts_only: false,
            groups_only: false,
            users_only: false,
        })
        .await
        .map_err(map_error)?;

    if let tl::enums::messages::Messages::Messages(msgs) = result {
        for msg in msgs.messages {
            if let tl::enums::Message::Message(m) = msg {
                if let Some(tl::enums::MessageMedia::Document(d)) = m.media {
                    if let tl::enums::Document::Document(doc) = d.document.unwrap() {
                        let name = doc
                            .attributes
                            .iter()
                            .find_map(|a| match a {
                                tl::enums::DocumentAttribute::Filename(f) => {
                                    Some(f.file_name.clone())
                                }
                                _ => None,
                            })
                            .unwrap_or("Unknown".to_string());
                        let name = strip_upload_temp_prefix(&name);
                        let size = doc.size as u64;
                        let mime = doc.mime_type.clone();
                        let ext = std::path::Path::new(&name)
                            .extension()
                            .map(|os| os.to_str().unwrap_or("").to_string());
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64,
                            folder_id,
                            name,
                            size,
                            mime_type: Some(mime),
                            file_ext: ext,
                            created_at: m.date.to_string(),
                            icon_type: "file".into(),
                            text_content: None,
                        });
                    }
                } else if !m.message.trim().is_empty() {
                    let folder_id = match m.peer_id {
                        tl::enums::Peer::Channel(c) => Some(c.channel_id),
                        tl::enums::Peer::User(u) => Some(u.user_id),
                        tl::enums::Peer::Chat(c) => Some(c.chat_id),
                    };
                    files.push(FileMetadata {
                        id: m.id as i64,
                        folder_id,
                        name: text_message_name(m.id, &m.message),
                        size: m.message.len() as u64,
                        mime_type: Some("text/plain".into()),
                        file_ext: Some("txt".into()),
                        created_at: m.date.to_string(),
                        icon_type: "file".into(),
                        text_content: Some(m.message),
                    });
                }
            }
        }
    } else if let tl::enums::messages::Messages::Slice(msgs) = result {
        for msg in msgs.messages {
            if let tl::enums::Message::Message(m) = msg {
                if let Some(tl::enums::MessageMedia::Document(d)) = m.media {
                    if let tl::enums::Document::Document(doc) = d.document.unwrap() {
                        let name = doc
                            .attributes
                            .iter()
                            .find_map(|a| match a {
                                tl::enums::DocumentAttribute::Filename(f) => {
                                    Some(f.file_name.clone())
                                }
                                _ => None,
                            })
                            .unwrap_or("Unknown".to_string());
                        let name = strip_upload_temp_prefix(&name);
                        let size = doc.size as u64;
                        let mime = doc.mime_type.clone();
                        let ext = std::path::Path::new(&name)
                            .extension()
                            .map(|os| os.to_str().unwrap_or("").to_string());
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64,
                            folder_id,
                            name,
                            size,
                            mime_type: Some(mime),
                            file_ext: ext,
                            created_at: m.date.to_string(),
                            icon_type: "file".into(),
                            text_content: None,
                        });
                    }
                } else if !m.message.trim().is_empty() {
                    let folder_id = match m.peer_id {
                        tl::enums::Peer::Channel(c) => Some(c.channel_id),
                        tl::enums::Peer::User(u) => Some(u.user_id),
                        tl::enums::Peer::Chat(c) => Some(c.chat_id),
                    };
                    files.push(FileMetadata {
                        id: m.id as i64,
                        folder_id,
                        name: text_message_name(m.id, &m.message),
                        size: m.message.len() as u64,
                        mime_type: Some("text/plain".into()),
                        file_ext: Some("txt".into()),
                        created_at: m.date.to_string(),
                        icon_type: "file".into(),
                        text_content: Some(m.message),
                    });
                }
            }
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn cmd_scan_folders(
    access_token: Option<String>,
    actor: Option<FolderActor>,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<Vec<FolderMetadata>, String> {
    let user = user_from_access_token_or_desktop_admin(&nas_state, access_token, actor).await;
    scan_folders_for_user(state.inner(), nas_state.inner(), user).await
}

pub async fn scan_folders_for_user(
    state: &TelegramState,
    nas_state: &NasState,
    user: AppUser,
) -> Result<Vec<FolderMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();

    let mut folders = Vec::new();
    let mut dialogs = client.iter_dialogs();

    log::info!("Starting Folder Scan...");

    // Acquire write lock once for the entire scan to populate the peer cache
    let mut peer_cache = state.peer_cache.write().await;

    while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
        // Populate peer cache for every dialog we encounter (free priming)
        match &dialog.peer {
            Peer::Channel(c) => {
                let id = c.raw.id;
                peer_cache.insert(id, dialog.peer.clone());

                let name = c.raw.title.clone();
                let access_hash = c.raw.access_hash.unwrap_or(0);

                log::debug!("[SCAN] Processing Channel: '{}' (ID: {})", name, id);

                // Strategy 1: Title
                if name.to_lowercase().contains("[td]") {
                    log::info!(" -> MATCH via Title: {}", name);
                    let display_name = name
                        .replace(" [TD]", "")
                        .replace(" [td]", "")
                        .replace("[TD]", "")
                        .replace("[td]", "")
                        .trim()
                        .to_string();
                    let metadata = nas_state
                        .db
                        .upsert_folder_metadata(id.to_string(), display_name.clone(), None, &user)
                        .await?;
                    folders.push(folder_response(
                        id,
                        display_name,
                        None,
                        Some(metadata),
                        Some(&user),
                    ));
                    continue;
                }

                // Strategy 2: About
                let input_chan = tl::enums::InputChannel::Channel(tl::types::InputChannel {
                    channel_id: c.raw.id,
                    access_hash,
                });

                match client
                    .invoke(&tl::functions::channels::GetFullChannel {
                        channel: input_chan,
                    })
                    .await
                {
                    Ok(tl::enums::messages::ChatFull::Full(f)) => {
                        if let tl::enums::ChatFull::Full(cf) = f.full_chat {
                            if cf.about.contains("[telegram-drive-folder]") {
                                log::info!(" -> MATCH via About: {}", name);
                                let metadata = nas_state
                                    .db
                                    .upsert_folder_metadata(
                                        id.to_string(),
                                        name.clone(),
                                        None,
                                        &user,
                                    )
                                    .await?;
                                folders.push(folder_response(
                                    id,
                                    name.clone(),
                                    None,
                                    Some(metadata),
                                    Some(&user),
                                ));
                            }
                        }
                    }
                    Err(e) => log::warn!(" -> Failed to get full info: {}", e),
                }
            }
            Peer::User(u) => {
                peer_cache.insert(u.raw.id(), dialog.peer.clone());
                log::debug!("[SCAN] Cached User Peer: {}", u.raw.id());
            }
            peer => {
                log::debug!("[SCAN] Skipped Peer: {:?}", peer);
            }
        }
    }

    log::info!(
        "Scan complete. Found {} folders. Peer cache size: {}.",
        folders.len(),
        peer_cache.len()
    );
    Ok(folders)
}
