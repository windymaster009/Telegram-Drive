use actix_web::cookie::{Cookie, SameSite};
use actix_web::{delete, get, http::header, post, put, web, HttpRequest, HttpResponse, Responder};
use serde_json::json;
use time::Duration;

use super::crypto::{
    decrypt_secret, encrypt_secret, generate_token, hash_password, now_ts, sha256_hex,
    verify_password,
};
use super::models::{
    AppRole, AuthClaims, BootstrapRequest, LoginRequest, LoginResponse, MeResponse,
    OwnerConfigRequest, PermissionUpdateRequest, PublicQrRequest, QrStatusResponse,
    QrTokenResponse, SystemStatus, UserPatchRequest, UserUpsertRequest,
};
use super::state::NasState;

const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 14;
const QR_TTL_SECONDS: i64 = 60 * 10;

#[derive(Clone)]
struct RequestContext {
    user_id: String,
    session_id: String,
    csrf_token: String,
}

pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(system_status)
        .service(me)
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
        .service(delete_user)
        .service(list_sessions)
        .service(revoke_session)
        .service(generate_qr)
        .service(revoke_user_qr_tokens)
        .service(get_permissions)
        .service(set_permissions)
        .service(store_owner_config)
        .service(get_owner_status)
        .service(list_audit_logs);
}

#[get("/api/system/status")]
async fn system_status(state: web::Data<NasState>) -> impl Responder {
    let setup_required = match state.db.setup_required().await {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let owner_configured = state.db.owner_configured().await.unwrap_or(false);
    let owner_connected = state.telegram.client.lock().await.is_some();

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
    if !state
        .allow_rate(format!("bootstrap:{}", client_ip(&req)), 5, 60)
        .await
    {
        return HttpResponse::TooManyRequests().json(json!({ "error": "Too many setup attempts" }));
    }

    match state.db.setup_required().await {
        Ok(false) => {
            return HttpResponse::Conflict().json(json!({ "error": "System is already initialized" }))
        }
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
        _ => {}
    }

    let password_hash = match hash_password(&payload.password) {
        Ok(hash) => hash,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let admin = match state
        .db
        .create_user(
            payload.username.clone(),
            payload.display_name.clone(),
            None,
            password_hash,
            AppRole::Admin,
            false,
        )
        .await
    {
        Ok(user) => user,
        Err(err) => return HttpResponse::BadRequest().json(json!({ "error": err })),
    };

    let _ = state
        .db
        .add_audit_log(
            Some(admin.id.clone()),
            "bootstrap_admin".to_string(),
            "user".to_string(),
            admin.id.clone(),
            "{}".to_string(),
        )
        .await;

    issue_login_response(&state, &admin, &req).await
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

    let record = match state.db.get_user_by_username(payload.username.clone()).await {
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
        owner_connected: state.telegram.client.lock().await.is_some(),
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
        Ok(None) => return HttpResponse::Unauthorized().json(json!({ "error": "Invalid or expired QR token" })),
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
        return HttpResponse::BadRequest().json(json!({ "error": "Admin cannot delete the current session owner" }));
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

    let encrypted_api_id = match encrypt_secret(&payload.api_id.to_string(), state.master_key.as_ref()) {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let encrypted_api_hash = match encrypt_secret(&payload.api_hash, state.master_key.as_ref()) {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    if let Err(err) = state.db.store_secret("owner_api_id".to_string(), encrypted_api_id).await {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }
    if let Err(err) = state
        .db
        .store_secret("owner_api_hash".to_string(), encrypted_api_hash)
        .await
    {
        return HttpResponse::InternalServerError().json(json!({ "error": err }));
    }

    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[get("/api/admin/owner/status")]
async fn get_owner_status(state: web::Data<NasState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = authorize(&state, &req, true).await {
        return resp;
    }

    let owner_api_id = match state.db.get_secret("owner_api_id".to_string()).await {
        Ok(value) => value,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };
    let decrypted_api_id = owner_api_id
        .as_ref()
        .and_then(|value| decrypt_secret(value, state.master_key.as_ref()).ok());

    HttpResponse::Ok().json(json!({
        "configured": owner_api_id.is_some(),
        "api_id": decrypted_api_id,
        "connected": state.telegram.client.lock().await.is_some()
    }))
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
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    let claims = AuthClaims {
        sub: user.id.clone(),
        sid: session.id.clone(),
        role: user.role.as_str().to_string(),
        exp: session.expires_at as usize,
    };
    let jwt = match state.issue_session_jwt(&claims) {
        Ok(jwt) => jwt,
        Err(err) => return HttpResponse::InternalServerError().json(json!({ "error": err })),
    };

    HttpResponse::Ok()
        .cookie(
            Cookie::build(state.session_cookie_name.clone(), jwt.clone())
                .path("/")
                .http_only(true)
                .same_site(SameSite::Lax)
                .max_age(Duration::seconds(SESSION_TTL_SECONDS))
                .finish(),
        )
        .json(LoginResponse {
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
        .or_else(|| req.cookie(&state.session_cookie_name).map(|cookie| cookie.value().to_string()))
        .ok_or_else(|| HttpResponse::Unauthorized().json(json!({ "error": "Missing session token" })))?;
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
        return Err(HttpResponse::Unauthorized().json(json!({ "error": "Session is no longer valid" })));
    }
    if admin_only && record.role != AppRole::Admin {
        return Err(HttpResponse::Forbidden().json(json!({ "error": "Admin access required" })));
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
        Ok(Some((approved, expired))) => HttpResponse::Ok().json(QrStatusResponse { approved, expired }),
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
