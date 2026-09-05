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

use super::crypto::{
    decrypt_secret, encrypt_secret, generate_token, hash_password, now_ts, sha256_hex,
    verify_password,
};
use super::models::{AccessLevel, AppRole, AppUser};
use super::state::NasState;

static SHARE_LINK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const SHARE_CATALOG_KEY: &str = "public_share_catalog_v2";
const SHARE_LIST_TIMEOUT_SECONDS: u64 = 45;
const ACCESS_GRANT_TTL_SECONDS: i64 = 12 * 60 * 60;
const DEFAULT_BACKEND_PORT: u16 = 14201;

fn share_link_lock() -> &'static Mutex<()> {
    SHARE_LINK_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ShareKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManagedShareRecord {
    token_hash: String,
    kind: ShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: String,
    created_by: String,
    created_at: i64,
    expires_at: Option<i64>,
    #[serde(default)]
    password_hash: Option<String>,
    #[serde(default)]
    revoked_at: Option<i64>,
    #[serde(default)]
    views: u64,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    last_accessed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SharePointer {
    token: String,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareCatalogEntry {
    token: String,
    kind: ShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: String,
    created_by: String,
    created_at: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
    views: u64,
    downloads: u64,
    last_accessed_at: Option<i64>,
    has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareAccessGrant {
    share_token_hash: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct CreateShareRequest {
    kind: ShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: Option<String>,
    expires_at: Option<i64>,
    password: Option<String>,
    #[serde(default)]
    remove_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct UpdateShareRequest {
    expires_at: Option<i64>,
    password: Option<String>,
    #[serde(default)]
    remove_password: bool,
}

#[derive(Debug, Serialize)]
struct ShareCreateResponse {
    token: String,
    kind: ShareKind,
    label: String,
    expires_at: Option<i64>,
    has_password: bool,
}

#[derive(Debug, Serialize)]
struct ShareAdminView {
    token: String,
    kind: ShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    label: String,
    created_by: String,
    created_by_name: Option<String>,
    created_at: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
    status: String,
    views: u64,
    downloads: u64,
    last_accessed_at: Option<i64>,
    has_password: bool,
}

#[derive(Debug, Serialize)]
struct PublicShareView {
    kind: ShareKind,
    label: String,
    expires_at: Option<i64>,
    file: Option<FileMetadata>,
    files: Vec<FileMetadata>,
}

#[derive(Debug, Deserialize)]
struct PublicAccessQuery {
    access_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PublicMediaQuery {
    access_key: Option<String>,
    download: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UnlockShareRequest {
    password: String,
}

#[derive(Debug, Serialize)]
struct UnlockShareResponse {
    access_key: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileMetadataOverride {
    display_name: Option<String>,
    display_date: Option<String>,
    updated_at: i64,
    updated_by: String,
}

type FolderMetadataMap = HashMap<String, FileMetadataOverride>;

pub fn configure_api(cfg: &mut web::ServiceConfig) {
    super::legacy_file_metadata::configure_api(cfg);
    cfg.service(create_share_link)
        .service(list_share_links)
        .service(update_share_link)
        .service(revoke_share_link)
        .service(get_public_share_link)
        .service(unlock_public_share_link)
        .service(public_share_link_media);
}

#[post("/api/share-links")]
async fn create_share_link(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<CreateShareRequest>,
) -> impl Responder {
    let user = match authorize_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    if let Some(expires_at) = payload.expires_at {
        if expires_at <= now_ts() {
            return HttpResponse::BadRequest()
                .json(json!({ "error": "Share expiration must be in the future" }));
        }
    }
    if payload.kind == ShareKind::Folder && payload.folder_id.is_none() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "A folder share requires a folder ID" }));
    }
    if payload.kind == ShareKind::File && payload.message_id.is_none() {
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

    let label = match resolve_share_label(
        &state,
        payload.kind,
        payload.folder_id,
        payload.message_id,
        payload.label.clone(),
    )
    .await
    {
        Ok(label) => label,
        Err(response) => return response,
    };

    let password = normalize_text(payload.password.clone());
    let _guard = share_link_lock().lock().await;
    let target_key = share_target_key(&payload.kind, payload.folder_id, payload.message_id);

    if let Ok(Some(pointer)) = load_pointer(&state, &target_key).await {
        if let Ok(Some(mut existing)) = load_share_record_raw(&state, &pointer.token).await {
            if record_is_active(&existing) {
                existing.expires_at = payload.expires_at;
                existing.label = label.clone();
                if payload.remove_password {
                    existing.password_hash = None;
                } else if let Some(password) = password.as_ref() {
                    match hash_password(password) {
                        Ok(hash) => existing.password_hash = Some(hash),
                        Err(err) => {
                            return HttpResponse::InternalServerError()
                                .json(json!({ "error": err }))
                        }
                    }
                }
                if let Err(err) = store_share_record(&state, &pointer.token, &existing).await {
                    return HttpResponse::InternalServerError().json(json!({ "error": err }));
                }
                let next_pointer = SharePointer {
                    token: pointer.token.clone(),
                    expires_at: existing.expires_at,
                };
                if let Err(err) = store_pointer(&state, &target_key, &next_pointer).await {
                    return HttpResponse::InternalServerError().json(json!({ "error": err }));
                }
                if let Err(err) = upsert_catalog_locked(&state, &pointer.token, &existing).await {
                    return HttpResponse::InternalServerError().json(json!({ "error": err }));
                }
                return HttpResponse::Ok().json(share_create_response(pointer.token, existing));
            }
        }
        let _ = state.db.delete_secret(target_key.clone()).await;
    }

    let token = generate_token();
    let password_hash = if let Some(password) = password {
        match hash_password(&password) {
            Ok(hash) => Some(hash),
            Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        }
    } else {
        None
    };
    let record = ManagedShareRecord {
        token_hash: sha256_hex(&token),
        kind: payload.kind,
        folder_id: payload.folder_id,
        message_id: payload.message_id,
        label: label.clone(),
        created_by: user.id.clone(),
        created_at: now_ts(),
        expires_at: payload.expires_at,
        password_hash,
        revoked_at: None,
        views: 0,
        downloads: 0,
        last_accessed_at: None,
    };
    let pointer = SharePointer {
        token: token.clone(),
        expires_at: record.expires_at,
    };

    if let Err(err) = store_share_record(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = store_pointer(&state, &target_key, &pointer).await {
        let _ = state.db.delete_secret(share_secret_key(&token)).await;
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = upsert_catalog_locked(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            "create_public_share".to_string(),
            share_target_type(record.kind).to_string(),
            share_target_id(&record),
            json!({
                "expires_at": record.expires_at,
                "label": record.label,
                "password_protected": record.password_hash.is_some(),
            })
            .to_string(),
        )
        .await;

    HttpResponse::Ok().json(share_create_response(token, record))
}

#[get("/api/share-links")]
async fn list_share_links(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    let user = match authorize_request(&state, &req, false).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if user.role != AppRole::Admin {
        return HttpResponse::Forbidden().json(json!({ "error": "Admin access required" }));
    }

    let catalog = match load_catalog(&state).await {
        Ok(entries) => entries,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let mut rows = Vec::with_capacity(catalog.len());
    for entry in catalog {
        let creator = state
            .db
            .get_user_by_id(entry.created_by.clone())
            .await
            .ok()
            .flatten();
        rows.push(ShareAdminView {
            token: entry.token,
            kind: entry.kind,
            folder_id: entry.folder_id,
            message_id: entry.message_id,
            label: entry.label,
            created_by: entry.created_by,
            created_by_name: creator.map(|user| user.display_name),
            created_at: entry.created_at,
            expires_at: entry.expires_at,
            revoked_at: entry.revoked_at,
            status: share_status(entry.revoked_at, entry.expires_at).to_string(),
            views: entry.views,
            downloads: entry.downloads,
            last_accessed_at: entry.last_accessed_at,
            has_password: entry.has_password,
        });
    }
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    HttpResponse::Ok().json(rows)
}

#[put("/api/share-links/{token}")]
async fn update_share_link(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<UpdateShareRequest>,
) -> impl Responder {
    let user = match authorize_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Some(expires_at) = payload.expires_at {
        if expires_at <= now_ts() {
            return HttpResponse::BadRequest()
                .json(json!({ "error": "Share expiration must be in the future" }));
        }
    }

    let token = path.into_inner();
    let _guard = share_link_lock().lock().await;
    let mut record = match load_share_record_raw(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "Share link not found" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    if record.revoked_at.is_some() {
        return HttpResponse::Conflict().json(json!({ "error": "Revoked links cannot be reactivated" }));
    }
    if !can_manage_share(&state, &user, &record).await {
        return HttpResponse::Forbidden().json(json!({ "error": "You cannot manage this share" }));
    }

    let target_key = share_target_key(&record.kind, record.folder_id, record.message_id);
    if let Ok(Some(pointer)) = load_pointer(&state, &target_key).await {
        if pointer.token != token {
            if let Ok(Some(other)) = load_share_record_raw(&state, &pointer.token).await {
                if record_is_active(&other) {
                    return HttpResponse::Conflict().json(json!({
                        "error": "A newer active share exists for this item. Revoke it before reactivating this link."
                    }));
                }
            }
        }
    }

    record.expires_at = payload.expires_at;
    if payload.remove_password {
        record.password_hash = None;
    } else if let Some(password) = normalize_text(payload.password.clone()) {
        match hash_password(&password) {
            Ok(hash) => record.password_hash = Some(hash),
            Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        }
    }

    if let Err(err) = store_share_record(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    let pointer = SharePointer {
        token: token.clone(),
        expires_at: record.expires_at,
    };
    if let Err(err) = store_pointer(&state, &target_key, &pointer).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = upsert_catalog_locked(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            "update_public_share".to_string(),
            share_target_type(record.kind).to_string(),
            share_target_id(&record),
            json!({
                "expires_at": record.expires_at,
                "password_protected": record.password_hash.is_some(),
            })
            .to_string(),
        )
        .await;

    HttpResponse::Ok().json(share_create_response(token, record))
}

#[delete("/api/share-links/{token}")]
async fn revoke_share_link(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    let user = match authorize_request(&state, &req, true).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let token = path.into_inner();
    let _guard = share_link_lock().lock().await;
    let mut record = match load_share_record_raw(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "Share link not found" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    if !can_manage_share(&state, &user, &record).await {
        return HttpResponse::Forbidden().json(json!({ "error": "You cannot revoke this share" }));
    }

    if record.revoked_at.is_none() {
        record.revoked_at = Some(now_ts());
        if let Err(err) = store_share_record(&state, &token, &record).await {
            return HttpResponse::InternalServerError().json(json!({ "error": err }));
        }
    }
    let target_key = share_target_key(&record.kind, record.folder_id, record.message_id);
    if let Ok(Some(pointer)) = load_pointer(&state, &target_key).await {
        if pointer.token == token {
            let _ = state.db.delete_secret(target_key).await;
        }
    }
    if let Err(err) = upsert_catalog_locked(&state, &token, &record).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    let _ = state
        .db
        .add_audit_log(
            Some(user.id),
            "revoke_public_share".to_string(),
            share_target_type(record.kind).to_string(),
            share_target_id(&record),
            "{}".to_string(),
        )
        .await;

    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[get("/api/public/share-links/{token}")]
async fn get_public_share_link(
    state: web::Data<NasState>,
    path: web::Path<String>,
    query: web::Query<PublicAccessQuery>,
) -> impl Responder {
    let token = path.into_inner();
    let record = match load_active_share_record(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return HttpResponse::Gone()
                .json(json!({ "error": "This share link is invalid, revoked, or expired" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if !share_access_allowed(&state, &record, query.access_key.as_deref()).await {
        return HttpResponse::Unauthorized().json(json!({
            "error": "Password required",
            "password_required": true,
            "expires_at": record.expires_at,
        }));
    }

    let files = match shared_files(&state, record.folder_id).await {
        Ok(files) => files,
        Err(response) => return response,
    };

    let response = match record.kind {
        ShareKind::File => {
            let Some(message_id) = record.message_id else {
                return HttpResponse::Gone().json(json!({ "error": "This share link is no longer valid" }));
            };
            let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
                return HttpResponse::NotFound().json(json!({ "error": "The shared file no longer exists" }));
            };
            PublicShareView {
                kind: ShareKind::File,
                label: record.label.clone(),
                expires_at: record.expires_at,
                file: Some(file),
                files: Vec::new(),
            }
        }
        ShareKind::Folder => PublicShareView {
            kind: ShareKind::Folder,
            label: record.label.clone(),
            expires_at: record.expires_at,
            file: None,
            files,
        },
    };

    let _ = record_share_event(&state, &token, ShareEvent::View).await;
    HttpResponse::Ok()
        .insert_header(("Cache-Control", "private, no-store"))
        .insert_header(("X-Robots-Tag", "noindex, nofollow"))
        .json(response)
}

#[post("/api/public/share-links/{token}/unlock")]
async fn unlock_public_share_link(
    state: web::Data<NasState>,
    path: web::Path<String>,
    payload: web::Json<UnlockShareRequest>,
) -> impl Responder {
    let token = path.into_inner();
    let record = match load_active_share_record(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return HttpResponse::Gone()
                .json(json!({ "error": "This share link is invalid, revoked, or expired" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let Some(password_hash) = record.password_hash.as_ref() else {
        return HttpResponse::BadRequest().json(json!({ "error": "This share does not require a password" }));
    };
    match verify_password(&payload.password, password_hash) {
        Ok(true) => {}
        Ok(false) => return HttpResponse::Unauthorized().json(json!({ "error": "Incorrect password" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    }

    let access_key = generate_token();
    let grant_expires_at = record
        .expires_at
        .map(|share_expiry| share_expiry.min(now_ts() + ACCESS_GRANT_TTL_SECONDS))
        .unwrap_or_else(|| now_ts() + ACCESS_GRANT_TTL_SECONDS);
    let grant = ShareAccessGrant {
        share_token_hash: record.token_hash,
        expires_at: grant_expires_at,
    };
    if let Err(err) = store_access_grant(&state, &access_key, &grant).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    HttpResponse::Ok()
        .insert_header(("Cache-Control", "private, no-store"))
        .json(UnlockShareResponse {
            access_key,
            expires_at: grant_expires_at,
        })
}

#[route(
    "/api/public/share-links/{token}/media/{message_id}",
    method = "GET",
    method = "HEAD"
)]
async fn public_share_link_media(
    state: web::Data<NasState>,
    stream_token: web::Data<StreamTokenData>,
    req: HttpRequest,
    path: web::Path<(String, i64)>,
    query: web::Query<PublicMediaQuery>,
) -> impl Responder {
    let (token, message_id) = path.into_inner();
    let record = match load_active_share_record(&state, &token).await {
        Ok(Some(record)) => record,
        Ok(None) => return HttpResponse::Gone().body("This share link is invalid, revoked, or expired"),
        Err(err) => return HttpResponse::InternalServerError().body(err),
    };
    if !share_access_allowed(&state, &record, query.access_key.as_deref()).await {
        return HttpResponse::Unauthorized().body("Password required");
    }
    if record.kind == ShareKind::File && record.message_id != Some(message_id) {
        return HttpResponse::Forbidden().body("This file is not part of the share");
    }

    let mut download_name = record.label.clone();
    if query.download.unwrap_or(false) && record.kind == ShareKind::Folder {
        let files = match shared_files(&state, record.folder_id).await {
            Ok(files) => files,
            Err(response) => return response,
        };
        let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
            return HttpResponse::NotFound().body("Shared file not found");
        };
        download_name = file.name;
    }

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
        Err(err) => {
            return HttpResponse::BadGateway()
                .body(format!("Could not load shared media: {}", err))
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    if query.download.unwrap_or(false)
        && req.method() == Method::GET
        && status.is_success()
        && is_initial_download_request(&req)
    {
        let _ = record_share_event(&state, &token, ShareEvent::Download).await;
    }

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
            format!("attachment; filename=\"{}\"", safe_download_name(&download_name)),
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

#[derive(Clone, Copy)]
enum ShareEvent {
    View,
    Download,
}

async fn record_share_event(state: &NasState, token: &str, event: ShareEvent) -> Result<(), String> {
    let _guard = share_link_lock().lock().await;
    let Some(mut record) = load_share_record_raw(state, token).await? else {
        return Ok(());
    };
    record.last_accessed_at = Some(now_ts());
    match event {
        ShareEvent::View => record.views = record.views.saturating_add(1),
        ShareEvent::Download => record.downloads = record.downloads.saturating_add(1),
    }
    store_share_record(state, token, &record).await?;
    upsert_catalog_locked(state, token, &record).await
}

async fn resolve_share_label(
    state: &NasState,
    kind: ShareKind,
    folder_id: Option<i64>,
    message_id: Option<i64>,
    requested_label: Option<String>,
) -> Result<String, HttpResponse> {
    if kind == ShareKind::Folder {
        if let Some(folder_id) = folder_id {
            if let Ok(Some(folder)) = state
                .db
                .get_folder_by_telegram_id(folder_id.to_string())
                .await
            {
                return Ok(folder.name);
            }
        }
    } else {
        let files = shared_files(state, folder_id).await?;
        let Some(message_id) = message_id else {
            return Err(HttpResponse::BadRequest().json(json!({ "error": "Missing message ID" })));
        };
        let Some(file) = files.into_iter().find(|file| file.id == message_id) else {
            return Err(HttpResponse::NotFound().json(json!({ "error": "File was not found" })));
        };
        return Ok(file.name);
    }

    let mut label = normalize_text(requested_label).unwrap_or_else(|| "Shared item".to_string());
    if label.chars().count() > 240 {
        label = label.chars().take(240).collect();
    }
    Ok(label)
}

async fn authorize_request(
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

async fn can_write_folder(state: &NasState, user: &AppUser, folder_id: Option<i64>) -> Result<bool, String> {
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

async fn can_manage_share(state: &NasState, user: &AppUser, record: &ManagedShareRecord) -> bool {
    if user.role == AppRole::Admin || user.id == record.created_by {
        return true;
    }
    can_write_folder(state, user, record.folder_id)
        .await
        .unwrap_or(false)
}

async fn shared_files(state: &NasState, folder_id: Option<i64>) -> Result<Vec<FileMetadata>, HttpResponse> {
    let files = match timeout(
        TokioDuration::from_secs(SHARE_LIST_TIMEOUT_SECONDS),
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

async fn load_folder_metadata(state: &NasState, folder_id: Option<i64>) -> Result<FolderMetadataMap, String> {
    let Some(serialized) = state.db.get_secret(folder_metadata_key(folder_id)).await? else {
        return Ok(HashMap::new());
    };
    match serde_json::from_str::<FolderMetadataMap>(&serialized) {
        Ok(metadata) => Ok(metadata),
        Err(err) => {
            log::warn!("Could not parse file metadata overrides: {}", err);
            Ok(HashMap::new())
        }
    }
}

async fn load_share_record_raw(state: &NasState, token: &str) -> Result<Option<ManagedShareRecord>, String> {
    if token.trim().len() < 20 {
        return Ok(None);
    }
    let Some(encrypted) = state.db.get_secret(share_secret_key(token)).await? else {
        return Ok(None);
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let record: ManagedShareRecord = match serde_json::from_str(&serialized) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if record.token_hash != sha256_hex(token) {
        return Ok(None);
    }
    Ok(Some(record))
}

async fn load_active_share_record(state: &NasState, token: &str) -> Result<Option<ManagedShareRecord>, String> {
    Ok(load_share_record_raw(state, token)
        .await?
        .filter(record_is_active))
}

async fn store_share_record(state: &NasState, token: &str, record: &ManagedShareRecord) -> Result<(), String> {
    let serialized = serde_json::to_string(record).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state.db.store_secret(share_secret_key(token), encrypted).await
}

async fn load_pointer(state: &NasState, key: &str) -> Result<Option<SharePointer>, String> {
    let Some(encrypted) = state.db.get_secret(key.to_string()).await? else {
        return Ok(None);
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(serde_json::from_str::<SharePointer>(&serialized).ok())
}

async fn store_pointer(state: &NasState, key: &str, pointer: &SharePointer) -> Result<(), String> {
    let serialized = serde_json::to_string(pointer).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state.db.store_secret(key.to_string(), encrypted).await
}

async fn load_catalog(state: &NasState) -> Result<Vec<ShareCatalogEntry>, String> {
    let Some(encrypted) = state.db.get_secret(SHARE_CATALOG_KEY.to_string()).await? else {
        return Ok(Vec::new());
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(Vec::new()),
    };
    match serde_json::from_str::<Vec<ShareCatalogEntry>>(&serialized) {
        Ok(entries) => Ok(entries),
        Err(err) => {
            log::warn!("Could not parse public share catalog: {}", err);
            Ok(Vec::new())
        }
    }
}

async fn store_catalog(state: &NasState, entries: &[ShareCatalogEntry]) -> Result<(), String> {
    let serialized = serde_json::to_string(entries).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state
        .db
        .store_secret(SHARE_CATALOG_KEY.to_string(), encrypted)
        .await
}

async fn upsert_catalog_locked(
    state: &NasState,
    token: &str,
    record: &ManagedShareRecord,
) -> Result<(), String> {
    let mut entries = load_catalog(state).await?;
    let next = ShareCatalogEntry {
        token: token.to_string(),
        kind: record.kind,
        folder_id: record.folder_id,
        message_id: record.message_id,
        label: record.label.clone(),
        created_by: record.created_by.clone(),
        created_at: record.created_at,
        expires_at: record.expires_at,
        revoked_at: record.revoked_at,
        views: record.views,
        downloads: record.downloads,
        last_accessed_at: record.last_accessed_at,
        has_password: record.password_hash.is_some(),
    };
    if let Some(existing) = entries.iter_mut().find(|entry| entry.token == token) {
        *existing = next;
    } else {
        entries.push(next);
    }
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    store_catalog(state, &entries).await
}

async fn store_access_grant(state: &NasState, access_key: &str, grant: &ShareAccessGrant) -> Result<(), String> {
    let serialized = serde_json::to_string(grant).map_err(|err| err.to_string())?;
    let encrypted = encrypt_secret(&serialized, state.master_key.as_ref())?;
    state
        .db
        .store_secret(access_grant_key(access_key), encrypted)
        .await
}

async fn share_access_allowed(
    state: &NasState,
    record: &ManagedShareRecord,
    access_key: Option<&str>,
) -> bool {
    if record.password_hash.is_none() {
        return true;
    }
    let Some(access_key) = access_key.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let key = access_grant_key(access_key);
    let Some(encrypted) = state.db.get_secret(key.clone()).await.ok().flatten() else {
        return false;
    };
    let serialized = match decrypt_secret(&encrypted, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let grant: ShareAccessGrant = match serde_json::from_str(&serialized) {
        Ok(value) => value,
        Err(_) => return false,
    };
    if grant.expires_at <= now_ts() {
        let _ = state.db.delete_secret(key).await;
        return false;
    }
    grant.share_token_hash == record.token_hash
}

fn share_create_response(token: String, record: ManagedShareRecord) -> ShareCreateResponse {
    ShareCreateResponse {
        token,
        kind: record.kind,
        label: record.label,
        expires_at: record.expires_at,
        has_password: record.password_hash.is_some(),
    }
}

fn record_is_active(record: &ManagedShareRecord) -> bool {
    record.revoked_at.is_none()
        && record
            .expires_at
            .map(|expires_at| expires_at > now_ts())
            .unwrap_or(true)
}

fn share_status(revoked_at: Option<i64>, expires_at: Option<i64>) -> &'static str {
    if revoked_at.is_some() {
        "revoked"
    } else if expires_at.map(|value| value <= now_ts()).unwrap_or(false) {
        "expired"
    } else {
        "active"
    }
}

fn share_secret_key(token: &str) -> String {
    format!("public_share:{}", sha256_hex(token))
}

fn access_grant_key(access_key: &str) -> String {
    format!("public_share_access:{}", sha256_hex(access_key))
}

fn share_target_key(kind: &ShareKind, folder_id: Option<i64>, message_id: Option<i64>) -> String {
    let folder = folder_key(folder_id);
    match kind {
        ShareKind::Folder => format!("public_share_target:folder:{}", folder),
        ShareKind::File => format!(
            "public_share_target:file:{}:{}",
            folder,
            message_id.unwrap_or_default()
        ),
    }
}

fn share_target_id(record: &ManagedShareRecord) -> String {
    match record.kind {
        ShareKind::Folder => folder_key(record.folder_id),
        ShareKind::File => format!(
            "{}:{}",
            folder_key(record.folder_id),
            record.message_id.unwrap_or_default()
        ),
    }
}

fn share_target_type(kind: ShareKind) -> &'static str {
    match kind {
        ShareKind::File => "telegram_file",
        ShareKind::Folder => "telegram_folder",
    }
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

fn is_initial_download_request(req: &HttpRequest) -> bool {
    match req
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        None => true,
        Some(value) => value.trim().starts_with("bytes=0-"),
    }
}
