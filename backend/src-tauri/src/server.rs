use crate::commands::utils::resolve_read_peer;
use crate::nas::crypto::now_ts;
use crate::nas::models::ApprovalStatus;
use crate::nas::{api::configure_api, state::NasState};
use actix_cors::Cors;
use actix_web::{
    error::{ErrorBadGateway, ErrorGatewayTimeout},
    http::{header, Method, StatusCode},
    route, web, App, HttpRequest, HttpResponse, HttpServer, Responder,
};
use grammers_client::types::Media;
use std::io::SeekFrom;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::time::{timeout, Duration};

const STREAM_CHUNK_SIZE: i32 = 512 * 1024;
const OWNER_CLIENT_TIMEOUT: Duration = Duration::from_secs(90);
const PEER_RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
const MESSAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_PREVIEW_READ_CHUNK_SIZE: usize = 256 * 1024;
const LOCAL_PREVIEW_MIN_RESPONSE_BYTES: u64 = 1024 * 1024;

/// Holds the per-session streaming token for Actix validation
pub struct StreamTokenData {
    pub token: String,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    token: Option<String>,
    access_token: Option<String>,
}

#[derive(serde::Deserialize)]
struct LocalPreviewQuery {
    token: Option<String>,
    path: String,
    tail_path: Option<String>,
    tail_start: Option<u64>,
    size: u64,
    mime: Option<String>,
}

#[derive(Clone)]
enum LocalPreviewSource {
    Front { path: PathBuf, start_offset: u64 },
    Tail { path: PathBuf, start_offset: u64 },
}

#[route("/stream/{folder_id}/{message_id}", method = "GET", method = "HEAD")]
async fn stream_media(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<NasState>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    stream_media_impl(req, path, query, data, token_data).await
}

#[route(
    "/api/telegram/stream/{folder_id}/{message_id}",
    method = "GET",
    method = "HEAD"
)]
async fn api_stream_media(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<NasState>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    stream_media_impl(req, path, query, data, token_data).await
}

