use actix_web::cookie::{Cookie, SameSite};
use actix_web::{delete, get, http::header, post, put, web, HttpRequest, HttpResponse, Responder};
use futures::StreamExt;
use serde_json::json;
use time::Duration;
use tokio::time::{timeout, Duration as TokioDuration};

use super::crypto::{
    encrypt_secret, generate_token, hash_password, now_ts, sha256_hex, verify_password,
};
use super::db::GoogleUserProfile;
use super::models::{
    AppRole, ApprovalStatus, AuthClaims, BootstrapRequest, GoogleLoginRequest, LoginRequest,
    LoginResponse, MeResponse, OwnerConfigRequest, PermissionUpdateRequest, PublicQrRequest,
    QrStatusResponse, QrTokenResponse, SystemStatus, UserApprovalRequest, UserPatchRequest,
    UserUpsertRequest,
};
use super::state::NasState;
use crate::commands::auth::{
    check_password_inner, clear_runtime_client_inner, ensure_owner_client_connected, logout_inner,
    owner_session_status_inner, request_owner_code_inner, sign_in_inner,
};
use crate::commands::fs::{
    copy_files_inner, create_folder_inner, delete_file_inner, delete_folder_inner, get_files_inner,
    move_files_inner, rename_folder_inner, scan_folders_for_user, search_global_inner,
    set_folder_icon_inner, set_folder_password_inner, upload_file_inner,
    verify_folder_password_inner, FolderPasswordUpdate,
};
use crate::models::FolderMetadata;

const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 14;
const QR_TTL_SECONDS: i64 = 60 * 10;
const DESKTOP_GOOGLE_LOGIN_TTL_SECONDS: i64 = 60 * 5;

#[derive(Clone)]
struct RequestContext {
    user_id: String,
    session_id: String,
    csrf_token: String,
}

pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(system_status)
        .service(me)
        .service(google_login)
        .service(google_desktop_complete)
        .service(google_desktop_callback)
        .service(google_desktop_status)
        .service(login)
        .service(logout)
        .service(request_public_qr)
        .service(approve_qr)
        .service(qr_status)
        .service(redeem_qr)
        .service(bootstrap_admin)
        .service(list_users)
        .service(create_user)
        .service(update_user)
        .service(update_user_approval)
        .service(delete_user)
        .service(list_sessions)
        .service(revoke_session)
        .service(generate_qr)
        .service(revoke_user_qr_tokens)
        .service(get_permissions)
        .service(set_permissions)
        .service(store_owner_config)
        .service(clear_owner_config)
        .service(get_owner_status)
        .service(request_owner_code)
        .service(owner_sign_in)
        .service(owner_check_password)
        .service(owner_logout)
        .service(telegram_connection)
        .service(list_telegram_files)
        .service(scan_telegram_folders)
        .service(create_telegram_folder)
        .service(delete_telegram_folder)
        .service(rename_telegram_folder)
        .service(set_telegram_folder_icon)
        .service(set_telegram_folder_password)
        .service(verify_telegram_folder_password)
        .service(upload_telegram_file)
        .service(delete_telegram_file)
        .service(move_telegram_files)
        .service(copy_telegram_files)
        .service(search_telegram_files)
        .service(list_audit_logs);
}

#[get("/api/system/status")]
async fn system_status(state: web::Data<NasState>) -> impl Responder {
    let setup_required = match state.db.setup_required().await {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let owner_configured = state.db.owner_configured().await.unwrap_or(false);
    let owner_connected = telegram_session_connected(&state).await;

    HttpResponse::Ok().json(SystemStatus {
        setup_required,
        owner_configured,
        owner_connected,
        api_base_url: state.api_base_url.clone(),
    })
}

#[post("/api/admin/bootstrap")]
async fn bootstrap_admin(
    state: web::Data<NasState>,
    payload: web::Json<BootstrapRequest>,
    req: HttpRequest,
) -> impl Responder {
    let _ = (state, payload, req);
    HttpResponse::Gone().json(json!({
        "error": "Local bootstrap admin creation has been removed. Use Google OAuth and approve admins in MongoDB."
    }))
}

#[derive(serde::Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
}

#[derive(serde::Deserialize)]
struct GoogleUserInfo {
    sub: String,
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(serde::Deserialize)]
struct GoogleCallbackQuery {
    code: Option<String>,
    error: Option<String>,
    state: Option<String>,
}

#[derive(serde::Deserialize)]
struct GoogleDesktopCompleteRequest {
    code: String,
    state: String,
    redirect_uri: Option<String>,
}

#[derive(serde::Deserialize)]
struct OwnerCodeRequest {
    phone: String,
}

#[derive(serde::Deserialize)]
struct OwnerSignInRequest {
    code: String,
}

#[derive(serde::Deserialize)]
struct OwnerPasswordRequest {
    password: String,
}

#[derive(serde::Deserialize)]
struct FilesQuery {
    folder_id: Option<i64>,
}

#[derive(serde::Deserialize)]
struct CreateFolderRequest {
    name: String,
}

#[derive(serde::Deserialize)]
struct RenameFolderRequest {
    name: String,
}

#[derive(serde::Deserialize)]
struct FolderIconRequest {
    icon: Option<String>,
}

