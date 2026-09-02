use std::collections::HashMap;
use std::sync::OnceLock;

use actix_web::{get, http::header, put, web, HttpRequest, HttpResponse, Responder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use super::crypto::now_ts;
use super::models::{AccessLevel, AppRole, AppUser};
use super::state::NasState;

static FILE_METADATA_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn metadata_lock() -> &'static Mutex<()> {
    FILE_METADATA_LOCK.get_or_init(|| Mutex::new(()))
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

pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(list_file_metadata)
        .service(update_file_metadata);
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