async fn stream_media_impl(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<NasState>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Validate session token. Loopback preview traffic is allowed without matching
    // the per-process token so stale WebView/native server pairs do not break local playback.
    match &query.token {
        Some(t) if t == &token_data.token => {
            log::debug!(
                "Stream request: Token validated successfully for msg {}",
                message_id
            );
        }
        _ if is_loopback_request(&req) => {
            log::debug!(
                "Stream request: Allowing loopback preview request for msg {} with missing/stale token",
                message_id
            );
        }
        _ if authorize_stream_access(&data, query.access_token.as_deref()).await => {
            log::debug!(
                "Stream request: NAS session token validated for msg {}",
                message_id
            );
        }
        _ => {
            log::error!(
                "Stream request failed: Invalid or missing stream token for msg {}",
                message_id
            );
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    // Parse folder ID
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        log::debug!("Stream request: Using root folder for msg {}", message_id);
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => {
                log::debug!(
                    "Stream request: Parsed folder ID {} for msg {}",
                    id,
                    message_id
                );
                Some(id)
            }
            Err(_) => {
                log::error!(
                    "Stream request failed: Invalid folder ID format '{}' for msg {}",
                    folder_id_str,
                    message_id
                );
                return HttpResponse::BadRequest().body("Invalid folder ID");
            }
        }
    };

    let client_opt = match timeout(
        OWNER_CLIENT_TIMEOUT,
        crate::commands::auth::ensure_owner_client_connected(data.get_ref()),
    )
    .await
    {
        Err(_) => {
            log::error!(
                "Stream request failed: Timed out loading Telegram owner client for msg {}",
                message_id
            );
            return HttpResponse::GatewayTimeout().body("Timed out loading Telegram owner client");
        }
        Ok(result) => match result {
            Ok(Some(client)) => Some(client),
            Ok(None) => {
                log::error!(
                    "Stream request failed: Telegram owner session is not connected or authorized for msg {}",
                    message_id
                );
                return HttpResponse::ServiceUnavailable()
                    .body("Telegram owner session is not connected or authorized");
            }
            Err(err) => {
                log::error!(
                    "Stream request failed: Telegram reconnect failed for msg {}: {}",
                    message_id,
                    err
                );
                return HttpResponse::ServiceUnavailable()
                    .body(format!("Telegram reconnect failed: {}", err));
            }
        },
    };

    if let Some(client) = client_opt {
        let read_permit = match data.telegram.read_gate.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                log::error!("Stream request failed: Telegram read limiter is unavailable");
                return HttpResponse::ServiceUnavailable()
                    .body("Telegram read limiter is unavailable");
            }
        };
        log::debug!(
            "Stream request: Client acquired, resolving peer for msg {}...",
            message_id
        );
        match timeout(
            PEER_RESOLVE_TIMEOUT,
            resolve_read_peer(&client, folder_id, &data.telegram.peer_cache),
        )
        .await
        {
            Err(_) => {
                log::error!(
                    "Stream request failed: Peer resolution timed out for msg {}",
                    message_id
                );
                HttpResponse::GatewayTimeout().body("Peer resolution timed out")
            }
            Ok(Ok(resolved_peer)) => {
                log::debug!(
                    "Stream request: Peer resolved for msg {} (saved_messages={}, peer_kind={}, peer_id={:?}), fetching message...",
                    message_id,
                    resolved_peer.is_saved_messages,
                    resolved_peer.peer_kind,
                    resolved_peer.peer_id
                );
                // Try to fetch message efficiently
                match timeout(
                    MESSAGE_FETCH_TIMEOUT,
                    client.get_messages_by_id(resolved_peer.peer_ref, &[message_id]),
                )
                .await
                {
                    Err(_) => {
                        log::error!(
                            "Stream request failed: Fetching message {} timed out",
                            message_id
                        );
                        HttpResponse::GatewayTimeout().body("Fetching message timed out")
                    }
                    Ok(Ok(messages)) => {
                        if let Some(Some(msg)) = messages.first() {
                            if let Some(media) = msg.media() {
                                log::debug!(
                                    "Stream request: Message and media found for msg {}",
                                    message_id
                                );
                                let size = match &media {
                                    Media::Document(d) => d.size(),
                                    Media::Photo(_) => 0,
                                    _ => 0,
                                };

                                let mime = mime_type_from_media(&media);
                                log::debug!("Stream request: Starting download for msg {} (mime: {}, size: {})", message_id, mime, size);

                                if size == 0 {
                                    let mut download_iter =
                                        client.iter_download(&media).chunk_size(STREAM_CHUNK_SIZE);
                                    let read_permit = read_permit;
                                    let stream = async_stream::stream! {
                                        let _read_permit = read_permit;
                                        loop {
                                            match timeout(Duration::from_secs(30), download_iter.next()).await {
                                                Ok(Ok(Some(bytes))) => {
                                                    yield Ok::<_, actix_web::Error>(web::Bytes::from(bytes));
                                                },
                                                Ok(Ok(None)) => break,
                                                Ok(Err(e)) => {
                                                    yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Telegram stream error: {}", e)));
                                                    break;
                                                },
                                                Err(_) => {
                                                    yield Err::<web::Bytes, actix_web::Error>(ErrorGatewayTimeout("Telegram stream timed out"));
                                                    break;
                                                }
                                            }
                                        }
                                    };
                                    let mut response = HttpResponse::Ok();
                                    response
                                        .insert_header(("Content-Type", mime))
                                        .insert_header(("Cache-Control", "private, max-age=120"));
                                    if req.method() == Method::HEAD {
                                        return response.finish();
                                    }
                                    return response.streaming(stream);
                                }

                                let requested_range = req.headers().get(header::RANGE);
                                let range = parse_range(requested_range, size as u64);
                                if requested_range.is_some() && range.is_none() {
                                    return HttpResponse::RangeNotSatisfiable()
                                        .insert_header((
                                            "Content-Range",
                                            format!("bytes */{}", size),
                                        ))
                                        .insert_header(("Accept-Ranges", "bytes"))
                                        .finish();
                                }
                                let (start, end, status) = match range {
                                    Some((start, end)) => (start, end, StatusCode::PARTIAL_CONTENT),
                                    None => (0, size.saturating_sub(1) as u64, StatusCode::OK),
                                };
                                let content_len = end.saturating_sub(start).saturating_add(1);

                                let skip_chunks = (start / STREAM_CHUNK_SIZE as u64) as i32;
                                let skip_bytes = (start % STREAM_CHUNK_SIZE as u64) as usize;
                                let mut remaining = content_len;

                                // Create bounded chunk-streaming response. This never stores the
                                // full video in memory; each yielded item is at most STREAM_CHUNK_SIZE.
                                let mut download_iter = client
                                    .iter_download(&media)
                                    .chunk_size(STREAM_CHUNK_SIZE)
                                    .skip_chunks(skip_chunks);
                                let read_permit = read_permit;
                                let stream = async_stream::stream! {
                                    let _read_permit = read_permit;
                                    let mut chunk_count = 0;
                                    let mut first_chunk = true;
                                    loop {
                                        match timeout(Duration::from_secs(30), download_iter.next()).await {
                                            Ok(Ok(Some(mut bytes))) => {
                                                if first_chunk && skip_bytes > 0 {
                                                    first_chunk = false;
                                                    if skip_bytes >= bytes.len() {
                                                        continue;
                                                    }
                                                    bytes = bytes.split_off(skip_bytes);
                                                } else {
                                                    first_chunk = false;
                                                }

                                                if remaining == 0 {
                                                    break;
                                                }
                                                if bytes.len() as u64 > remaining {
                                                    bytes.truncate(remaining as usize);
                                                }
                                                remaining = remaining.saturating_sub(bytes.len() as u64);

                                                chunk_count += 1;
                                                if chunk_count % 100 == 0 {
                                                    log::debug!("Stream request: Streamed {} chunks for msg {}", chunk_count, message_id);
                                                }
                                                yield Ok::<_, actix_web::Error>(web::Bytes::from(bytes));

                                                if remaining == 0 {
                                                    break;
                                                }
                                            },
                                            Ok(Ok(None)) => break,
                                            Ok(Err(e)) => {
                                                log::error!("Stream error on msg {}: {}", message_id, e);
                                                yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Telegram stream error: {}", e)));
                                                break;
                                            },
                                            Err(_) => {
                                                log::error!("Stream timeout on msg {}", message_id);
                                                yield Err::<web::Bytes, actix_web::Error>(ErrorGatewayTimeout("Telegram stream timed out"));
                                                break;
                                            }
                                        }
                                    }
                                    log::debug!("Stream request: Stream completed for msg {} (total chunks: {})", message_id, chunk_count);
                                };

                                let mut response = HttpResponse::build(status);
                                response
                                    .insert_header(("Content-Type", mime))
                                    .insert_header(("Content-Length", content_len.to_string()))
                                    .insert_header(("Accept-Ranges", "bytes"))
                                    .insert_header(("Cache-Control", "private, max-age=120"));

                                if status == StatusCode::PARTIAL_CONTENT {
                                    response.insert_header((
                                        "Content-Range",
                                        format!("bytes {}-{}/{}", start, end, size),
                                    ));
                                }

                                if req.method() == Method::HEAD {
                                    return response.finish();
                                }

                                return response.streaming(stream);
                            } else {
                                log::error!(
                                    "Stream request failed: Media not found in message {}",
                                    message_id
                                );
                            }
                        } else {
                            log::error!("Stream request failed: Message {} not found", message_id);
                        }
                        HttpResponse::NotFound().body("Message or media not found")
                    }
                    Ok(Err(e)) => {
                        log::error!(
                            "Stream request failed: Error fetching message {}: {}",
                            message_id,
                            e
                        );
                        HttpResponse::InternalServerError()
                            .body(format!("Failed to fetch message: {}", e))
                    }
                }
            }
            Ok(Err(e)) => {
                log::error!(
                    "Stream request failed: Peer resolution error for msg {}: {}",
                    message_id,
                    e
                );
                HttpResponse::BadRequest().body(format!("Peer resolution failed: {}", e))
            }
        }
    } else {
        log::error!(
            "Stream request failed: Telegram client not connected for msg {}",
            message_id
        );
        HttpResponse::ServiceUnavailable().body("Telegram client not connected")
    }
}