#[derive(serde::Deserialize)]
struct FolderPasswordRequest {
    password: Option<String>,
    remove_password: Option<bool>,
}

#[derive(serde::Deserialize)]
struct UploadQuery {
    folder_id: Option<i64>,
    file_name: Option<String>,
}

#[derive(serde::Deserialize)]
struct FilePathQuery {
    folder_id: Option<i64>,
}

#[derive(serde::Deserialize)]
struct MoveCopyRequest {
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    query: String,
}

#[post("/api/auth/google")]
async fn google_login(
    state: web::Data<NasState>,
    payload: web::Json<GoogleLoginRequest>,
    req: HttpRequest,
) -> impl Responder {
    if !state
        .allow_rate(format!("google-login:{}", client_ip(&req)), 20, 60)
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many login attempts" }));
    }

    let client_id = match std::env::var("GOOGLE_OAUTH_CLIENT_ID") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            return HttpResponse::InternalServerError()
                .json(json!({ "error": "Google OAuth client ID is not configured" }))
        }
    };
    let client_secret = match std::env::var("GOOGLE_OAUTH_CLIENT_SECRET") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            return HttpResponse::InternalServerError()
                .json(json!({ "error": "Google OAuth client secret is not configured" }))
        }
    };
    let redirect_uri = payload
        .redirect_uri
        .clone()
        .or_else(|| std::env::var("GOOGLE_OAUTH_REDIRECT_URI").ok())
        .unwrap_or_else(|| "http://localhost:1420/auth/google/callback".to_string());

    let user = match exchange_google_code(
        &state,
        &client_id,
        &client_secret,
        &redirect_uri,
        &payload.code,
    )
    .await
    {
        Ok(user) => user,
        Err(response) => return response,
    };

    issue_login_response(&state, &user, &req).await
}

#[post("/api/auth/google/desktop/complete")]
async fn google_desktop_complete(
    state: web::Data<NasState>,
    payload: web::Json<GoogleDesktopCompleteRequest>,
    req: HttpRequest,
) -> impl Responder {
    if payload.state.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({ "error": "Missing Google login state" }));
    }
    if !state
        .allow_rate(
            format!("google-desktop-complete:{}", client_ip(&req)),
            20,
            60,
        )
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many login attempts" }));
    }

    let now = now_ts();
    {
        let mut guard = state.desktop_google_logins.lock().await;
        guard.retain(|_, result| result.expires_at > now);
        if guard.contains_key(&payload.state) {
            return HttpResponse::Ok().json(json!({ "ok": true }));
        }
        guard.insert(
            payload.state.clone(),
            super::state::DesktopGoogleLoginResult {
                response: None,
                error: None,
                expires_at: now + DESKTOP_GOOGLE_LOGIN_TTL_SECONDS,
            },
        );
    }

    let client_id = match std::env::var("GOOGLE_OAUTH_CLIENT_ID") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            return HttpResponse::InternalServerError()
                .json(json!({ "error": "Google OAuth client ID is not configured" }))
        }
    };
    let client_secret = match std::env::var("GOOGLE_OAUTH_CLIENT_SECRET") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            return HttpResponse::InternalServerError()
                .json(json!({ "error": "Google OAuth client secret is not configured" }))
        }
    };
    let redirect_uri = payload
        .redirect_uri
        .clone()
        .or_else(|| std::env::var("GOOGLE_OAUTH_REDIRECT_URI").ok())
        .unwrap_or_else(|| "http://localhost:1420/auth/google/callback".to_string());

    let user = match exchange_google_code(
        &state,
        &client_id,
        &client_secret,
        &redirect_uri,
        &payload.code,
    )
    .await
    {
        Ok(user) => user,
        Err(response) => {
            store_desktop_google_error(
                &state,
                payload.state.clone(),
                "Google login failed".to_string(),
            )
            .await;
            return response;
        }
    };

    let response = match create_login_response(&state, &user, &req).await {
        Ok(response) => response,
        Err(response) => {
            store_desktop_google_error(
                &state,
                payload.state.clone(),
                "Could not create a Telegram Drive session".to_string(),
            )
            .await;
            return response;
        }
    };

    store_desktop_google_response(&state, payload.state.clone(), response).await;
    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[get("/api/auth/google/callback")]
