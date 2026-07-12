use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{map_error, resolve_peer_ref};
use crate::nas::state::{NasState, PreviewDownloadJob};
use crate::TelegramState;
use base64::{engine::general_purpose, Engine as _};
use grammers_client::types::Media;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tauri::State;
use uuid::Uuid;

const LOCAL_PREVIEW_CHUNK_SIZE: i32 = 512 * 1024;
const LOCAL_PREVIEW_TAIL_BYTES: u64 = 8 * 1024 * 1024;

const PREVIEW_CACHE_MAX_FILES: usize = 30;
const PREVIEW_CACHE_MAX_TOTAL_BYTES: u64 = 80 * 1024 * 1024;

fn prune_preview_cache(cache_dir: &std::path::Path) {
    let read_dir = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((path, modified, meta.len()));
        }
    }
    files.sort_by_key(|(_, modified, _)| *modified);
    let mut total_bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
    while files.len() > PREVIEW_CACHE_MAX_FILES || total_bytes > PREVIEW_CACHE_MAX_TOTAL_BYTES {
        if let Some((path, _, len)) = files.first().cloned() {
            let _ = std::fs::remove_file(&path);
            total_bytes = total_bytes.saturating_sub(len);
            files.remove(0);
        } else {
            break;
        }
    }
}

fn sanitize_preview_name(name: &str) -> String {
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
        "preview.bin".to_string()
    } else {
        sanitized
    }
}

fn preview_file_name(media: &Media, fallback: &str) -> String {
    match media {
        Media::Document(d) => {
            let name = d.name();
            if name.trim().is_empty() {
                fallback.to_string()
            } else {
                name.to_string()
            }
        }
        Media::Photo(_) => fallback.to_string(),
        _ => fallback.to_string(),
    }
}