async fn authorize_stream_access(state: &NasState, token: Option<&str>) -> bool {
    let Some(token) = token.filter(|value| !value.trim().is_empty()) else {
        return false;
    };
    let Ok(claims) = state.decode_session_jwt(token) else {
        return false;
    };
    let Ok(Some(record)) = state.db.get_session(claims.sid).await else {
        return false;
    };
    !record.disabled
        && record.session.expires_at >= now_ts()
        && record.is_approved
        && record.approval_status == ApprovalStatus::Approved
}

#[route(
    "/local-preview/{preview_id}/{file_name}",
    method = "GET",
    method = "HEAD"
)]
async fn local_preview_media(
    req: HttpRequest,
    path: web::Path<(String, String)>,
    query: web::Query<LocalPreviewQuery>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (_preview_id, _file_name) = path.into_inner();

    match &query.token {
        Some(t) if t == &token_data.token => {}
        _ if is_loopback_request(&req) => {}
        _ => return HttpResponse::Forbidden().body("Invalid or missing stream token"),
    }

    let preview_path = PathBuf::from(&query.path);
    if !is_local_preview_path(&preview_path) {
        return HttpResponse::Forbidden().body("Invalid local preview path");
    }
    let tail_path = query.tail_path.as_ref().map(PathBuf::from);
    if let Some(path) = &tail_path {
        if !is_local_preview_path(path) {
            return HttpResponse::Forbidden().body("Invalid local preview tail path");
        }
    }

    let total_size = query.size;
    if total_size == 0 {
        return HttpResponse::LengthRequired().body("Local preview size is not available");
    }

    let requested_range = req.headers().get(header::RANGE);
    let local_range = parse_local_preview_range(requested_range, total_size);
    if requested_range.is_some() && local_range.is_none() {
        return HttpResponse::RangeNotSatisfiable()
            .insert_header(("Content-Range", format!("bytes */{}", total_size)))
            .insert_header(("Accept-Ranges", "bytes"))
            .finish();
    }

    let (start, requested_end, had_range) = local_range.unwrap_or((0, None, false));
    let Some((source, downloaded_for_headers)) = wait_for_local_preview_range(
        &preview_path,
        tail_path.as_ref(),
        query.tail_start,
        start,
        total_size,
        Duration::from_secs(600),
    )
    .await
    else {
        return HttpResponse::GatewayTimeout().body("Timed out waiting for local preview bytes");
    };

    if start >= downloaded_for_headers && downloaded_for_headers < total_size {
        return HttpResponse::GatewayTimeout()
            .body("Timed out waiting for requested preview range");
    }

    if start >= total_size {
        return HttpResponse::RangeNotSatisfiable()
            .insert_header(("Content-Range", format!("bytes */{}", total_size)))
            .insert_header(("Accept-Ranges", "bytes"))
            .finish();
    }

    let available_end = downloaded_for_headers
        .saturating_sub(1)
        .min(total_size.saturating_sub(1));
    let end = requested_end
        .unwrap_or(available_end)
        .min(available_end)
        .min(total_size.saturating_sub(1));

    if end < start {
        return HttpResponse::GatewayTimeout()
            .body("Timed out waiting for requested preview range");
    }

    let status = if had_range || end < total_size.saturating_sub(1) {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let content_len = end.saturating_sub(start).saturating_add(1);

    let mut response = HttpResponse::build(status);
    response
        .insert_header((
            "Content-Type",
            query
                .mime
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string()),
        ))
        .insert_header(("Content-Length", content_len.to_string()))
        .insert_header(("Accept-Ranges", "bytes"))
        .insert_header(("Cache-Control", "no-store"));

    if status == StatusCode::PARTIAL_CONTENT {
        response.insert_header((
            "Content-Range",
            format!("bytes {}-{}/{}", start, end, total_size),
        ));
    }

    if req.method() == Method::HEAD {
        return response.finish();
    }

    let stream = async_stream::stream! {
        let mut pos = start;
        let mut file: Option<tokio::fs::File> = None;

        while pos <= end {
            let (source_path, source_offset, downloaded) = match &source {
                LocalPreviewSource::Front { path, start_offset } => {
                    let downloaded = match tokio::fs::metadata(path).await {
                        Ok(metadata) => metadata.len().min(total_size),
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
                        Err(err) => {
                            yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Local preview metadata failed: {}", err)));
                            break;
                        }
                    };
                    (path, *start_offset, downloaded)
                }
                LocalPreviewSource::Tail { path, start_offset } => {
                    let tail_len = match tokio::fs::metadata(path).await {
                        Ok(metadata) => metadata.len(),
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
                        Err(err) => {
                            yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Local preview tail metadata failed: {}", err)));
                            break;
                        }
                    };
                    (path, *start_offset, start_offset.saturating_add(tail_len).min(total_size))
                }
            };

            if pos >= downloaded {
                if downloaded >= total_size {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
                continue;
            }

            if file.is_none() {
                match tokio::fs::File::open(source_path).await {
                    Ok(mut opened) => {
                        if let Err(err) = opened.seek(SeekFrom::Start(pos.saturating_sub(source_offset))).await {
                            yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Local preview seek failed: {}", err)));
                            break;
                        }
                        file = Some(opened);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        continue;
                    }
                    Err(err) => {
                        yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Local preview open failed: {}", err)));
                        break;
                    }
                }
            }

            let available = downloaded.saturating_sub(pos).min(end.saturating_sub(pos).saturating_add(1));
            let read_len = available.min(LOCAL_PREVIEW_READ_CHUNK_SIZE as u64) as usize;
            let mut buffer = vec![0; read_len];

            let read_result = match file.as_mut() {
                Some(opened) => opened.read(&mut buffer).await,
                None => break,
            };

            match read_result {
                Ok(0) => {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                }
                Ok(read) => {
                    buffer.truncate(read);
                    pos = pos.saturating_add(read as u64);
                    yield Ok::<_, actix_web::Error>(web::Bytes::from(buffer));
                }
                Err(err) => {
                    yield Err::<web::Bytes, actix_web::Error>(ErrorBadGateway(format!("Local preview read failed: {}", err)));
                    break;
                }
            }
        }
    };

    response.streaming(stream)
}

fn is_local_preview_path(path: &PathBuf) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    path.is_absolute() && normalized.contains("/local-previews/")
}

