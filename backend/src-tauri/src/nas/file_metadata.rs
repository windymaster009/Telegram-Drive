use std::collections::HashMap;
use std::sync::OnceLock;

use actix_web::{
    delete,
    error::ErrorBadGateway,
    get,
    http::{header, Method, StatusCode},
    post, put, route, web, HttpRequest, HttpResponse, Responder,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration as TokioDuration};

use crate::commands::fs::get_files_inner;
use crate::models::FileMetadata;
use crate::server::StreamTokenData;

use super::crypto::{decrypt_secret, encrypt_secret, generate_token, now_ts, sha256_hex};
use super::models::{AccessLevel, AppRole, AppUser};
use super::state::NasState;

static FILE_METADATA_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PUBLIC_SHARE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const PUBLIC_SHARE_LIST_TIMEOUT_SECONDS: u64 = 45;
const DEFAULT_BACKEND_PORT: u16 = 14201;

fn metadata_lock() -> &'static Mutex<()> {
    FILE_METADATA_LOCK.get_or_init(|| Mutex::new(()))
}

fn public_share_lock() -> &'static Mutex<()> {
    PUBLIC_SHARE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadataOverride {
    pub display_name: Option<String>,
    pub display_date: Option<String>,
    pub updated_at: i64,
    pub updated_by: String,
}

