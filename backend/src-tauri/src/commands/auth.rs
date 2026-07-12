use grammers_client::Client;
use grammers_mtsender::SenderPool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::State;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

use crate::commands::session::EncryptedSession;
use crate::commands::utils::map_error;
use crate::models::AuthResult;
use crate::nas::{crypto::decrypt_secret, state::NasState};
use crate::TelegramState;
use grammers_client::SignInError;
use serde::Serialize;

fn owner_secret_decrypt_error(err: String) -> String {
    format!(
        "Saved owner API credentials could not be decrypted: {}. Click Clear Saved Setup, then save the API credentials again.",
        err
    )
}

/// Ensures the Telegram client is initialized.
///
/// IMPORTANT: This function properly manages runner lifecycle to prevent stack overflow.
/// Before spawning a new runner, it signals the old runner to shutdown.
pub async fn ensure_client_initialized(
    app_handle: &tauri::AppHandle,
    state: &State<'_, TelegramState>,
    api_id: i32,
) -> Result<Client, String> {
    let _ = app_handle;
    ensure_client_initialized_inner(state.inner(), api_id).await
}

pub async fn ensure_client_initialized_inner(
    state: &TelegramState,
    api_id: i32,
) -> Result<Client, String> {
    let _init_guard = state.init_lock.lock().await;

    if let Some(client) = {
        let client_guard = state.client.lock().await;
        client_guard.as_ref().cloned()
    } {
        return Ok(client.clone());
    }

    // CRITICAL: Shutdown existing runner before creating a new one
    // This prevents runner task accumulation which causes stack overflow
    let did_shutdown_old_runner = {
        let mut guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = guard.take() {
            log::info!("Signaling old runner to shutdown...");
            let _ = shutdown_tx.send(());
            true
        } else {
            false
        }
    }; // MutexGuard dropped here — before the await
    if did_shutdown_old_runner {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let runner_num = state.runner_count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!(
        "Initializing Telegram Client #{} with API ID: {}",
        runner_num,
        api_id
    );

    let session_path = state
        .session_path
        .lock()
        .await
        .clone()
        .ok_or("Telegram session storage is not configured")?;
    let session_key = state
        .session_encryption_key
        .lock()
        .await
        .clone()
        .ok_or("Telegram session encryption key is not configured")?;
    let session = Arc::new(EncryptedSession::load(session_path, session_key.as_ref())?);
    let pool = SenderPool::new(session, api_id);
    let client = Client::new(&pool);

    // Create shutdown channel for this runner
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *state.runner_shutdown.lock().unwrap() = Some(shutdown_tx);

    // Spawn the network runner with shutdown support
    let SenderPool { runner, .. } = pool;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            // Normal runner operation
            _ = runner.run() => {
                log::info!("Runner #{} exited normally", runner_num);
            }
            // Shutdown requested
            _ = shutdown_rx => {
                log::info!("Runner #{} shutdown requested, exiting", runner_num);
            }
        }
    });

    *state.client.lock().await = Some(client.clone());
    Ok(client)
}

pub async fn clear_runtime_client_inner(state: &TelegramState) {
    let _init_guard = match timeout(Duration::from_secs(5), state.init_lock.lock()).await {
        Ok(guard) => Some(guard),
        Err(_) => {
            log::warn!("Timed out waiting for Telegram init lock while clearing runtime client");
            None
        }
    };

    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling Telegram runner shutdown...");
            let _ = shutdown_tx.send(());
        }
    }

    *state.client.lock().await = None;
    *state.login_token.lock().await = None;
    *state.password_token.lock().await = None;
}

async fn clear_runtime_client(state: &State<'_, TelegramState>) {
    clear_runtime_client_inner(state.inner()).await;
}