fn preview_mime_type(media: &Media, name: &str) -> String {
    match media {
        Media::Document(d) => {
            let telegram_mime = d.mime_type().unwrap_or("application/octet-stream");
            if telegram_mime != "application/octet-stream" {
                return telegram_mime.to_string();
            }

            match name.to_lowercase().rsplit_once('.').map(|(_, ext)| ext) {
                Some("mp4") => "video/mp4",
                Some("webm") => "video/webm",
                Some("mov") => "video/quicktime",
                Some("m4v") => "video/x-m4v",
                Some("mp3") => "audio/mpeg",
                Some("m4a") => "audio/mp4",
                Some("wav") => "audio/wav",
                Some("ogg") => "audio/ogg",
                Some("pdf") => "application/pdf",
                _ => "application/octet-stream",
            }
            .to_string()
        }
        Media::Photo(_) => "image/jpeg".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

async fn remove_preview_file_with_retry(path: std::path::PathBuf) {
    for _ in 0..20 {
        match std::fs::remove_file(&path) {
            Ok(()) => return,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
        }
    }

    if let Err(err) = std::fs::remove_file(&path) {
        log::warn!(
            "Failed to remove local preview file {}: {}",
            path.display(),
            err
        );
    }
}

#[derive(serde::Serialize)]
pub struct LocalPreviewInfo {
    id: String,
    file_path: String,
    tail_path: Option<String>,
    tail_start: Option<u64>,
    file_name: String,
    mime_type: String,
    size: u64,
}

#[derive(serde::Serialize)]
pub struct LocalPreviewStatus {
    downloaded: u64,
    size: u64,
    complete: bool,
    cancelled: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_start_local_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    nas_state: State<'_, NasState>,
) -> Result<LocalPreviewInfo, String> {
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Telegram client is not connected".to_string())?;
    let read_gate = state.read_gate.clone();
    let _read_permit = read_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Telegram read limiter is unavailable".to_string())?;

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(map_error)?;
    drop(_read_permit);
    let msg = messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;
    let media = msg
        .media()
        .ok_or_else(|| "Message has no media".to_string())?;

    let total_size = match &media {
        Media::Document(d) => d.size() as u64,
        Media::Photo(_) => 0,
        _ => 0,
    };
    if total_size == 0 {
        return Err("Media size is not available".to_string());
    }

    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("local-previews");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let file_name = sanitize_preview_name(&preview_file_name(
        &media,
        &format!("preview-{}.bin", message_id),
    ));
    let mime_type = preview_mime_type(&media, &file_name);
    let save_path = cache_dir.join(format!("{}-{}", id, file_name));
    let should_prefetch_tail =
        mime_type.starts_with("video/") && total_size > LOCAL_PREVIEW_TAIL_BYTES;
    let tail_start = should_prefetch_tail.then(|| {
        let raw_start = total_size.saturating_sub(LOCAL_PREVIEW_TAIL_BYTES);
        let chunk_size = LOCAL_PREVIEW_CHUNK_SIZE as u64;
        (raw_start / chunk_size) * chunk_size
    });
    let tail_path = tail_start.map(|_| cache_dir.join(format!("{}-tail-{}", id, file_name)));

    let downloaded = Arc::new(AtomicU64::new(0));
    let tail_downloaded = Arc::new(AtomicU64::new(0));
    let complete = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let error = Arc::new(tokio::sync::Mutex::new(None));

    let job = PreviewDownloadJob {
        path: save_path.clone(),
        tail_path: tail_path.clone(),
        file_name: file_name.clone(),
        mime_type: mime_type.clone(),
        total_size,
        downloaded: downloaded.clone(),
        tail_downloaded: tail_downloaded.clone(),
        complete: complete.clone(),
        cancelled: cancelled.clone(),
        error: error.clone(),
    };

    nas_state
        .preview_downloads
        .lock()
        .await
        .insert(id.clone(), job);

    let tail_download_path = tail_path.clone();
    if let (Some(tail_start), Some(tail_path_for_task)) = (tail_start, tail_download_path) {
        let tail_client = client.clone();
        let tail_media = media.clone();
        let tail_cancelled = cancelled.clone();
        let tail_error = error.clone();
        let tail_downloaded = tail_downloaded.clone();
        let tail_read_gate = read_gate.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let _read_permit = tail_read_gate
                    .acquire_owned()
                    .await
                    .map_err(|_| "Telegram read limiter is unavailable".to_string())?;
                let mut file =
                    std::fs::File::create(&tail_path_for_task).map_err(|e| e.to_string())?;
                let chunk_size = LOCAL_PREVIEW_CHUNK_SIZE as u64;
                let skip_chunks = (tail_start / chunk_size) as i32;
                let mut remaining = total_size.saturating_sub(tail_start);
                let mut download_iter = tail_client
                    .iter_download(&tail_media)
                    .chunk_size(LOCAL_PREVIEW_CHUNK_SIZE)
                    .skip_chunks(skip_chunks);

                while remaining > 0 {
                    if tail_cancelled.load(Ordering::SeqCst) {
                        break;
                    }

                    let Some(chunk_result) = download_iter.next().await.transpose() else {
                        break;
                    };
                    let mut bytes = chunk_result
                        .map_err(|e| format!("Preview tail download chunk failed: {}", e))?;
                    if bytes.len() as u64 > remaining {
                        bytes.truncate(remaining as usize);
                    }
                    file.write_all(&bytes).map_err(|e| e.to_string())?;
                    tail_downloaded.fetch_add(bytes.len() as u64, Ordering::SeqCst);
                    remaining = remaining.saturating_sub(bytes.len() as u64);
                }

                file.flush().map_err(|e| e.to_string())?;
                Ok::<(), String>(())
            }
            .await;

            if let Err(err) = result {
                *tail_error.lock().await = Some(err);
            }

            if tail_cancelled.load(Ordering::SeqCst) {
                remove_preview_file_with_retry(tail_path_for_task).await;
            }
        });
    }

    let download_path = save_path.clone();
    let download_read_gate = read_gate.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let _read_permit = download_read_gate
                .acquire_owned()
                .await
                .map_err(|_| "Telegram read limiter is unavailable".to_string())?;
            let mut file = std::fs::File::create(&download_path).map_err(|e| e.to_string())?;
            let mut download_iter = client
                .iter_download(&media)
                .chunk_size(LOCAL_PREVIEW_CHUNK_SIZE);

            while let Some(chunk_result) = download_iter.next().await.transpose() {
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }

                let bytes =
                    chunk_result.map_err(|e| format!("Preview download chunk failed: {}", e))?;
                file.write_all(&bytes).map_err(|e| e.to_string())?;
                downloaded.fetch_add(bytes.len() as u64, Ordering::SeqCst);
            }

            file.flush().map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        }
        .await;

        match result {
            Ok(()) => complete.store(true, Ordering::SeqCst),
            Err(err) => {
                *error.lock().await = Some(err);
                complete.store(true, Ordering::SeqCst);
            }
        }

        if cancelled.load(Ordering::SeqCst) {
            remove_preview_file_with_retry(download_path).await;
        }
    });

    Ok(LocalPreviewInfo {
        id,
        file_path: save_path.to_string_lossy().to_string(),
        tail_path: tail_path.map(|path| path.to_string_lossy().to_string()),
        tail_start,
        file_name,
        mime_type,
        size: total_size,
    })
}

