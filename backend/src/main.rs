use std::path::PathBuf;
use std::sync::Arc;

use app_lib::nas::state::NasState;

const DEFAULT_API_HOST: &str = "127.0.0.1";
const DEFAULT_API_PORT: u16 = 14201;

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

fn data_dir() -> PathBuf {
    std::env::var("TELEGRAM_DRIVE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".data"))
}

fn generate_stream_token() -> String {
    use rand::Rng;

    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn main() -> std::io::Result<()> {
    app_lib::load_backend_env();
    let _ = env_logger::try_init();

    let host = api_host();
    let port = api_port();
    let api_base_url = api_base_url(&host, port);
    let stream_token = generate_stream_token();

    let system = actix_rt::System::new();
    system.block_on(async move {
        let telegram_state = Arc::new(app_lib::new_telegram_state());
        let nas_state = NasState::new(data_dir(), api_base_url, telegram_state)
            .await
            .map_err(std::io::Error::other)?;
        app_lib::seed_owner_config_from_env(&nas_state)
            .await
            .map_err(std::io::Error::other)?;
        app_lib::nas::telegram_queue::start_telegram_job_worker(nas_state.clone());

        let server =
            app_lib::server::start_server(nas_state, host.clone(), port, stream_token).await?;
        println!(
            "Telegram Drive backend API listening on http://{}:{}",
            host, port
        );
        server.await
    })
}