pub async fn ensure_owner_client_connected(nas_state: &NasState) -> Result<Option<Client>, String> {
    let telegram_state = nas_state.telegram.as_ref();

    let current_client = {
        let guard = telegram_state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = current_client {
        match client.is_authorized().await {
            Ok(true) => return Ok(Some(client)),
            Ok(false) => {
                log::warn!("Telegram stream client exists but is not authorized; reconnecting");
                clear_runtime_client_inner(telegram_state).await;
            }
            Err(err) => {
                log::warn!(
                    "Telegram stream client connection check failed; reconnecting: {}",
                    err
                );
                clear_runtime_client_inner(telegram_state).await;
            }
        }
    }

    let api_id = match *telegram_state.api_id.lock().await {
        Some(api_id) => api_id,
        None => {
            let encrypted_api_id = match nas_state.db.get_secret("owner_api_id".to_string()).await?
            {
                Some(value) => value,
                None => return Ok(None),
            };
            let api_id = decrypt_secret(&encrypted_api_id, nas_state.master_key.as_ref())
                .map_err(owner_secret_decrypt_error)?
                .parse::<i32>()
                .map_err(|_| "Telegram API ID is invalid".to_string())?;
            *telegram_state.api_id.lock().await = Some(api_id);
            api_id
        }
    };

    let session_path = telegram_state.session_path.lock().await.clone();
    let session_file_exists = session_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);

    let client = ensure_client_initialized_inner(telegram_state, api_id).await?;
    match client.is_authorized().await {
        Ok(true) => Ok(Some(client)),
        Ok(false) => {
            match session_path {
                Some(path) if session_file_exists => log::error!(
                    "Owner Telegram session file exists at {} but is not authorized. Admin must complete Telegram login again.",
                    path.display()
                ),
                Some(path) => log::error!(
                    "Owner Telegram session file is missing at {}. Admin must complete Telegram login.",
                    path.display()
                ),
                None => log::error!(
                    "Owner Telegram session path is not configured. Admin must complete Telegram setup."
                ),
            }
            clear_runtime_client_inner(telegram_state).await;
            Ok(None)
        }
        Err(err) => {
            clear_runtime_client_inner(telegram_state).await;
            Err(format!("Telegram reconnect verification failed: {}", err))
        }
    }
}

pub async fn ensure_owner_client_loaded(nas_state: &NasState) -> Result<Option<Client>, String> {
    let telegram_state = nas_state.telegram.as_ref();

    let current_client = {
        let guard = telegram_state.client.lock().await;
        guard.as_ref().cloned()
    };
    if let Some(client) = current_client {
        return Ok(Some(client));
    }

    let api_id = match *telegram_state.api_id.lock().await {
        Some(api_id) => api_id,
        None => {
            let encrypted_api_id = match nas_state.db.get_secret("owner_api_id".to_string()).await?
            {
                Some(value) => value,
                None => return Ok(None),
            };
            let api_id = decrypt_secret(&encrypted_api_id, nas_state.master_key.as_ref())
                .map_err(owner_secret_decrypt_error)?
                .parse::<i32>()
                .map_err(|_| "Telegram API ID is invalid".to_string())?;
            *telegram_state.api_id.lock().await = Some(api_id);
            api_id
        }
    };

    ensure_client_initialized_inner(telegram_state, api_id)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn cmd_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    api_id: i32,
) -> Result<bool, String> {
    // Store API ID for auto-reconnect
    *state.api_id.lock().await = Some(api_id);
    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;
    match client.is_authorized().await {
        Ok(authorized) => Ok(authorized),
        Err(err) => {
            clear_runtime_client(&state).await;
            Err(format!("Telegram connection check failed: {}", err))
        }
    }
}

#[tauri::command]
pub async fn cmd_check_connection(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 1. Check if client exists and is responsive
    let client_msg_opt = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = client_msg_opt {
        match client.is_authorized().await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(err) => {
                clear_runtime_client(&state).await;
                return Err(format!("Telegram connection check failed: {}", err));
            }
        }
        log::warn!("Connection check failed. Attempting reconnect...");
        clear_runtime_client(&state).await;
    } else {
        log::warn!("Connection check: No client found. Checking for saved API ID...");
    }

    // 2. Reconnect Logic
    let api_id_opt = *state.api_id.lock().await;
    if let Some(api_id) = api_id_opt {
        // Force re-init: Clear old client first to ensure fresh pool
        *state.client.lock().await = None;

        match ensure_client_initialized(&app_handle, &state, api_id).await {
            Ok(c) => match c.is_authorized().await {
                Ok(true) => {
                    log::info!("Auto-reconnect successful.");
                    return Ok(true);
                }
                Ok(false) => {
                    clear_runtime_client(&state).await;
                    return Ok(false);
                }
                Err(err) => {
                    clear_runtime_client(&state).await;
                    return Err(format!("Reconnect verification failed: {}", err));
                }
            },
            Err(e) => {
                clear_runtime_client(&state).await;
                return Err(format!("Auto-reconnect failed: {}", e));
            }
        }
    }

    Ok(false) // Not connected and no credentials to reconnect
}

#[derive(Debug, Serialize)]
pub struct OwnerSessionStatus {
    configured: bool,
    connected: bool,
    api_id: Option<String>,
    error: Option<String>,
}

