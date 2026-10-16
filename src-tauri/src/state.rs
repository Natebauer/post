use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::auth::Auth;
use crate::db::Db;
use crate::gmail::Gmail;
use crate::types::SyncStatus;

pub struct AppState {
    pub db: Arc<Db>,
    pub auth: Arc<Auth>,
    pub gmail: Arc<Gmail>,
    pub http: reqwest::Client,
    pub wake: Arc<Notify>,
    pub status: Mutex<SyncStatus>,
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
    pub compose_inits: Mutex<HashMap<String, Value>>,
    pub avatar_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub att_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

pub fn state(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

/// Tell every window that mailbox data changed, along with fresh counts.
pub fn emit_changed(app: &AppHandle) {
    let st = state(app);
    let unread = st.db.inbox_unread();
    let counts = st.db.folder_counts();
    let _ = app.emit("threads-changed", json!({ "unread": unread, "counts": counts }));
    crate::platform::update_tray_tooltip(app, unread);
}

pub fn set_status<F: FnOnce(&mut SyncStatus)>(app: &AppHandle, f: F) {
    let st = state(app);
    let snapshot = {
        let mut s = st.status.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    let _ = app.emit("sync-status", snapshot);
}

pub fn key_lock(map: &Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut m = map.lock().unwrap();
    if m.len() > 2000 {
        m.retain(|_, v| Arc::strong_count(v) > 1);
    }
    m.entry(key.to_string()).or_default().clone()
}
