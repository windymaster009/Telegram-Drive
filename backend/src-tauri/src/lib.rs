pub mod models;
pub mod nas;

pub mod bandwidth;
pub mod commands;

use commands::streaming::StreamConfig;
use commands::TelegramState;
use nas::state::NasState;
use rand::Rng;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub mod server;

const DEFAULT_API_HOST: &str = "127.0.0.1";
const DEFAULT_API_PORT: u16 = 14201;

pub fn load_backend_env() {
    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(".env"));
        candidates.push(current_dir.join("backend").join(".env"));
        candidates.push(current_dir.join("..").join(".env"));
    }
    candidates.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".env"),
    );

    let Some(content) = candidates
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
    else {
        return;
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        std::env::set_var(key, value);
    }
}

fn api_host() -> String {
    std::env::var("TELEGRAM_DRIVE_API_HOST").unwrap_or_else(|_| DEFAULT_API_HOST.to_string())
}

fn api_port() -> u16 {
    std::env::var("TELEGRAM_DRIVE_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_API_PORT)
}

fn api_base_url(host: &str, port: u16) -> String {
    std::env::var("TELEGRAM_DRIVE_PUBLIC_API_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("http://{}:{}", host, port))
}

fn use_external_backend() -> bool {
    std::env::var("TELEGRAM_DRIVE_EXTERNAL_BACKEND")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(cfg!(mobile) || !cfg!(debug_assertions))
}

fn configured_data_dir(default_dir: std::path::PathBuf) -> std::path::PathBuf {
    let Some(value) = std::env::var("TELEGRAM_DRIVE_DATA_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return default_dir;
    };

    let path = std::path::PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(path)
    }
}

fn telegram_api_id_from_env() -> Option<String> {
    std::env::var("TELEGRAM_API_ID")
        .or_else(|_| std::env::var("APP_API_ID"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn telegram_api_hash_from_env() -> Option<String> {
    std::env::var("TELEGRAM_API_HASH")
        .or_else(|_| std::env::var("APP_API_HASH"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub async fn seed_owner_config_from_env(state: &NasState) -> Result<(), String> {
    let Some(api_id) = telegram_api_id_from_env() else {
        return Ok(());
    };
    let Some(api_hash) = telegram_api_hash_from_env() else {
        return Ok(());
    };

    let encrypted_api_id = nas::crypto::encrypt_secret(&api_id, state.master_key.as_ref())?;
    let encrypted_api_hash = nas::crypto::encrypt_secret(&api_hash, state.master_key.as_ref())?;
    state
        .db
        .store_secret("owner_api_id".to_string(), encrypted_api_id)
        .await?;
    state
        .db
        .store_secret("owner_api_hash".to_string(), encrypted_api_hash)
        .await?;

    if let Ok(parsed_api_id) = api_id.parse::<i32>() {
        *state.telegram.api_id.lock().await = Some(parsed_api_id);
    }

    Ok(())
}

pub fn new_telegram_state() -> TelegramState {
    TelegramState {
        client: Arc::new(Mutex::new(None)),
        init_lock: Arc::new(Mutex::new(())),
        login_token: Arc::new(Mutex::new(None)),
        password_token: Arc::new(Mutex::new(None)),
        api_id: Arc::new(Mutex::new(None)),
        session_encryption_key: Arc::new(Mutex::new(None)),
        session_path: Arc::new(Mutex::new(None)),
        runner_shutdown: Arc::new(std::sync::Mutex::new(None)),
        runner_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        peer_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
    }
}

/// Generate a random 32-character hex token for streaming server auth
fn generate_stream_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Holds the Actix-web server stop handle so we can shut it down
/// from the RunEvent::Exit handler for graceful Ctrl+C termination.
pub struct ActixServerHandle(pub Arc<std::sync::Mutex<Option<actix_web::dev::ServerHandle>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_backend_env();
    env_logger::init();

    let stream_token = generate_stream_token();

    // Shared handle for stopping the Actix server during shutdown
    let server_handle: Arc<std::sync::Mutex<Option<actix_web::dev::ServerHandle>>> =
        Arc::new(std::sync::Mutex::new(None));
    let server_handle_for_setup = server_handle.clone();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    let app = builder
        .setup(move |app| {
            let telegram_state = new_telegram_state();
            let telegram_state_arc = Arc::new(telegram_state.clone());
            let api_host = api_host();
            let api_port = api_port();
            app.manage(telegram_state);
            app.manage(bandwidth::BandwidthManager::new(app.handle()));
            app.manage(StreamConfig {
                token: stream_token.clone(),
                host: api_host.clone(),
                port: api_port,
            });
            app.manage(ActixServerHandle(server_handle_for_setup.clone()));

            if use_external_backend() {
                log::info!("Using external API; skipping embedded backend startup.");
                return Ok(());
            }

            let app_data_dir =
                configured_data_dir(app.path().app_data_dir().map_err(|err| err.to_string())?);
            log::info!(
                "Using Telegram Drive data directory: {}",
                app_data_dir.display()
            );
            let api_base_url = api_base_url(&api_host, api_port);
            let nas_state = tauri::async_runtime::block_on(NasState::new(
                app_data_dir.clone(),
                api_base_url,
                telegram_state_arc.clone(),
            ))?;
            tauri::async_runtime::block_on(seed_owner_config_from_env(&nas_state))?;
            app.manage(nas_state.clone());
            nas::telegram_queue::start_telegram_job_worker(nas_state.clone());

            let nas_state_for_reconnect = nas_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(Some(encrypted_api_id)) = nas_state_for_reconnect
                    .db
                    .get_secret("owner_api_id".to_string())
                    .await
                {
                    if let Ok(api_id_str) = nas::crypto::decrypt_secret(
                        &encrypted_api_id,
                        nas_state_for_reconnect.master_key.as_ref(),
                    ) {
                        if let Ok(api_id) = api_id_str.parse::<i32>() {
                            *nas_state_for_reconnect.telegram.api_id.lock().await = Some(api_id);
                        }
                    }
                }

                match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    commands::auth::ensure_owner_client_loaded(&nas_state_for_reconnect),
                )
                .await
                {
                    Ok(Ok(Some(_))) => log::info!("Owner Telegram client preloaded for previews."),
                    Ok(Ok(None)) => {
                        log::info!("Owner Telegram client preload skipped; setup is incomplete.")
                    }
                    Ok(Err(err)) => log::warn!("Owner Telegram client preload failed: {}", err),
                    Err(_) => log::warn!("Owner Telegram client preload timed out."),
                }
            });

            // Start Streaming Server on dedicated thread (Actix needs its own runtime)
            let nas_state_for_server = nas_state.clone();
            let token_for_server = stream_token.clone();
            let handle_for_thread = server_handle_for_setup.clone();
            std::thread::spawn(move || {
                let sys = actix_rt::System::new();
                sys.block_on(async move {
                    match server::start_server(
                        nas_state_for_server,
                        api_host,
                        api_port,
                        token_for_server,
                    )
                    .await
                    {
                        Ok(server) => {
                            // Store the handle so RunEvent::Exit can stop it
                            *handle_for_thread.lock().unwrap() = Some(server.handle());
                            // Now await the server — blocks until stopped
                            server.await.ok();
                        }
                        Err(e) => log::error!("Streaming server failed: {}", e),
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_auth_request_code,
            commands::cmd_auth_request_owner_code,
            commands::cmd_auth_sign_in,
            commands::cmd_auth_check_password,
            commands::cmd_owner_session_status,
            commands::cmd_get_files,
            commands::cmd_upload_file,
            commands::cmd_upload_file_to_api,
            commands::cmd_download_file_from_api,
            commands::cmd_connect,
            commands::cmd_log,
            commands::cmd_delete_file,
            commands::cmd_download_file,
            commands::cmd_move_files,
            commands::cmd_copy_files,
            commands::cmd_create_folder,
            commands::cmd_delete_folder,
            commands::cmd_rename_folder,
            commands::cmd_set_folder_icon,
            commands::cmd_set_folder_password,
            commands::cmd_verify_folder_password,
            commands::cmd_get_bandwidth,
            commands::cmd_get_preview,
            commands::cmd_logout,
            commands::cmd_scan_folders,
            commands::cmd_search_global,
            commands::cmd_check_connection,
            commands::cmd_is_network_available,
            commands::cmd_get_lan_ip,
            commands::cmd_clean_cache,
            commands::cmd_get_thumbnail,
            commands::cmd_start_local_preview,
            commands::cmd_get_local_preview_status,
            commands::cmd_cancel_local_preview,
            commands::cmd_get_stream_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            log::info!("Application exiting — shutting down background services...");

            // 1. Shutdown the grammers network runner
            let shutdown_arc = app_handle.state::<TelegramState>().runner_shutdown.clone();
            let runner_tx = shutdown_arc.lock().ok().and_then(|mut g| g.take());
            if let Some(tx) = runner_tx {
                log::info!("Signaling network runner shutdown...");
                let _ = tx.send(());
            }

            // 2. Stop the Actix streaming server (graceful)
            let server_arc = app_handle.state::<ActixServerHandle>().0.clone();
            let server_handle = server_arc.lock().ok().and_then(|mut g| g.take());
            if let Some(handle) = server_handle {
                log::info!("Stopping Actix streaming server...");
                // stop() sends the signal synchronously; the returned future
                // tracks drain completion — we don't need to await it on exit.
                drop(handle.stop(true));
            }
        }
    });
}