pub async fn owner_session_status_inner(
    nas_state: &NasState,
) -> Result<OwnerSessionStatus, String> {
    let configured = nas_state
        .db
        .get_secret("owner_api_id".to_string())
        .await?
        .is_some()
        && nas_state
            .db
            .get_secret("owner_api_hash".to_string())
            .await?
            .is_some();

    if !configured {
        return Ok(OwnerSessionStatus {
            configured,
            connected: false,
            api_id: None,
            error: None,
        });
    }

    let encrypted_api_id = nas_state.db.get_secret("owner_api_id".to_string()).await?;

    let current_client = {
        let guard = nas_state.telegram.client.lock().await;
        guard.as_ref().cloned()
    };
    if let Some(client) = current_client {
        if client.is_authorized().await.unwrap_or(false) {
            let api_id = encrypted_api_id
                .as_ref()
                .and_then(|value| decrypt_secret(value, nas_state.master_key.as_ref()).ok());
            return Ok(OwnerSessionStatus {
                configured,
                connected: true,
                api_id,
                error: None,
            });
        }
    }

    let api_id = match encrypted_api_id.as_ref() {
        Some(value) => match decrypt_secret(value, nas_state.master_key.as_ref()) {
            Ok(api_id) => Some(api_id),
            Err(err) => {
                return Ok(OwnerSessionStatus {
                    configured,
                    connected: false,
                    api_id: None,
                    error: Some(owner_secret_decrypt_error(err)),
                })
            }
        },
        None => None,
    };

    match timeout(Duration::from_secs(25), ensure_owner_client_connected(nas_state)).await {
        Ok(Ok(Some(_))) => Ok(OwnerSessionStatus {
            configured,
            connected: true,
            api_id,
            error: None,
        }),
        Ok(Ok(None)) => Ok(OwnerSessionStatus {
            configured,
            connected: false,
            api_id,
            error: Some(
                "Owner Telegram session is not authorized. Open Owner Session and complete Telegram login again."
                    .to_string(),
            ),
        }),
        Ok(Err(err)) => Ok(OwnerSessionStatus {
            configured,
            connected: false,
            api_id,
            error: Some(format!("Telegram owner reconnect failed: {}", err)),
        }),
        Err(_) => Ok(OwnerSessionStatus {
            configured,
            connected: false,
            api_id,
            error: Some(
                "Telegram owner reconnect timed out. The saved session may still be loading; try Sync or check backend logs before requesting a new login code."
                    .to_string(),
            ),
        }),
    }
}

#[tauri::command]
pub async fn cmd_owner_session_status(
    _app_handle: tauri::AppHandle,
    _telegram_state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<OwnerSessionStatus, String> {
    owner_session_status_inner(nas_state.inner()).await
}

#[tauri::command]
pub async fn cmd_logout(
    _app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    logout_inner(state.inner()).await
}

pub async fn logout_inner(state: &TelegramState) -> Result<bool, String> {
    log::info!("Logging out...");

    // 1. Shutdown the network runner FIRST to prevent any operations
    let _init_guard = state.init_lock.lock().await;

    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for logout...");
            let _ = shutdown_tx.send(());
        }
    }

    // 2. Try to sign out from Telegram (if connected)
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        // We don't strictly care if this fails (e.g. network down), we just want to clear local state.
        let _ = client.sign_out().await;
    }

    // 3. Clear State
    *state.client.lock().await = None;
    *state.login_token.lock().await = None;
    *state.password_token.lock().await = None;
    *state.api_id.lock().await = None;
    if let Some(path) = state.session_path.lock().await.clone() {
        EncryptedSession::clear_file(&path)?;
    }
    crate::commands::utils::clear_peer_cache(&state.peer_cache).await;

    log::info!(
        "Logout complete. Runner count: {}",
        state.runner_count.load(Ordering::SeqCst)
    );
    Ok(true)
}

pub async fn request_code_inner(
    state: &TelegramState,
    phone: String,
    api_id: i32,
    api_hash: String,
) -> Result<String, String> {
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    clear_runtime_client_inner(state).await;
    *state.api_id.lock().await = Some(api_id);

    let client_handle = match timeout(
        Duration::from_secs(20),
        ensure_client_initialized_inner(state, api_id),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => return Err(
            "Telegram client initialization timed out. Restart the backend service and try again."
                .to_string(),
        ),
    };

    log::info!("Requesting code for {}", phone);

    let mut last_error = String::new();

    for i in 1..=2 {
        match timeout(
            Duration::from_secs(45),
            client_handle.request_login_code(&phone, &api_hash),
        )
        .await
        {
            Ok(Ok(token)) => {
                let mut token_guard = state.login_token.lock().await;
                *token_guard = Some(token);
                return Ok("code_sent".to_string());
            }
            Ok(Err(e)) => {
                let err_msg = e.to_string();
                log::warn!("Error requesting code (Attempt {}): {}", i, err_msg);

                if err_msg.contains("CONNECTION_API_ID_INVALID") {
                    clear_runtime_client_inner(state).await;
                    return Err("Telegram API ID is invalid. Check that TELEGRAM_API_ID and TELEGRAM_API_HASH are from the same app on my.telegram.org, then kill the old Telegram session and request a new code.".to_string());
                }

                if err_msg.contains("AUTH_RESTART") || err_msg.contains("500") {
                    log::info!("AUTH_RESTART error detected. Retrying...");
                    last_error = err_msg;
                    continue;
                }

                return Err(map_error(e));
            }
            Err(_) => {
                log::warn!(
                    "Telegram login code request timed out after 45 seconds (Attempt {})",
                    i
                );
                last_error = "Telegram login code request timed out. Check Pi internet access, Telegram connectivity, API ID/hash, and server logs.".to_string();
            }
        }
    }

    Err(format!("Telegram Error after retry: {}", last_error))
}