#[derive(Debug, Deserialize)]
struct FileMetadataQuery {
    folder_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct FileMetadataPatchRequest {
    display_name: Option<String>,
    display_date: Option<String>,
}

type FolderMetadataMap = HashMap<String, FileMetadataOverride>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PublicShareKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublicShareRecord {
    token_hash: String,
    kind: PublicShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: String,
    created_by: String,
    created_at: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublicSharePointer {
    token: String,
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreatePublicShareRequest {
    kind: PublicShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Debug, Serialize)]
struct CreatePublicShareResponse {
    token: String,
    kind: PublicShareKind,
    label: String,
    expires_at: Option<i64>,
}

#[derive(Debug, Serialize)]
struct PublicShareView {
    kind: PublicShareKind,
    label: String,
    expires_at: Option<i64>,
    file: Option<FileMetadata>,
    files: Vec<FileMetadata>,
}

#[derive(Debug, Deserialize)]
struct PublicShareMediaQuery {
    download: Option<bool>,
}

pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(list_file_metadata)
        .service(update_file_metadata)
        .service(create_public_share)
        .service(revoke_public_share)
        .service(get_public_share)
        .service(public_share_media);
}

#[get("/api/telegram/file-metadata")]
async fn list_file_metadata(
    state: web::Data<NasState>,
    req: HttpRequest,
    query: web::Query<FileMetadataQuery>,
) -> impl Responder {
    let user = match authorize_metadata_request(&state, &req, false).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    match can_read_folder(&state, &user, query.folder_id).await {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::Forbidden()
                .json(json!({ "error": "You do not have access to this folder" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    }

    match load_folder_metadata(&state, query.folder_id).await {
        Ok(metadata) => HttpResponse::Ok().json(metadata),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[put("/api/telegram/files/{message_id}/metadata")]
async fn update_file_metadata(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FileMetadataQuery>,
    payload: web::Json<FileMetadataPatchRequest>,
) -> impl Responder {
    let user = match authorize_metadata_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    match can_write_folder(&state, &user, query.folder_id).await {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::Forbidden()
                .json(json!({ "error": "This folder is read-only" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    }

    let display_name = normalize_text(payload.display_name.clone());
    if display_name
        .as_ref()
        .map(|value| value.chars().count() > 240)
        .unwrap_or(false)
    {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Display name must be 240 characters or fewer" }));
    }

    let display_date = normalize_text(payload.display_date.clone());
    if display_date
        .as_ref()
        .map(|value| value.len() > 64)
        .unwrap_or(false)
    {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Display date is too long" }));
    }

    let message_id = path.into_inner();
    let _guard = metadata_lock().lock().await;
    let mut metadata = match load_folder_metadata(&state, query.folder_id).await {
        Ok(metadata) => metadata,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let key = message_id.to_string();
    let next_override = if display_name.is_none() && display_date.is_none() {
        metadata.remove(&key);
        None
    } else {
        let next = FileMetadataOverride {
            display_name,
            display_date,
            updated_at: now_ts(),
            updated_by: user.id.clone(),
        };
        metadata.insert(key.clone(), next.clone());
        Some(next)
    };

    let secret_key = folder_metadata_key(query.folder_id);
    let save_result = if metadata.is_empty() {
        state.db.delete_secret(secret_key).await
    } else {
        match serde_json::to_string(&metadata) {
            Ok(serialized) => state.db.store_secret(secret_key, serialized).await,
            Err(err) => Err(err.to_string()),
        }
    };

    if let Err(err) = save_result {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            if next_override.is_some() {
                "update_file_metadata".to_string()
            } else {
                "reset_file_metadata".to_string()
            },
            "telegram_file".to_string(),
            format!("{}:{}", folder_key(query.folder_id), message_id),
            json!({
                "folder_id": query.folder_id,
                "message_id": message_id,
                "display_name": next_override.as_ref().and_then(|value| value.display_name.clone()),
                "display_date": next_override.as_ref().and_then(|value| value.display_date.clone()),
            })
            .to_string(),
        )
        .await;

    HttpResponse::Ok().json(json!({
        "ok": true,
        "metadata": next_override,
    }))
}

#[post("/api/shares")]
async fn create_public_share(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<CreatePublicShareRequest>,
) -> impl Responder {
    let user = match authorize_metadata_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    if let Some(expires_at) = payload.expires_at {
        if expires_at <= now_ts() {
            return HttpResponse::BadRequest()
                .json(json!({ "error": "Share expiration must be in the future" }));
        }
    }

    if payload.kind == PublicShareKind::Folder && payload.folder_id.is_none() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "A folder share requires a folder ID" }));
    }
    if payload.kind == PublicShareKind::File && payload.message_id.is_none() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "A file share requires a message ID" }));
    }

    match can_write_folder(&state, &user, payload.folder_id).await {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::Forbidden().json(json!({
                "error": "Only an admin, folder owner, or read-write user can create a public share"
            }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    }

    let mut label = normalize_text(payload.label.clone()).unwrap_or_else(|| "Shared item".to_string());
    if label.chars().count() > 240 {
        label = label.chars().take(240).collect();
    }

    if payload.kind == PublicShareKind::Folder {
        if let Some(folder_id) = payload.folder_id {
            if let Ok(Some(folder)) = state
                .db
                .get_folder_by_telegram_id(folder_id.to_string())
                .await
            {
                label = folder.name;
            }
        }
    } else {
        match shared_files(&state, payload.folder_id).await {
            Ok(files) => {
                let Some(message_id) = payload.message_id else {
                    return HttpResponse::BadRequest().json(json!({ "error": "Missing message ID" }));
                };
                let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
                    return HttpResponse::NotFound().json(json!({ "error": "File was not found" }));
                };
                label = file.name;
            }
            Err(response) => return response,
        }
    }

    let _guard = public_share_lock().lock().await;
    let target_key = public_share_target_key(&payload.kind, payload.folder_id, payload.message_id);

    if let Ok(Some(pointer)) = load_share_pointer(&state, &target_key).await {
        if share_expiry_active(pointer.expires_at) {
            if let Ok(Some(mut existing)) = load_public_share_record(&state, &pointer.token).await {
                existing.expires_at = payload.expires_at;
                existing.label = label.clone();
                if let Err(err) = store_public_share_record(&state, &pointer.token, &existing).await {
                    return HttpResponse::InternalServerError().json(json!({ "error": err }));
                }
                let next_pointer = PublicSharePointer {
                    token: pointer.token.clone(),
                    expires_at: payload.expires_at,
                };
                if let Err(err) = store_share_pointer(&state, &target_key, &next_pointer).await {
                    return HttpResponse::InternalServerError().json(json!({ "error": err }));
                }
                return HttpResponse::Ok().json(CreatePublicShareResponse {
                    token: pointer.token,
                    kind: existing.kind,
                    label: existing.label,
                    expires_at: existing.expires_at,
                });
            }
        }
        let _ = state.db.delete_secret(target_key.clone()).await;
    }

    let token = generate_token();
    let record = PublicShareRecord {
        token_hash: sha256_hex(&token),
        kind: payload.kind,
        folder_id: payload.folder_id,
        message_id: payload.message_id,
        label: label.clone(),
        created_by: user.id.clone(),
        created_at: now_ts(),
        expires_at: payload.expires_at,
    };
    let pointer = PublicSharePointer {
        token: token.clone(),
        expires_at: payload.expires_at,
    };

    if let Err(err) = store_public_share_record(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = store_share_pointer(&state, &target_key, &pointer).await {
        let _ = state.db.delete_secret(public_share_secret_key(&token)).await;
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            "create_public_share".to_string(),
            match record.kind {
                PublicShareKind::File => "telegram_file".to_string(),
                PublicShareKind::Folder => "telegram_folder".to_string(),
            },
            public_share_target_id(&record),
            json!({
                "expires_at": record.expires_at,
                "label": record.label,
            })
            .to_string(),
        )
        .await;

    HttpResponse::Ok().json(CreatePublicShareResponse {
        token,
        kind: record.kind,
        label,
        expires_at: record.expires_at,
    })
}

#[delete("/api/shares/{token}")]
async fn revoke_public_share(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    let user = match authorize_metadata_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let token = path.into_inner();
    let Some(record) = (match load_public_share_record(&state, &token).await {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    }) else {
        return HttpResponse::NotFound().json(json!({ "error": "Share link was not found" }));
    };

    let can_revoke = user.role == AppRole::Admin
        || user.id == record.created_by
        || can_write_folder(&state, &user, record.folder_id)
            .await
            .unwrap_or(false);
    if !can_revoke {
        return HttpResponse::Forbidden().json(json!({ "error": "You cannot revoke this share" }));
    }

    let _guard = public_share_lock().lock().await;
    if let Err(err) = state.db.delete_secret(public_share_secret_key(&token)).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    let target_key = public_share_target_key(&record.kind, record.folder_id, record.message_id);
    let _ = state.db.delete_secret(target_key).await;

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            "revoke_public_share".to_string(),
            match record.kind {
                PublicShareKind::File => "telegram_file".to_string(),
                PublicShareKind::Folder => "telegram_folder".to_string(),
            },
            public_share_target_id(&record),
            "{}".to_string(),
        )
        .await;

    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[get("/api/public/shares/{token}")]
async fn get_public_share(
    state: web::Data<NasState>,
    path: web::Path<String>,
) -> impl Responder {
    let token = path.into_inner();
    let record = match load_public_share_record(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return HttpResponse::Gone().json(json!({ "error": "This share link is invalid, revoked, or expired" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let files = match shared_files(&state, record.folder_id).await {
        Ok(files) => files,
        Err(response) => return response,
    };

    match record.kind {
        PublicShareKind::File => {
            let Some(message_id) = record.message_id else {
                return HttpResponse::Gone().json(json!({ "error": "This share link is no longer valid" }));
            };
            let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
                return HttpResponse::NotFound().json(json!({ "error": "The shared file no longer exists" }));
            };
            HttpResponse::Ok()
                .insert_header(("Cache-Control", "private, no-store"))
                .insert_header(("X-Robots-Tag", "noindex, nofollow"))
                .json(PublicShareView {
                    kind: PublicShareKind::File,
                    label: record.label,
                    expires_at: record.expires_at,
                    file: Some(file),
                    files: Vec::new(),
                })
        }
        PublicShareKind::Folder => HttpResponse::Ok()
            .insert_header(("Cache-Control", "private, no-store"))
            .insert_header(("X-Robots-Tag", "noindex, nofollow"))
            .json(PublicShareView {
                kind: PublicShareKind::Folder,
                label: record.label,
                expires_at: record.expires_at,
                file: None,
                files,
            }),
    }
}

#[route(
    "/api/public/shares/{token}/media/{message_id}",
    method = "GET",
    method = "HEAD"
)]
async fn public_share_media(
    state: web::Data<NasState>,
    stream_token: web::Data<StreamTokenData>,
    req: HttpRequest,
    path: web::Path<(String, i64)>,
    query: web::Query<PublicShareMediaQuery>,
) -> impl Responder {
    let (token, message_id) = path.into_inner();
    let record = match load_public_share_record(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => return HttpResponse::Gone().body("This share link is invalid, revoked, or expired"),
        Err(err) => return HttpResponse::InternalServerError().body(err),
    };

    if record.kind == PublicShareKind::File && record.message_id != Some(message_id) {
        return HttpResponse::Forbidden().body("This file is not part of the share");
    }

    let files = match shared_files(&state, record.folder_id).await {
        Ok(files) => files,
        Err(response) => return response,
    };
    let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
        return HttpResponse::NotFound().body("Shared file not found");
    };

    let folder = record
        .folder_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "home".to_string());
    let port = std::env::var("TELEGRAM_DRIVE_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BACKEND_PORT);
    let internal_url = format!(
        "http://127.0.0.1:{}/api/telegram/stream/{}/{}?token={}",
        port, folder, message_id, stream_token.token
    );

    let client = reqwest::Client::new();
    let method = if req.method() == Method::HEAD {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    let mut upstream_request = client.request(method, internal_url);
    if let Some(range) = req
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        upstream_request = upstream_request.header(reqwest::header::RANGE, range);
    }

    let upstream = match upstream_request.send().await {
        Ok(response) => response,
        Err(err) => return HttpResponse::BadGateway().body(format!("Could not load shared media: {}", err)),
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = HttpResponse::build(status);
    for (downstream_name, upstream_name) in [
        (header::CONTENT_TYPE, reqwest::header::CONTENT_TYPE),
        (header::CONTENT_LENGTH, reqwest::header::CONTENT_LENGTH),
        (header::CONTENT_RANGE, reqwest::header::CONTENT_RANGE),
        (header::ACCEPT_RANGES, reqwest::header::ACCEPT_RANGES),
    ] {
        if let Some(value) = upstream
            .headers()
            .get(&upstream_name)
            .and_then(|value| value.to_str().ok())
        {
            response.insert_header((downstream_name, value));
        }
    }
    response
        .insert_header(("Cache-Control", "private, no-store"))
        .insert_header(("X-Robots-Tag", "noindex, nofollow"));

    if query.download.unwrap_or(false) {
        response.insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", safe_download_name(&file.name)),
        ));
    }

    if req.method() == Method::HEAD {
        return response.finish();
    }

    let body = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(|err| ErrorBadGateway(err.to_string())));
    response.streaming(body)
}

async fn authorize_metadata_request(
    state: &NasState,
    req: &HttpRequest,
    require_csrf: bool,
) -> Result<AppUser, HttpResponse> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HttpResponse::Unauthorized().json(json!({ "error": "Missing session token" })))?;