#[tauri::command]
pub async fn cmd_get_local_preview_status(
    preview_id: String,
    nas_state: State<'_, NasState>,
) -> Result<Option<LocalPreviewStatus>, String> {
    let job = {
        let guard = nas_state.preview_downloads.lock().await;
        guard.get(&preview_id).cloned()
    };

    let Some(job) = job else {
        return Ok(None);
    };
    let error = job.error.lock().await.clone();

    Ok(Some(LocalPreviewStatus {
        downloaded: job
            .downloaded
            .load(Ordering::SeqCst)
            .saturating_add(job.tail_downloaded.load(Ordering::SeqCst))
            .min(job.total_size),
        size: job.total_size,
        complete: job.complete.load(Ordering::SeqCst),
        cancelled: job.cancelled.load(Ordering::SeqCst),
        error,
    }))
}

#[tauri::command]
pub async fn cmd_cancel_local_preview(
    preview_id: String,
    nas_state: State<'_, NasState>,
) -> Result<(), String> {
    let job = nas_state.preview_downloads.lock().await.remove(&preview_id);
    if let Some(job) = job {
        job.cancelled.store(true, Ordering::SeqCst);
        tauri::async_runtime::spawn(remove_preview_file_with_retry(job.path));
        if let Some(tail_path) = job.tail_path {
            tauri::async_runtime::spawn(remove_preview_file_with_retry(tail_path));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }
    prune_preview_cache(&cache_dir);
    log::info!("Using preview cache dir: {:?}", cache_dir);
    log::info!("Preview Request: msg_id={}", message_id);
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.unwrap();
    let _read_permit = state
        .read_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Telegram read limiter is unavailable".to_string())?;

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(map_error)?;
    let target_message = messages.into_iter().flatten().next();

    if let Some(msg) = target_message {
        if let Some(media) = msg.media() {
            let ext = match &media {
                Media::Document(d) => {
                    let mut e = std::path::Path::new(d.name())
                        .extension()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if e.is_empty() {
                        if let Some(mime) = d.mime_type() {
                            e = match mime {
                                "image/jpeg" => "jpg".to_string(),
                                "image/png" => "png".to_string(),
                                "video/mp4" => "mp4".to_string(),
                                _ => "bin".to_string(),
                            };
                        } else {
                            e = "bin".to_string();
                        }
                    }
                    e
                }
                Media::Photo(_) => "jpg".to_string(),
                _ => "bin".to_string(),
            };
            let folder_key = folder_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "home".to_string());
            let save_path = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
            let save_path_str = save_path.to_string_lossy().to_string();

            let file_ready = if save_path.exists() {
                log::info!("File ({}) exists in cache.", message_id);
                true
            } else {
                let size = match &media {
                    Media::Document(d) => d.size() as u64,
                    Media::Photo(_) => 1024 * 1024,
                    _ => 0,
                };
                log::info!("Downloading preview... Size: {}", size);
                if let Err(e) = bw_state.can_transfer(size) {
                    log::warn!("Bandwidth limit hit for preview: {}", e);
                    false
                } else {
                    match client.download_media(&media, &save_path_str).await {
                        Ok(_) => {
                            log::info!("Preview download complete.");
                            bw_state.add_down(size);
                            prune_preview_cache(&cache_dir);
                            true
                        }
                        Err(e) => {
                            log::error!("Preview Download Error: {}", e);
                            false
                        }
                    }
                }
            };
            if file_ready {
                let lower_ext = ext.to_lowercase();
                if ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].contains(&lower_ext.as_str())
                {
                    log::info!("Converting image to Base64...");
                    match std::fs::read(&save_path) {
                        Ok(bytes) => {
                            let b64 = general_purpose::STANDARD.encode(&bytes);
                            let mime = match lower_ext.as_str() {
                                "png" => "image/png",
                                "gif" => "image/gif",
                                "webp" => "image/webp",
                                "bmp" => "image/bmp",
                                "svg" => "image/svg+xml",
                                _ => "image/jpeg",
                            };
                            return Ok(format!("data:{};base64,{}", mime, b64));
                        }
                        Err(e) => {
                            log::error!("Failed to read file for base64: {}", e);
                            return Ok(save_path_str);
                        }
                    }
                }
                log::info!("Returning path preview: {}", save_path_str);
                return Ok(save_path_str);
            }
        } else {
            let text = msg.text();
            if !text.trim().is_empty() {
                let b64 = general_purpose::STANDARD.encode(text.as_bytes());
                return Ok(format!("data:text/plain;base64,{}", b64));
            }
        }
    }
    Err("File not found or failed to download".to_string())
}