async fn google_desktop_callback(
    state: web::Data<NasState>,
    query: web::Query<GoogleCallbackQuery>,
    req: HttpRequest,
) -> impl Responder {
    let oauth_state = match query
        .state
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => value.to_string(),
        None => return google_callback_page("Google sign-in was missing state", false),
    };

    if let Some(error) = &query.error {
        store_desktop_google_error(
            &state,
            oauth_state,
            format!("Google login failed: {}", error),
        )
        .await;
        return google_callback_page(
            "Google sign-in was cancelled or failed. Return to Telegram Drive and try again.",
            false,
        );
    }

    let code = match query.code.as_ref().filter(|value| !value.trim().is_empty()) {
        Some(value) => value.to_string(),
        None => {
            store_desktop_google_error(
                &state,
                oauth_state,
                "Google login did not return a code".to_string(),
            )
            .await;
            return google_callback_page(
                "Google sign-in did not return a code. Return to Telegram Drive and try again.",
                false,
            );
        }
    };

    if !state
        .allow_rate(format!("google-callback:{}", client_ip(&req)), 20, 60)
        .await
    {
        store_desktop_google_error(
            &state,
            oauth_state,
            "Too many Google login attempts".to_string(),
        )
        .await;
        return google_callback_page(
            "Too many Google login attempts. Return to Telegram Drive and try again shortly.",
            false,
        );
    }

    let client_id = match std::env::var("GOOGLE_OAUTH_CLIENT_ID") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            store_desktop_google_error(
                &state,
                oauth_state,
                "Google OAuth client ID is not configured".to_string(),
            )
            .await;
            return google_callback_page("Google OAuth client ID is not configured.", false);
        }
    };
    let client_secret = match std::env::var("GOOGLE_OAUTH_CLIENT_SECRET") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            store_desktop_google_error(
                &state,
                oauth_state,
                "Google OAuth client secret is not configured".to_string(),
            )
            .await;
            return google_callback_page("Google OAuth client secret is not configured.", false);
        }
    };
    let redirect_uri = google_desktop_redirect_uri(&state);

    let user = match exchange_google_code(&state, &client_id, &client_secret, &redirect_uri, &code)
        .await
    {
        Ok(user) => user,
        Err(_) => {
            store_desktop_google_error(&state, oauth_state, "Google login failed".to_string())
                .await;
            return google_callback_page(
                "Google sign-in failed. Return to Telegram Drive and try again.",
                false,
            );
        }
    };

    let response = match create_login_response(&state, &user, &req).await {
        Ok(response) => response,
        Err(response) => {
            store_desktop_google_error(
                &state,
                oauth_state,
                "Could not create a Telegram Drive session".to_string(),
            )
            .await;
            return response;
        }
    };

    store_desktop_google_response(&state, oauth_state, response).await;

    google_callback_page(
        "Google sign-in complete. Return to Telegram Drive; you can close this tab.",
        true,
    )
}

#[get("/api/auth/google/desktop/status/{state}")]
async fn google_desktop_status(
    state: web::Data<NasState>,
    path: web::Path<String>,
) -> impl Responder {
    let oauth_state = path.into_inner();
    let now = now_ts();
    let mut guard = state.desktop_google_logins.lock().await;
    guard.retain(|_, result| result.expires_at > now);

    match guard.remove(&oauth_state) {
        Some(result) if result.error.is_some() => {
            HttpResponse::Ok().json(json!({ "status": "error", "error": result.error.unwrap_or_else(|| "Google login failed".to_string()) }))
        }
        Some(result) if result.response.is_some() => {
            HttpResponse::Ok().json(json!({ "status": "complete", "response": result.response }))
        }
        Some(result) => {
            guard.insert(oauth_state, result);
            HttpResponse::Ok().json(json!({ "status": "pending" }))
        }
        None => HttpResponse::Ok().json(json!({ "status": "pending" })),
    }
}

async fn exchange_google_code(
    state: &NasState,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<super::models::AppUser, HttpResponse> {
    let http = reqwest::Client::new();
    let token = match http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<GoogleTokenResponse>().await {
                Ok(token) => token,
                Err(err) => {
                    return Err(HttpResponse::BadGateway().json(json!({ "error": err.to_string() })))
                }
            }
        }
        Ok(response) => {
            return Err(HttpResponse::Unauthorized().json(
                json!({ "error": format!("Google token exchange failed: {}", response.status()) }),
            ))
        }
        Err(err) => {
            return Err(HttpResponse::BadGateway().json(json!({ "error": err.to_string() })))
        }
    };

    let info = match http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(token.access_token)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<GoogleUserInfo>().await {
                Ok(info) => info,
                Err(err) => {
                    return Err(HttpResponse::BadGateway().json(json!({ "error": err.to_string() })))
                }
            }
        }
        Ok(response) => {
            return Err(HttpResponse::Unauthorized().json(
                json!({ "error": format!("Google userinfo failed: {}", response.status()) }),
            ))
        }
        Err(err) => {
            return Err(HttpResponse::BadGateway().json(json!({ "error": err.to_string() })))
        }
    };

    state
        .db
        .upsert_google_user(GoogleUserProfile {
            google_id: info.sub,
            email: info.email.clone(),
            name: info.name.unwrap_or(info.email),
            avatar: info.picture,
        })
        .await
        .map_err(|err| HttpResponse::InternalServerError().json(json!({ "error": err })))
}

async fn store_desktop_google_error(state: &NasState, oauth_state: String, error: String) {
    let mut guard = state.desktop_google_logins.lock().await;
    guard.insert(
        oauth_state,
        super::state::DesktopGoogleLoginResult {
            response: None,
            error: Some(error),
            expires_at: now_ts() + DESKTOP_GOOGLE_LOGIN_TTL_SECONDS,
        },
    );
}

async fn store_desktop_google_response(
    state: &NasState,
    oauth_state: String,
    response: LoginResponse,
) {
    let mut guard = state.desktop_google_logins.lock().await;
    guard.insert(
        oauth_state,
        super::state::DesktopGoogleLoginResult {
            response: Some(response),
            error: None,
            expires_at: now_ts() + DESKTOP_GOOGLE_LOGIN_TTL_SECONDS,
        },
    );
}

