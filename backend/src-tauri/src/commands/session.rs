use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use grammers_session::types::{DcOption, PeerId, PeerInfo, UpdateState, UpdatesState};
use grammers_session::{Session, SessionData};
use serde::{Deserialize, Serialize};

use crate::nas::crypto::{decrypt_secret, encrypt_secret};

#[derive(Debug, Clone)]
struct SessionSnapshot {
    home_dc: i32,
    dc_options: HashMap<i32, DcOption>,
    peer_infos: HashMap<PeerId, PeerInfo>,
    updates_state: UpdatesState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    home_dc: i32,
    dc_options: Vec<DcOption>,
    peer_infos: Vec<PeerInfo>,
    updates_state: UpdatesState,
}

impl Default for SessionSnapshot {
    fn default() -> Self {
        let data = SessionData::default();
        Self {
            home_dc: data.home_dc,
            dc_options: data.dc_options,
            peer_infos: data.peer_infos,
            updates_state: data.updates_state,
        }
    }
}

impl From<SessionSnapshot> for StoredSession {
    fn from(snapshot: SessionSnapshot) -> Self {
        Self {
            home_dc: snapshot.home_dc,
            dc_options: snapshot.dc_options.into_values().collect(),
            peer_infos: snapshot.peer_infos.into_values().collect(),
            updates_state: snapshot.updates_state,
        }
    }
}

impl From<StoredSession> for SessionSnapshot {
    fn from(stored: StoredSession) -> Self {
        Self {
            home_dc: stored.home_dc,
            dc_options: stored
                .dc_options
                .into_iter()
                .map(|dc_option| (dc_option.id, dc_option))
                .collect(),
            peer_infos: stored
                .peer_infos
                .into_iter()
                .map(|peer| (peer.id(), peer))
                .collect(),
            updates_state: stored.updates_state,
        }
    }
}

pub struct EncryptedSession {
    inner: Mutex<SessionSnapshot>,
    path: PathBuf,
    key: Vec<u8>,
}

impl EncryptedSession {
    pub fn load(path: PathBuf, key: &[u8]) -> Result<Self, String> {
        let snapshot = if path.exists() {
            match Self::load_snapshot(&path, key) {
                Ok(snapshot) => snapshot,
                Err(err) => {
                    log::warn!(
                        "Encrypted Telegram session could not be loaded from {}; resetting stale session: {}",
                        path.display(),
                        err
                    );
                    Self::clear_file(&path)?;
                    SessionSnapshot::default()
                }
            }
        } else {
            SessionSnapshot::default()
        };

        Ok(Self {
            inner: Mutex::new(snapshot),
            path,
            key: key.to_vec(),
        })
    }

    fn load_snapshot(path: &Path, key: &[u8]) -> Result<SessionSnapshot, String> {
        let encrypted = fs::read_to_string(path).map_err(|err| err.to_string())?;
        let plaintext = decrypt_secret(&encrypted, key)
            .map_err(|err| format!("Failed to decrypt Telegram session: {}", err))?;
        let stored = serde_json::from_str::<StoredSession>(&plaintext)
            .map_err(|err| format!("Failed to decode Telegram session: {}", err))?;
        Ok(SessionSnapshot::from(stored))
    }

    pub fn clear_file(path: &Path) -> Result<(), String> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn persist_snapshot(&self, snapshot: &SessionSnapshot) {
        if let Err(err) = self.try_persist_snapshot(snapshot) {
            log::error!("Failed to persist encrypted Telegram session: {}", err);
        }
    }

    fn try_persist_snapshot(&self, snapshot: &SessionSnapshot) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let stored = StoredSession::from(snapshot.clone());
        let plaintext = serde_json::to_string(&stored)
            .map_err(|err| format!("Failed to encode Telegram session: {}", err))?;
        let encrypted = encrypt_secret(&plaintext, &self.key)?;
        fs::write(&self.path, encrypted).map_err(|err| err.to_string())
    }
}

impl Session for EncryptedSession {
    fn home_dc_id(&self) -> i32 {
        self.inner.lock().unwrap().home_dc
    }

    fn set_home_dc_id(&self, dc_id: i32) {
        let mut snapshot = self.inner.lock().unwrap();
        snapshot.home_dc = dc_id;
        self.persist_snapshot(&snapshot);
    }

    fn dc_option(&self, dc_id: i32) -> Option<DcOption> {
        self.inner.lock().unwrap().dc_options.get(&dc_id).cloned()
    }

    fn set_dc_option(&self, dc_option: &DcOption) {
        let mut snapshot = self.inner.lock().unwrap();
        snapshot.dc_options.insert(dc_option.id, dc_option.clone());
        self.persist_snapshot(&snapshot);
    }

    fn peer(&self, peer: PeerId) -> Option<PeerInfo> {
        self.inner.lock().unwrap().peer_infos.get(&peer).cloned()
    }

    fn cache_peer(&self, peer: &PeerInfo) {
        let mut snapshot = self.inner.lock().unwrap();
        snapshot.peer_infos.insert(peer.id(), peer.clone());
        self.persist_snapshot(&snapshot);
    }

    fn updates_state(&self) -> UpdatesState {
        self.inner.lock().unwrap().updates_state.clone()
    }

    fn set_update_state(&self, update: UpdateState) {
        let mut snapshot = self.inner.lock().unwrap();
        match update {
            UpdateState::All(updates_state) => {
                snapshot.updates_state = updates_state;
            }
            UpdateState::Primary { pts, date, seq } => {
                snapshot.updates_state.pts = pts;
                snapshot.updates_state.date = date;
                snapshot.updates_state.seq = seq;
            }
            UpdateState::Secondary { qts } => {
                snapshot.updates_state.qts = qts;
            }
            UpdateState::Channel { id, pts } => {
                snapshot
                    .updates_state
                    .channels
                    .retain(|channel| channel.id != id);
                snapshot
                    .updates_state
                    .channels
                    .push(grammers_session::types::ChannelState { id, pts });
            }
        }
        self.persist_snapshot(&snapshot);
    }
}