async fn wait_for_local_preview_range(
    front_path: &PathBuf,
    tail_path: Option<&PathBuf>,
    tail_start: Option<u64>,
    start: u64,
    total_size: u64,
    max_wait: Duration,
) -> Option<(LocalPreviewSource, u64)> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        let front_downloaded = match tokio::fs::metadata(front_path).await {
            Ok(metadata) => metadata.len().min(total_size),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
            Err(_) => return None,
        };

        if start < front_downloaded {
            let wanted = start
                .saturating_add(1)
                .saturating_add(LOCAL_PREVIEW_MIN_RESPONSE_BYTES)
                .min(total_size);
            if front_downloaded >= wanted || front_downloaded >= total_size {
                return Some((
                    LocalPreviewSource::Front {
                        path: front_path.clone(),
                        start_offset: 0,
                    },
                    front_downloaded,
                ));
            }
        }

        if let (Some(tail_path), Some(tail_start)) = (tail_path, tail_start) {
            if start >= tail_start {
                let tail_downloaded = match tokio::fs::metadata(tail_path).await {
                    Ok(metadata) => metadata.len(),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
                    Err(_) => return None,
                };
                let tail_available_end = tail_start.saturating_add(tail_downloaded).min(total_size);
                if start < tail_available_end {
                    let wanted = start
                        .saturating_add(1)
                        .saturating_add(LOCAL_PREVIEW_MIN_RESPONSE_BYTES)
                        .min(total_size);
                    if tail_available_end >= wanted || tail_available_end >= total_size {
                        return Some((
                            LocalPreviewSource::Tail {
                                path: tail_path.clone(),
                                start_offset: tail_start,
                            },
                            tail_available_end,
                        ));
                    }
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            if start < front_downloaded {
                return Some((
                    LocalPreviewSource::Front {
                        path: front_path.clone(),
                        start_offset: 0,
                    },
                    front_downloaded,
                ));
            }

            if let (Some(tail_path), Some(tail_start)) = (tail_path, tail_start) {
                if start >= tail_start {
                    let tail_downloaded = match tokio::fs::metadata(tail_path).await {
                        Ok(metadata) => metadata.len(),
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
                        Err(_) => return None,
                    };
                    let tail_available_end =
                        tail_start.saturating_add(tail_downloaded).min(total_size);
                    if start < tail_available_end {
                        return Some((
                            LocalPreviewSource::Tail {
                                path: tail_path.clone(),
                                start_offset: tail_start,
                            },
                            tail_available_end,
                        ));
                    }
                }
            }

            return None;
        }

        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

fn parse_local_preview_range(
    range_header: Option<&header::HeaderValue>,
    size: u64,
) -> Option<(u64, Option<u64>, bool)> {
    if size == 0 {
        return None;
    }

    let Some(range_header) = range_header else {
        return Some((0, None, false));
    };

    let range = range_header.to_str().ok()?.trim();
    let range = range.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;

    if start.is_empty() {
        let suffix_len = end.parse::<u64>().ok()?.min(size);
        return Some((size - suffix_len, Some(size - 1), true));
    }

    let start = start.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }

    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse::<u64>().ok()?.min(size - 1))
    };

    if let Some(end) = end {
        if end < start {
            return None;
        }
    }

    Some((start, end, true))
}