    let claims = state
        .decode_session_jwt(token)
        .map_err(|_| HttpResponse::Unauthorized().json(json!({ "error": "Invalid session" })))?;
    let session = state
        .db
        .get_session(claims.sid)
        .await
        .map_err(|err| HttpResponse::InternalServerError().json(json!({ "error": err })))?
        .ok_or_else(|| HttpResponse::Unauthorized().json(json!({ "error": "Session expired" })))?;

    if session.disabled || !session.is_approved || session.session.expires_at < now_ts() {
        return Err(HttpResponse::Forbidden().json(json!({ "error": "Account access is not active" })));
    }

    if require_csrf {
        let csrf = req
            .headers()
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if csrf.is_empty() || csrf != session.csrf_token {
            return Err(HttpResponse::Forbidden().json(json!({ "error": "Invalid CSRF token" })));
        }
    }

    state
        .db
        .get_user_by_id(session.session.user_id)
        .await
        .map_err(|err| HttpResponse::InternalServerError().json(json!({ "error": err })))?
        .ok_or_else(|| HttpResponse::Unauthorized().json(json!({ "error": "Unknown user" })))
}

async fn can_read_folder(
    state: &NasState,
    user: &AppUser,
    folder_id: Option<i64>,
) -> Result<bool, String> {
    if user.role == AppRole::Admin {
        return Ok(true);
    }

    let Some(folder_id) = folder_id else {
        return Ok(false);
    };
    let folder_id = folder_id.to_string();

    if state
        .db
        .get_folder_by_telegram_id(folder_id.clone())
        .await?
        .map(|folder| folder.owner_id == user.id)
        .unwrap_or(false)
    {
        return Ok(true);
    }

    Ok(state
        .db
        .get_permissions(user.id.clone())
        .await?
        .iter()
        .any(|permission| permission.folder_id == folder_id))
}

