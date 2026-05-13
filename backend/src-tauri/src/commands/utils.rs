use crate::bandwidth::BandwidthManager;
use grammers_client::types::Peer;
use grammers_client::Client;
use grammers_session::types::PeerRef;
use grammers_tl_types as tl;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct ResolvedTelegramReadPeer {
    pub peer: Peer,
    pub peer_ref: PeerRef,
    pub peer_kind: &'static str,
    pub peer_id: Option<i64>,
    pub is_saved_messages: bool,
}

/// Resolve a folder_id to a Telegram Peer, using the cache for O(1) lookups.
///
/// - `folder_id == None` → returns the user's own peer (Saved Messages)
/// - Cache hit → returns immediately without any network call
/// - Cache miss → scans all dialogs, populates the cache, and returns
pub async fn resolve_peer(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<Peer, String> {
    if let Some(fid) = folder_id {
        // Fast path: check cache
        {
            let cache = peer_cache.read().await;
            if let Some(peer) = cache.get(&fid) {
                return Ok(peer.clone());
            }
        }

        // Slow path: scan dialogs and populate cache
        log::debug!("Peer cache miss for folder_id={}, scanning dialogs...", fid);
        let mut found: Option<Peer> = None;
        let mut dialogs = client.iter_dialogs();
        let mut discovered = Vec::new();
        while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
            let peer_id = match &dialog.peer {
                Peer::Channel(c) => Some(c.raw.id),
                Peer::User(u) => Some(u.raw.id()),
                Peer::Group(group) => Some(group.id().bare_id()),
            };
            if let Some(id) = peer_id {
                discovered.push((id, dialog.peer.clone()));
                if id == fid {
                    found = Some(dialog.peer.clone());
                    // Don't break — keep scanning to warm the cache
                }
            }
        }

        if !discovered.is_empty() {
            let mut cache = peer_cache.write().await;
            for (id, peer) in discovered {
                cache.insert(id, peer);
            }
        }

        found.ok_or_else(|| format!("Folder/Chat {} not found", fid))
    } else {
        match client.get_me().await {
            Ok(me) => Ok(Peer::User(me)),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub async fn resolve_peer_ref(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<PeerRef, String> {
    if folder_id.is_none() {
        return Ok(tl::enums::InputPeer::PeerSelf.into());
    }

    resolve_peer(client, folder_id, peer_cache)
        .await
        .map(PeerRef::from)
}

pub async fn resolve_read_peer(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<ResolvedTelegramReadPeer, String> {
    if folder_id.is_none() {
        let peer = resolve_peer(client, None, peer_cache).await?;
        let peer_id = match &peer {
            Peer::User(user) => Some(user.raw.id()),
            _ => None,
        };
        return Ok(ResolvedTelegramReadPeer {
            peer,
            peer_ref: tl::enums::InputPeer::PeerSelf.into(),
            peer_kind: "saved_messages",
            peer_id,
            is_saved_messages: true,
        });
    }

    let peer = resolve_peer(client, folder_id, peer_cache).await?;
    let (peer_kind, peer_id) = match &peer {
        Peer::Channel(channel) => ("channel", Some(channel.raw.id)),
        Peer::User(user) => ("user", Some(user.raw.id())),
        Peer::Group(group) => ("chat", Some(group.id().bare_id())),
    };

    Ok(ResolvedTelegramReadPeer {
        peer_ref: PeerRef::from(peer.clone()),
        peer,
        peer_kind,
        peer_id,
        is_saved_messages: folder_id.is_none(),
    })
}

/// Clear the peer cache (called on logout)
pub async fn clear_peer_cache(peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>) {
    peer_cache.write().await.clear();
}

#[tauri::command]
pub fn cmd_log(message: String) {
    log::info!("[FRONTEND] {}", message);
}

#[tauri::command]
pub fn cmd_get_bandwidth(
    bw_state: State<'_, BandwidthManager>,
) -> crate::bandwidth::BandwidthStats {
    bw_state.get_stats()
}

pub fn map_error(e: impl std::fmt::Display) -> String {
    let err_str = e.to_string();
    if err_str.contains("FLOOD_WAIT") {
        // Expected format: ... (value: 1234)
        if let Some(start) = err_str.find("(value: ") {
            let rest = &err_str[start + 8..];
            if let Some(end) = rest.find(')') {
                if let Ok(seconds) = rest[..end].parse::<i64>() {
                    return format!("FLOOD_WAIT_{}", seconds);
                }
            }
        }
        // Fallback if parsing fails but we know it's a flood wait
        return "FLOOD_WAIT_60".to_string();
    }
    err_str
}