#[tauri::command]
pub async fn cmd_clean_cache(app_handle: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    if cache_dir.exists() {
        let _ = std::fs::remove_dir_all(cache_dir);
    }
    Ok(())
}

/// Get a small thumbnail for inline display in file cards.
/// Returns base64 data URL for images, empty string for non-image files.
/// Uses same cache as cmd_get_preview for consistency.
#[tauri::command]
pub async fn cmd_get_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    // Check if thumbnail already in cache
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }

    // Check for any cached thumbnail for this message
    // Look for existing cached file
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{}.", message_id)) {
                // Found cached thumbnail, return as base64
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    let ext = name.rsplit('.').next().unwrap_or("jpg");
                    let mime = match ext {
                        "png" => "image/png",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
                        _ => "image/jpeg",
                    };
                    let b64 = general_purpose::STANDARD.encode(&bytes);
                    return Ok(format!("data:{};base64,{}", mime, b64));
                }
            }
        }
    }

    // No cache, need to fetch from Telegram
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.unwrap();
    let _read_permit = state
        .read_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Telegram read limiter is unavailable".to_string())?;

    let peer = resolve_peer_ref(&client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(map_error)?;
    if let Some(m) = messages.into_iter().flatten().next() {
        if let Some(media) = m.media() {
            // Only get thumbnails for photos and documents with photo thumbnails
            let (is_image, ext) = match &media {
                Media::Photo(_) => (true, "jpg".to_string()),
                Media::Document(d) => {
                    let mime = d.mime_type().unwrap_or("");
                    if mime.starts_with("image/") {
                        let e = match mime {
                            "image/png" => "png",
                            "image/gif" => "gif",
                            "image/webp" => "webp",
                            _ => "jpg",
                        };
                        (true, e.to_string())
                    } else {
                        // Not an image, return empty - FileCard will show icon
                        return Ok("".to_string());
                    }
                }
                _ => return Ok("".to_string()),
            };

            if is_image {
                // Get photo thumbnail (smallest size for speed)
                let save_path = cache_dir.join(format!("{}.{}", message_id, ext));
                let save_path_str = save_path.to_string_lossy().to_string();

                // Download the thumbnail/photo
                if client.download_media(&media, &save_path_str).await.is_ok() {
                    if let Ok(bytes) = std::fs::read(&save_path) {
                        let mime = match ext.as_str() {
                            "png" => "image/png",
                            "gif" => "image/gif",
                            "webp" => "image/webp",
                            _ => "image/jpeg",
                        };
                        let b64 = general_purpose::STANDARD.encode(&bytes);
                        return Ok(format!("data:{};base64,{}", mime, b64));
                    }
                }
            }
        }
    }

    Ok("".to_string())
}