async fn can_write_folder(
    state: &NasState,
    user: &AppUser,
    folder_id: Option<i64>,
) -> Result<bool, String> {
    if user.role == AppRole::Admin {
        return Ok(true);
    }

    let Some(folder_id) = folder_id else {
        return Ok(false);
    };
    let folder_id = folder_id.to_string();

    if state
        .db
        .get_folder_by_telegram_id(folder_id.clone())
        .await?
        .map(|folder| folder.owner_id == user.id)
        .unwrap_or(false)
    {
        return Ok(true);
    }

    Ok(state
        .db
        .get_permissions(user.id.clone())
        .await?
        .iter()
        .any(|permission| {
            permission.folder_id == folder_id && permission.access_level == AccessLevel::ReadWrite
        }))
}

async fn load_folder_metadata(
    state: &NasState,
    folder_id: Option<i64>,
) -> Result<FolderMetadataMap, String> {
    let Some(serialized) = state.db.get_secret(folder_metadata_key(folder_id)).await? else {
        return Ok(HashMap::new());
    };

    match serde_json::from_str::<FolderMetadataMap>(&serialized) {
        Ok(metadata) => Ok(metadata),
        Err(err) => {
            log::warn!(
                "Could not parse file metadata overrides for folder {}: {}",
                folder_key(folder_id),
                err
            );
            Ok(HashMap::new())
        }
    }
}