fn google_desktop_redirect_uri(state: &NasState) -> String {
    format!("{}/api/auth/google/callback", state.api_base_url)
}

fn google_callback_page(message: &str, success: bool) -> HttpResponse {
    let title = if success {
        "Google sign-in complete"
    } else {
        "Google sign-in failed"
    };
    let accent = if success { "#22c55e" } else { "#f97316" };
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><title>{}</title></head><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#07111f;color:white;display:grid;min-height:100vh;place-items:center"><main style="max-width:560px;padding:32px"><div style="width:48px;height:48px;border-radius:999px;background:{};margin-bottom:24px"></div><h1 style="font-size:32px;margin:0 0 12px">{}</h1><p style="color:#cbd5e1;font-size:16px;line-height:1.6">{}</p></main></body></html>"#,
            title, accent, title, message
        ))
}

#[post("/api/auth/login")]
async fn login(
    state: web::Data<NasState>,
    payload: web::Json<LoginRequest>,
    req: HttpRequest,
) -> impl Responder {
    if !state
        .allow_rate(format!("login:{}", client_ip(&req)), 10, 60)
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many login attempts" }));
    }

    let record = match state
        .db
        .get_user_by_username(payload.username.clone())
        .await
    {
        Ok(Some(record)) => record,
        Ok(None) => {
            return HttpResponse::Unauthorized().json(json!({ "error": "Invalid credentials" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let (user, password_hash) = record;
    if user.disabled {
        return HttpResponse::Forbidden().json(json!({ "error": "User is disabled" }));
    }

    match verify_password(&payload.password, &password_hash) {
        Ok(true) => issue_login_response(&state, &user, &req).await,
        Ok(false) => HttpResponse::Unauthorized().json(json!({ "error": "Invalid credentials" })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[post("/api/auth/logout")]
async fn logout(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Ok(ctx) = authorize(&state, &req, false).await {
        let _ = state.db.revoke_session(ctx.session_id).await;
    }

    HttpResponse::Ok()
        .cookie(
            Cookie::build(state.session_cookie_name.clone(), "")
                .path("/")
                .max_age(Duration::seconds(0))
                .http_only(true)
                .same_site(SameSite::Lax)
                .finish(),
        )
        .json(json!({ "ok": true }))
}

#[get("/api/auth/me")]
async fn me(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    let ctx = match authorize(&state, &req, false).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };
    let user = match state.db.get_user_by_id(ctx.user_id.clone()).await {
        Ok(Some(user)) => user,
        Ok(None) => return HttpResponse::Unauthorized().json(json!({ "error": "Unknown user" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let permissions = match state.db.get_permissions(user.id.clone()).await {
        Ok(permissions) => permissions,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    HttpResponse::Ok().json(MeResponse {
        user,
        permissions,
        owner_connected: telegram_session_connected(&state).await,
        csrf_token: ctx.csrf_token,
    })
}

#[post("/api/auth/qr/redeem/{token}")]
async fn redeem_qr(
    state: web::Data<NasState>,
    path: web::Path<String>,
    req: HttpRequest,
) -> impl Responder {
    if !state
        .allow_rate(format!("qr:{}", client_ip(&req)), 15, 60)
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many QR attempts" }));
    }

    let token_hash = sha256_hex(&path.into_inner());
    let redemption = match state.db.redeem_qr_token(token_hash).await {
        Ok(Some(redemption)) => redemption,
        Ok(None) => {
            return HttpResponse::Unauthorized()
                .json(json!({ "error": "Invalid or expired QR token" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if redemption.user.disabled {
        return HttpResponse::Forbidden().json(json!({ "error": "User is disabled" }));
    }

    issue_login_response(&state, &redemption.user, &req).await
}

#[get("/api/admin/users")]
async fn list_users(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.list_users().await {
        Ok(users) => HttpResponse::Ok().json(users),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[post("/api/admin/users")]
async fn create_user(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<UserUpsertRequest>,
) -> impl Responder {
    let ctx = match authorize(&state, &req, true).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };

    let password = match &payload.password {
        Some(password) => password,
        None => return HttpResponse::BadRequest().json(json!({ "error": "Password is required" })),
    };
    let password_hash = match hash_password(password) {
        Ok(hash) => hash,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    match state
        .db
        .create_user(
            payload.username.clone(),
            payload.display_name.clone(),
            normalize_telegram_username(payload.telegram_username.clone()),
            password_hash,
            payload.role.clone(),
            payload.disabled,
        )
        .await
    {
        Ok(user) => {
            let _ = state
                .db
                .add_audit_log(
                    Some(ctx.user_id),
                    "create_user".to_string(),
                    "user".to_string(),
                    user.id.clone(),
                    json!({ "telegram_username": user.telegram_username }).to_string(),
                )
                .await;
            HttpResponse::Ok().json(user)
        }
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[put("/api/admin/users/{user_id}")]
async fn update_user(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<UserPatchRequest>,
) -> impl Responder {
    let ctx = match authorize(&state, &req, true).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };
    let password_hash = match payload.password.as_ref() {
        Some(password) => match hash_password(password) {
            Ok(hash) => Some(hash),
            Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        },
        None => None,
    };
    let user_id = path.into_inner();

    match state
        .db
        .patch_user(
            user_id.clone(),
            payload.display_name.clone(),
            normalize_telegram_username(payload.telegram_username.clone()),
            payload.disabled,
            payload.role.clone(),
            password_hash,
            payload.approval_status.clone(),
        )
        .await
    {
        Ok(()) => {
            let _ = state
                .db
                .add_audit_log(
                    Some(ctx.user_id),
                    "update_user".to_string(),
                    "user".to_string(),
                    user_id,
                    "{}".to_string(),
                )
                .await;
            HttpResponse::Ok().json(json!({ "ok": true }))
        }
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[put("/api/admin/users/{user_id}/approval")]
async fn update_user_approval(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<UserApprovalRequest>,
) -> impl Responder {
    let ctx = match authorize(&state, &req, true).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };
    let user_id = path.into_inner();
    match state
        .db
        .set_user_approval(user_id.clone(), payload.approval_status.clone())
        .await
    {
        Ok(()) => {
            let _ = state
                .db
                .add_audit_log(
                    Some(ctx.user_id),
                    "update_user_approval".to_string(),
                    "user".to_string(),
                    user_id,
                    json!({ "approval_status": payload.approval_status.as_str() }).to_string(),
                )
                .await;
            HttpResponse::Ok().json(json!({ "ok": true }))
        }
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[delete("/api/admin/users/{user_id}")]
async fn delete_user(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    let ctx = match authorize(&state, &req, true).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };
    let user_id = path.into_inner();
    if user_id == ctx.user_id {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Admin cannot delete the current session owner" }));
    }
    match state.db.delete_user(user_id.clone()).await {
        Ok(()) => {
            let _ = state
                .db
                .add_audit_log(
                    Some(ctx.user_id),
                    "delete_user".to_string(),
                    "user".to_string(),
                    user_id,
                    "{}".to_string(),
                )
                .await;
            HttpResponse::Ok().json(json!({ "ok": true }))
        }
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[get("/api/admin/sessions")]
async fn list_sessions(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.list_sessions().await {
        Ok(sessions) => HttpResponse::Ok().json(sessions),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[delete("/api/admin/sessions/{session_id}")]
async fn revoke_session(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.revoke_session(path.into_inner()).await {
        Ok(()) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[post("/api/admin/users/{user_id}/qr")]
async fn generate_qr(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    let ctx = match authorize(&state, &req, true).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };
    let user_id = path.into_inner();
    let raw_token = generate_token();
    let expires_at = now_ts() + QR_TTL_SECONDS;
    let login_url = format!("{}/?qr={}", state.api_base_url, raw_token);

    match state
        .db
        .create_qr_token(
            user_id.clone(),
            sha256_hex(&raw_token),
            ctx.user_id,
            expires_at,
            false,
        )
        .await
    {
        Ok(()) => HttpResponse::Ok().json(QrTokenResponse {
            token: raw_token,
            login_url,
            expires_at,
            user_id,
        }),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[delete("/api/admin/users/{user_id}/qr")]
async fn revoke_user_qr_tokens(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.revoke_qr_tokens_for_user(path.into_inner()).await {
        Ok(()) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[get("/api/admin/users/{user_id}/permissions")]
async fn get_permissions(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.get_permissions(path.into_inner()).await {
        Ok(permissions) => HttpResponse::Ok().json(permissions),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[put("/api/admin/users/{user_id}/permissions")]
async fn set_permissions(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<PermissionUpdateRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state
        .db
        .set_permissions(path.into_inner(), payload.permissions.clone())
        .await
    {
        Ok(()) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[post("/api/admin/owner/config")]
async fn store_owner_config(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<OwnerConfigRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    if payload.api_id <= 0 || payload.api_hash.trim().is_empty() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Telegram API ID and API Hash are required" }));
    }

    let encrypted_api_id =
        match encrypt_secret(&payload.api_id.to_string(), state.master_key.as_ref()) {
            Ok(value) => value,
            Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        };
    let encrypted_api_hash = match encrypt_secret(&payload.api_hash, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if let Err(err) = state
        .db
        .store_secret("owner_api_id".to_string(), encrypted_api_id)
        .await
    {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = state
        .db
        .store_secret("owner_api_hash".to_string(), encrypted_api_hash)
        .await
    {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    clear_runtime_client_inner(state.telegram.as_ref()).await;
    *state.telegram.api_id.lock().await = Some(payload.api_id);

    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[delete("/api/admin/owner/config")]
async fn clear_owner_config(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    if let Err(err) = state.db.delete_secret("owner_api_id".to_string()).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = state.db.delete_secret("owner_api_hash".to_string()).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    {
        let mut shutdown_guard = state.telegram.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            let _ = shutdown_tx.send(());
        }
    }
    *state.telegram.client.lock().await = None;
    *state.telegram.login_token.lock().await = None;
    *state.telegram.password_token.lock().await = None;
    *state.telegram.api_id.lock().await = None;
    if let Some(path) = state.telegram.session_path.lock().await.clone() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return HttpResponse::InternalServerError()
                    .json(json!({ "error": err.to_string() }))
            }
        }
    }

    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[get("/api/admin/owner/status")]
async fn get_owner_status(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    match owner_session_status_inner(&state).await {
        Ok(status) => HttpResponse::Ok().json(status),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[post("/api/admin/owner/auth/request-code")]
async fn request_owner_code(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<OwnerCodeRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    let phone = payload.phone.trim().replace(' ', "");
    if phone.is_empty() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Telegram phone number is required" }));
    }

    match timeout(
        TokioDuration::from_secs(60),
        request_owner_code_inner(&state, phone),
    )
    .await
    {
        Err(_) => HttpResponse::GatewayTimeout().json(json!({
            "error": "Telegram code request timed out after 60 seconds. Check Pi Telegram connectivity and backend logs, then try again."
        })),
        Ok(Ok(status)) => HttpResponse::Ok().json(json!({ "status": status })),
        Ok(Err(err)) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/admin/owner/auth/sign-in")]
async fn owner_sign_in(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<OwnerSignInRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    if payload.code.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({ "error": "Telegram code is required" }));
    }

    match sign_in_inner(state.telegram.as_ref(), payload.code.trim().to_string()).await {
        Ok(result) => HttpResponse::Ok().json(result),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/admin/owner/auth/check-password")]
async fn owner_check_password(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<OwnerPasswordRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    if payload.password.is_empty() {
        return HttpResponse::BadRequest()
            .json(json!({ "error": "Telegram 2FA password is required" }));
    }

    match check_password_inner(state.telegram.as_ref(), payload.password.clone()).await {
        Ok(result) => HttpResponse::Ok().json(result),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/admin/owner/auth/logout")]
async fn owner_logout(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    match logout_inner(state.telegram.as_ref()).await {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[get("/api/telegram/connection")]
async fn telegram_connection(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }

    match ensure_owner_client_connected(&state).await {
        Ok(Some(_)) => HttpResponse::Ok().json(json!({ "connected": true })),
        Ok(None) => HttpResponse::Ok().json(json!({ "connected": false })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[get("/api/telegram/files")]
async fn list_telegram_files(
    state: web::Data<NasState>,
    req: HttpRequest,
    query: web::Query<FilesQuery>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }

    if let Err(err) = ensure_owner_client_connected(&state).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    match get_files_inner(query.folder_id, state.telegram.as_ref()).await {
        Ok(files) => HttpResponse::Ok().json(files),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[get("/api/telegram/folders/scan")]
async fn scan_telegram_folders(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    let ctx = match authorize(&state, &req, false).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };

    let user = match state.db.get_user_by_id(ctx.user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return HttpResponse::Unauthorized().json(json!({ "error": "Unknown user" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if user.role != AppRole::Admin {
        let folders: Vec<FolderMetadata> = match state.db.get_permissions(user.id.clone()).await {
            Ok(permissions) => permissions
                .into_iter()
                .filter_map(|permission| {
                    let id = permission.folder_id.parse::<i64>().ok()?;
                    Some(FolderMetadata {
                        id,
                        parent_id: None,
                        name: permission.folder_label,
                        icon: permission.icon,
                        owner_id: permission.owner_id,
                        owner_name: permission.owner_name,
                        is_password_protected: permission.is_password_protected,
                        can_manage: permission.can_manage,
                        created_at: None,
                        updated_at: None,
                    })
                })
                .collect(),
            Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        };
        return HttpResponse::Ok().json(folders);
    }

    if let Err(err) = ensure_owner_client_connected(&state).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    match scan_folders_for_user(state.telegram.as_ref(), &state, user).await {
        Ok(folders) => HttpResponse::Ok().json(folders),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/telegram/folders")]
async fn create_telegram_folder(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<CreateFolderRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match create_folder_inner(
        payload.name.clone(),
        token,
        None,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(folder) => HttpResponse::Ok().json(folder),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[delete("/api/telegram/folders/{folder_id}")]
async fn delete_telegram_folder(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match delete_folder_inner(
        path.into_inner(),
        token,
        None,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[put("/api/telegram/folders/{folder_id}/name")]
async fn rename_telegram_folder(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
    payload: web::Json<RenameFolderRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match rename_folder_inner(
        path.into_inner(),
        payload.name.clone(),
        token,
        None,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(folder) => HttpResponse::Ok().json(folder),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[put("/api/telegram/folders/{folder_id}/icon")]
async fn set_telegram_folder_icon(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
    payload: web::Json<FolderIconRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match set_folder_icon_inner(path.into_inner(), payload.icon.clone(), token, None, &state).await
    {
        Ok(folder) => HttpResponse::Ok().json(folder),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[put("/api/telegram/folders/{folder_id}/password")]
async fn set_telegram_folder_password(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
    payload: web::Json<FolderPasswordRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    let update = FolderPasswordUpdate {
        password: payload.password.clone(),
        remove_password: payload.remove_password,
    };
    match set_folder_password_inner(path.into_inner(), update, token, None, &state).await {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/telegram/folders/{folder_id}/verify-password")]
async fn verify_telegram_folder_password(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i64>,
    payload: web::Json<OwnerPasswordRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    match verify_folder_password_inner(path.into_inner(), payload.password.clone(), &state).await {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/telegram/upload")]
async fn upload_telegram_file(
    state: web::Data<NasState>,
    req: HttpRequest,
    query: web::Query<UploadQuery>,
    mut payload: web::Payload,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let file_name = query
        .file_name
        .clone()
        .unwrap_or_else(|| "upload.bin".to_string());
    let safe_name = safe_upload_name(&file_name);
    let upload_dir = state
        .app_data_dir
        .join("api-uploads")
        .join(uuid::Uuid::new_v4().to_string());
    if let Err(err) = tokio::fs::create_dir_all(&upload_dir).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err.to_string() }));
    }
    let upload_path = upload_dir.join(safe_name);
    let mut file = match tokio::fs::File::create(&upload_path).await {
        Ok(file) => file,
        Err(err) => {
            return HttpResponse::InternalServerError().json(json!({ "error": err.to_string() }))
        }
    };

    while let Some(chunk) = payload.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                return HttpResponse::BadRequest().json(json!({ "error": err.to_string() }))
            }
        };
        if let Err(err) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            let _ = tokio::fs::remove_dir_all(&upload_dir).await;
            return HttpResponse::InternalServerError().json(json!({ "error": err.to_string() }));
        }
    }
    drop(file);

    let token = session_token_from_request(&state, &req);
    let result = upload_file_inner(
        upload_path.to_string_lossy().to_string(),
        query.folder_id,
        None,
        token,
        None,
        state.telegram.as_ref(),
        &state,
        None,
    )
    .await;
    let _ = tokio::fs::remove_dir_all(&upload_dir).await;

    match result {
        Ok(message) => HttpResponse::Ok().json(json!({ "message": message })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[delete("/api/telegram/files/{message_id}")]
async fn delete_telegram_file(
    state: web::Data<NasState>,
    req: HttpRequest,
    path: web::Path<i32>,
    query: web::Query<FilePathQuery>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match delete_file_inner(
        path.into_inner(),
        query.folder_id,
        token,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/telegram/files/move")]
async fn move_telegram_files(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<MoveCopyRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match move_files_inner(
        payload.message_ids.clone(),
        payload.source_folder_id,
        payload.target_folder_id,
        token,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[post("/api/telegram/files/copy")]
async fn copy_telegram_files(
    state: web::Data<NasState>,
    req: HttpRequest,
    payload: web::Json<MoveCopyRequest>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    let token = session_token_from_request(&state, &req);
    match copy_files_inner(
        payload.message_ids.clone(),
        payload.source_folder_id,
        payload.target_folder_id,
        token,
        state.telegram.as_ref(),
        &state,
    )
    .await
    {
        Ok(ok) => HttpResponse::Ok().json(json!({ "ok": ok })),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

#[get("/api/telegram/search")]
async fn search_telegram_files(
    state: web::Data<NasState>,
    req: HttpRequest,
    query: web::Query<SearchQuery>,
) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, false).await {
        return resp;
    }
    match search_global_inner(query.query.clone(), state.telegram.as_ref()).await {
        Ok(files) => HttpResponse::Ok().json(files),
        Err(err) => HttpResponse::BadRequest().json(json!({ "error": err })),
    }
}

async fn telegram_session_connected(state: &NasState) -> bool {
    state.telegram.client.lock().await.is_some()
}

#[get("/api/admin/audit-logs")]
async fn list_audit_logs(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }
    match state.db.list_audit_logs().await {
        Ok(entries) => HttpResponse::Ok().json(entries),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

async fn issue_login_response(
    state: &NasState,
    user: &super::models::AppUser,
    req: &HttpRequest,
) -> HttpResponse {
    let response = match create_login_response(state, user, req).await {
        Ok(response) => response,
        Err(response) => return response,
    };

    HttpResponse::Ok()
        .cookie(
            Cookie::build(
                state.session_cookie_name.clone(),
                response.access_token.clone(),
            )
            .path("/")
            .http_only(true)
            .same_site(SameSite::Lax)
            .max_age(Duration::seconds(SESSION_TTL_SECONDS))
            .finish(),
        )
        .json(response)
}

async fn create_login_response(
    state: &NasState,
    user: &super::models::AppUser,
    req: &HttpRequest,
) -> Result<LoginResponse, HttpResponse> {
    let csrf_token = generate_token();
    let session = match state
        .db
        .create_session(
            user,
            csrf_token.clone(),
            client_ip(req),
            user_agent(req),
            SESSION_TTL_SECONDS,
        )
        .await
    {
        Ok(session) => session,
        Err(err) => return Err(HttpResponse::InternalServerError().json(json!({ "error": err }))),
    };

    let claims = AuthClaims {
        sub: user.id.clone(),
        sid: session.id.clone(),
        role: user.role.as_str().to_string(),
        exp: session.expires_at as usize,
    };
    let jwt = match state.issue_session_jwt(&claims) {
        Ok(jwt) => jwt,
        Err(err) => return Err(HttpResponse::InternalServerError().json(json!({ "error": err }))),
    };

    Ok(LoginResponse {
        user: user.clone(),
        csrf_token,
        access_token: jwt,
    })
}

async fn authorize(
    state: &NasState,
    req: &HttpRequest,
    admin_only: bool,
) -> Result<RequestContext, HttpResponse> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| {
            req.cookie(&state.session_cookie_name)
                .map(|cookie| cookie.value().to_string())
        })
        .ok_or_else(|| {
            HttpResponse::Unauthorized().json(json!({ "error": "Missing session token" }))
        })?;
    let claims = state
        .decode_session_jwt(&token)
        .map_err(|_| HttpResponse::Unauthorized().json(json!({ "error": "Invalid session" })))?;
    let record = state
        .db
        .get_session(claims.sid.clone())
        .await
        .map_err(|err| HttpResponse::InternalServerError().json(json!({ "error": err })))?;
    let record = record
        .ok_or_else(|| HttpResponse::Unauthorized().json(json!({ "error": "Session expired" })))?;
    if record.disabled || record.session.expires_at < now_ts() {
        return Err(
            HttpResponse::Unauthorized().json(json!({ "error": "Session is no longer valid" }))
        );
    }
    if admin_only && record.role != AppRole::Admin {
        return Err(HttpResponse::Forbidden().json(json!({ "error": "Admin access required" })));
    }
    let approval_exempt = req.path() == "/api/auth/me" || req.path() == "/api/auth/logout";
    if !admin_only
        && !approval_exempt
        && (!record.is_approved || record.approval_status != ApprovalStatus::Approved)
    {
        return Err(HttpResponse::Forbidden().json(json!({
            "error": "Account approval is required before accessing Telegram Drive"
        })));
    }
    if req.method() != actix_web::http::Method::GET {
        let csrf = req
            .headers()
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if csrf != record.csrf_token {
            return Err(HttpResponse::Forbidden().json(json!({ "error": "Invalid CSRF token" })));
        }
    }
    let _ = state.db.touch_session(record.session.id.clone()).await;
    Ok(RequestContext {
        user_id: record.session.user_id,
        session_id: record.session.id,
        csrf_token: record.csrf_token,
    })
}

fn session_token_from_request(state: &NasState, req: &HttpRequest) -> Option<String> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| {
            req.cookie(&state.session_cookie_name)
                .map(|cookie| cookie.value().to_string())
        })
}

fn safe_upload_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        "upload.bin".to_string()
    } else {
        sanitized
    }
}

fn client_ip(req: &HttpRequest) -> String {
    req.connection_info()
        .realip_remote_addr()
        .unwrap_or("local")
        .to_string()
}

fn user_agent(req: &HttpRequest) -> String {
    req.headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}

#[post("/api/auth/qr/request")]
async fn request_public_qr(
    state: web::Data<NasState>,
    payload: web::Json<PublicQrRequest>,
    req: HttpRequest,
) -> impl Responder {
    if !state
        .allow_rate(format!("qr-request:{}", client_ip(&req)), 8, 60)
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many QR requests" }));
    }

    let user = match state
        .db
        .get_user_by_login_identifier(payload.identifier.clone())
        .await
    {
        Ok(Some(user)) => user,
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "User not found" })),
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if user.disabled {
        return HttpResponse::Forbidden().json(json!({ "error": "User is disabled" }));
    }

    let raw_token = generate_token();
    let expires_at = now_ts() + QR_TTL_SECONDS;
    let login_url = format!("{}/api/auth/qr/approve/{}", state.api_base_url, raw_token);

    match state
        .db
        .create_qr_token(
            user.id.clone(),
            sha256_hex(&raw_token),
            user.id.clone(),
            expires_at,
            true,
        )
        .await
    {
        Ok(()) => HttpResponse::Ok().json(QrTokenResponse {
            token: raw_token,
            login_url,
            expires_at,
            user_id: user.id,
        }),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[get("/api/auth/qr/approve/{token}")]
async fn approve_qr(state: web::Data<NasState>, path: web::Path<String>) -> impl Responder {
    let token_hash = sha256_hex(&path.into_inner());
    match state.db.approve_qr_token(token_hash).await {
        Ok(true) => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body("<!doctype html><html><body style=\"font-family:system-ui;background:#07111f;color:white;padding:32px\"><h1>QR approved</h1><p>Return to Telegram Drive on your desktop. You can close this page.</p></body></html>"),
        Ok(false) => HttpResponse::Gone()
            .content_type("text/html; charset=utf-8")
            .body("<!doctype html><html><body style=\"font-family:system-ui;background:#07111f;color:white;padding:32px\"><h1>QR expired</h1><p>Ask for a new QR code from the login screen.</p></body></html>"),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

#[get("/api/auth/qr/status/{token}")]
async fn qr_status(state: web::Data<NasState>, path: web::Path<String>) -> impl Responder {
    let token_hash = sha256_hex(&path.into_inner());
    match state.db.get_qr_status(token_hash).await {
        Ok(Some((approved, expired))) => {
            HttpResponse::Ok().json(QrStatusResponse { approved, expired })
        }
        Ok(None) => HttpResponse::NotFound().json(json!({ "error": "QR not found" })),
        Err(err) => HttpResponse::InternalServerError().json(json!({ "error": err })),
    }
}

fn normalize_telegram_username(value: Option<String>) -> Option<String> {
    value
        .map(|username| username.trim().trim_start_matches('@').to_string())
        .filter(|username| !username.is_empty())
        .map(|username| format!("@{}", username))
}