#[tauri::command]
pub async fn cmd_auth_request_code(
    app_handle: tauri::AppHandle,
    phone: String,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    let _ = app_handle;
    request_code_inner(state.inner(), phone, api_id, api_hash).await
}

pub async fn request_owner_code_inner(
    nas_state: &NasState,
    phone: String,
) -> Result<String, String> {
    let encrypted_api_id = nas_state
        .db
        .get_secret("owner_api_id".to_string())
        .await?
        .ok_or("Telegram API ID is not configured")?;
    let encrypted_api_hash = nas_state
        .db
        .get_secret("owner_api_hash".to_string())
        .await?
        .ok_or("Telegram API Hash is not configured")?;

    let api_id = decrypt_secret(&encrypted_api_id, nas_state.master_key.as_ref())
        .map_err(owner_secret_decrypt_error)?
        .parse::<i32>()
        .map_err(|_| "Telegram API ID is invalid".to_string())?;
    let api_hash = decrypt_secret(&encrypted_api_hash, nas_state.master_key.as_ref())
        .map_err(owner_secret_decrypt_error)?;

    request_code_inner(nas_state.telegram.as_ref(), phone, api_id, api_hash).await
}

#[tauri::command]
pub async fn cmd_auth_request_owner_code(
    app_handle: tauri::AppHandle,
    phone: String,
    telegram_state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<String, String> {
    let _ = (app_handle, telegram_state);
    request_owner_code_inner(nas_state.inner(), phone).await
}

pub async fn sign_in_inner(state: &TelegramState, code: String) -> Result<AuthResult, String> {
    log::info!("Signing in with code...");

    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let token_guard = state.login_token.lock().await;
    let login_token = token_guard
        .as_ref()
        .ok_or("No login session found (restart flow)")?;

    match client.sign_in(login_token, &code).await {
        Ok(_user) => {
            drop(token_guard);
            *state.login_token.lock().await = None;

            match client.is_authorized().await {
                Ok(true) => {
                    let _ = client.get_me().await;
                    log::info!("Successfully logged in.");
                    Ok(AuthResult {
                        success: true,
                        next_step: Some("dashboard".to_string()),
                        error: None,
                    })
                }
                Ok(false) => {
                    clear_runtime_client_inner(state).await;
                    Err("Telegram accepted the code but the session is not authorized yet. Try requesting a new code.".to_string())
                }
                Err(err) => {
                    clear_runtime_client_inner(state).await;
                    Err(format!("Telegram login verification failed: {}", err))
                }
            }
        }
        Err(SignInError::PasswordRequired(token)) => {
            let mut pw_guard = state.password_token.lock().await;
            *pw_guard = Some(token);

            Ok(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Err(e) => {
            log::error!("Sign in error: {}", e);
            Err(format!("Sign in failed: {}", map_error(e)))
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_sign_in(
    code: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    sign_in_inner(state.inner(), code).await
}

pub async fn check_password_inner(
    state: &TelegramState,
    password: String,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let mut pw_guard = state.password_token.lock().await;
    let pw_token = pw_guard.take().ok_or("No password session found")?;

    match client.check_password(pw_token, password.as_str()).await {
        Ok(_user) => match client.is_authorized().await {
            Ok(true) => {
                let _ = client.get_me().await;
                log::info!("2FA Success.");
                Ok(AuthResult {
                    success: true,
                    next_step: Some("dashboard".to_string()),
                    error: None,
                })
            }
            Ok(false) => {
                clear_runtime_client_inner(state).await;
                Err("Telegram accepted the password but the session is not authorized yet. Try requesting a new code.".to_string())
            }
            Err(err) => {
                clear_runtime_client_inner(state).await;
                Err(format!("Telegram login verification failed: {}", err))
            }
        },
        Err(e) => Err(format!("2FA Failed: {}", map_error(e))),
    }
}

#[tauri::command]
pub async fn cmd_auth_check_password(
    password: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    check_password_inner(state.inner(), password).await
}