async fn shared_files(state: &NasState, folder_id: Option<i64>) -> Result<Vec<FileMetadata>, HttpResponse> {
    let files = match timeout(
        TokioDuration::from_secs(PUBLIC_SHARE_LIST_TIMEOUT_SECONDS),
        get_files_inner(folder_id, state.telegram.as_ref()),
    )
    .await
    {
        Ok(Ok(files)) => files,
        Ok(Err(err)) => return Err(HttpResponse::BadGateway().json(json!({ "error": err }))),
        Err(_) => {
            return Err(HttpResponse::GatewayTimeout()
                .json(json!({ "error": "Timed out loading shared files from Telegram" })))
        }
    };

    let metadata = load_folder_metadata(state, folder_id).await.unwrap_or_default();
    Ok(files
        .into_iter()
        .map(|mut file| {
            if let Some(override_value) = metadata.get(&file.id.to_string()) {
                if let Some(name) = override_value.display_name.as_ref() {
                    file.name = name.clone();
                }
                if let Some(date) = override_value.display_date.as_ref() {
                    file.created_at = date.clone();
                }
            }
            file
        })
        .collect())
}

async fn store_public_share_record(
    state: &NasState,
    token: &str,
    record: &PublicShareRecord,
) -> Result<(), String> {
    let serialized = serde_json::to_string(record).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state
        .db
        .store_secret(public_share_secret_key(token), encrypted)
        .await
}

async fn load_public_share_record(
    state: &NasState,
    token: &str,
) -> Result<Option<PublicShareRecord>, String> {
    if token.trim().len() < 20 {
        return Ok(None);
    }
    let key = public_share_secret_key(token);
    let Some(encrypted) = state.db.get_secret(key.clone()).await? else {
        return Ok(None);
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let record: PublicShareRecord = match serde_json::from_str(&serialized) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if record.token_hash != sha256_hex(token) {
        return Ok(None);
    }
    if !share_expiry_active(record.expires_at) {
        let _ = state.db.delete_secret(key).await;
        return Ok(None);
    }
    Ok(Some(record))
}

async fn store_share_pointer(
    state: &NasState,
    key: &str,
    pointer: &PublicSharePointer,
) -> Result<(), String> {
    let serialized = serde_json::to_string(pointer).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state.db.store_secret(key.to_string(), encrypted).await
}

async fn load_share_pointer(
    state: &NasState,
    key: &str,
) -> Result<Option<PublicSharePointer>, String> {
    let Some(encrypted) = state.db.get_secret(key.to_string()).await? else {
        return Ok(None);
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(serde_json::from_str::<PublicSharePointer>(&serialized).ok())
}

fn public_share_secret_key(token: &str) -> String {
    format!("public_share:{}", sha256_hex(token))
}

fn public_share_target_key(
    kind: &PublicShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
) -> String {
    let folder = folder_key(folder_id);
    match kind {
        PublicShareKind::Folder => format!("public_share_target:folder:{}", folder),
        PublicShareKind::File => format!(
            "public_share_target:file:{}:{}",
            folder,
            message_id.unwrap_or_default()
        ),
    }
}

fn public_share_target_id(record: &PublicShareRecord) -> String {
    match record.kind {
        PublicShareKind::Folder => folder_key(record.folder_id),
        PublicShareKind::File => format!(
            "{}:{}",
            folder_key(record.folder_id),
            record.message_id.unwrap_or_default()
        ),
    }
}

fn share_expiry_active(expires_at: Option<i64>) -> bool {
    expires_at.map(|value| value > now_ts()).unwrap_or(true)
}

fn folder_metadata_key(folder_id: Option<i64>) -> String {
    format!("file_metadata:{}", folder_key(folder_id))
}

fn folder_key(folder_id: Option<i64>) -> String {
    folder_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "home".to_string())
}

fn normalize_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn safe_download_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|ch| {
            if ch.is_ascii() && !ch.is_control() && ch != '"' && ch != '\\' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}