fn is_loopback_request(req: &HttpRequest) -> bool {
    req.peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false)
}

fn parse_range(range_header: Option<&header::HeaderValue>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }

    let range = range_header?.to_str().ok()?.trim();
    let range = range.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;

    if start.is_empty() {
        let suffix_len = end.parse::<u64>().ok()?.min(size);
        return Some((size - suffix_len, size - 1));
    }

    let start = start.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }

    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };

    if end < start {
        None
    } else {
        Some((start, end))
    }
}

fn mime_type_from_media(media: &Media) -> String {
    match media {
        Media::Document(d) => {
            let telegram_mime = d.mime_type().unwrap_or("application/octet-stream");
            if telegram_mime != "application/octet-stream" {
                return telegram_mime.to_string();
            }

            let name = d.name().to_lowercase();
            match name.rsplit_once('.').map(|(_, ext)| ext) {
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
        _ => "application/octet-stream".to_string(),
    }
}

pub async fn start_server(
    state: NasState,
    host: String,
    port: u16,
    token: String,
) -> std::io::Result<actix_web::dev::Server> {
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData { token });

    log::info!("Starting Streaming Server on port {}", port);

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin("tauri://localhost")
            .allowed_origin("http://tauri.localhost")
            .allowed_origin("http://localhost:1420")
            .allowed_origin("https://tauri.localhost")
            .allowed_origin("http://127.0.0.1:1420")
            .expose_headers([
                header::ACCEPT_RANGES,
                header::CONTENT_LENGTH,
                header::CONTENT_RANGE,
                header::CONTENT_TYPE,
            ])
            .supports_credentials()
            .allow_any_method()
            .allow_any_header();

        App::new()
            .wrap(cors)
            .app_data(state_data.clone())
            .app_data(token_data.clone())
            .configure(configure_api)
            .service(stream_media)
            .service(api_stream_media)
            .service(local_preview_media)
    })
    .bind((host.as_str(), port))?
    .run();

    log::info!(
        "Telegram NAS API started successfully on http://{}:{}",
        host,
        port
    );

    Ok(server)
}
