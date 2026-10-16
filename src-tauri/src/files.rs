//! Files on disk, with the webview kept away from raw paths.
//!
//! Saving opens the native save dialog here in Rust, so a page can only ever ask the user where
//! to save, never write somewhere itself. Files you attach (picked or dragged in) are copied into
//! Post's own "outgoing" folder, and sending only reads from there, so mail can't carry a file
//! you didn't choose.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Where staged attachments live until they're sent (cleaned up after a few weeks).
pub fn outgoing_dir(st: &AppState) -> PathBuf {
    st.data_dir.join("outgoing")
}

/// Is this path one of Post's staged attachments?
pub fn is_staged(st: &AppState, path: &str) -> bool {
    let Ok(root) = outgoing_dir(st).canonicalize() else { return false };
    Path::new(path).canonicalize().map(|p| p.starts_with(&root)).unwrap_or(false)
}

/// A file name that's safe on Windows.
pub fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "attachment".into() } else { s }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub path: String,
    pub name: String,
}

/// Copy files the user chose into the outgoing folder.
pub fn stage(st: &AppState, paths: &[PathBuf]) -> Vec<Staged> {
    let dir = outgoing_dir(st).join(format!("{}-{}", crate::db::now_ms(), rand::random::<u32>()));
    if std::fs::create_dir_all(&dir).is_err() {
        return vec![];
    }
    let mut out = Vec::new();
    for p in paths {
        if !p.is_file() {
            continue;
        }
        let name = safe_name(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        let mut target = dir.join(&name);
        let mut i = 1;
        while target.exists() {
            i += 1;
            target = dir.join(format!("{i}-{name}"));
        }
        match std::fs::copy(p, &target) {
            Ok(_) => out.push(Staged { path: target.to_string_lossy().to_string(), name }),
            Err(e) => log::warn!("couldn't stage attachment {}: {e}", p.display()),
        }
    }
    out
}

/// Ask where to save one file. None if the user cancels.
pub async fn ask_save_path(app: &AppHandle, suggested: &str, filter: Option<(&str, &[&str])>) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = app.dialog().file().set_file_name(safe_name(suggested));
    if let Some((label, exts)) = filter {
        d = d.add_filter(label, exts);
    }
    d.save_file(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()));
    });
    rx.await.ok().flatten()
}

pub async fn ask_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()));
    });
    rx.await.ok().flatten()
}

pub async fn ask_files(app: &AppHandle) -> Vec<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Attach files").pick_files(move |p| {
        let _ = tx.send(p.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect::<Vec<_>>());
    });
    rx.await.unwrap_or_default()
}

/// Mark a downloaded file as coming from the internet, so Windows SmartScreen and Office
/// Protected View treat it with the usual care.
pub fn mark_from_internet(path: &Path) {
    #[cfg(windows)]
    {
        let ads = format!("{}:Zone.Identifier", path.display());
        if let Err(e) = std::fs::write(&ads, "[ZoneTransfer]\r\nZoneId=3\r\n") {
            log::warn!("couldn't mark {} as downloaded: {e}", path.display());
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Write bytes the user asked to save, marked as downloaded.
pub fn write_download(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|e| anyhow!("Couldn't save {}: {e}", path.display()))?;
    mark_from_internet(path);
    Ok(())
}

/// Delete old leftovers: opened-attachment copies in %TEMP%, staged attachments, and caches that
/// would otherwise grow forever (avatars, thumbnails).
pub fn clean_up(st: &AppState) {
    let day = std::time::Duration::from_secs(24 * 3600);
    remove_older_than(&std::env::temp_dir().join("Post"), day);
    remove_older_than(&outgoing_dir(st), day * 30);
    for sub in ["avatars", "thumbs"] {
        remove_older_than(&st.cache_dir.join(sub), day * 45);
    }
    st.db.prune_kv();
}

fn remove_older_than(dir: &Path, age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let when = meta.accessed().or_else(|_| meta.modified()).unwrap_or(now);
        if now.duration_since(when).unwrap_or_default() < age {
            continue;
        }
        let p = e.path();
        let r = if meta.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        if let Err(err) = r {
            log::debug!("cleanup skipped {}: {err}", p.display());
        }
    }
}

/// File types that run code when opened. Opening these from an email gets an extra warning.
pub fn is_risky(name: &str) -> bool {
    const RISKY: &[&str] = &[
        "exe", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "pif", "cpl", "js", "jse", "vbs", "vbe", "wsf", "wsh",
        "ps1", "psm1", "hta", "jar", "lnk", "reg", "url", "iso", "img", "vhd", "vhdx", "dll", "sys", "inf", "msc",
        "xll", "application", "gadget", "chm", "scf", "appref-ms",
    ];
    name.rsplit_once('.').map(|(_, e)| RISKY.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}
