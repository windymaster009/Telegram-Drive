use std::net::{TcpStream, UdpSocket};
use std::time::Duration;

/// Ultra-lightweight network check
/// 
/// Simply tries to connect to Telegram's servers without using grammers.
/// This avoids the stack overflow bug from grammers reconnection logic.
#[tauri::command]
pub async fn cmd_is_network_available() -> Result<bool, String> {
    // Try to connect to Telegram's production DC
    // Using a very short timeout to keep it lightweight
    tokio::task::spawn_blocking(|| {
        // Try connecting to Telegram DC2 (149.154.167.50:443)
        match TcpStream::connect_timeout(
            &"149.154.167.50:443".parse().unwrap(),
            Duration::from_secs(2),
        ) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_get_lan_ip() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|err| err.to_string())?;
        socket.connect("8.8.8.8:80").map_err(|err| err.to_string())?;
        socket
            .local_addr()
            .map(|addr| addr.ip().to_string())
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
