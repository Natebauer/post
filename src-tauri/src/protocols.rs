//! Custom URI schemes: `postatt://` serves attachments, `avatar://` serves sender pictures.
//! On Windows these are reachable from the webview as http://<scheme>.localhost/...

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use tauri::http::{Request, Response};

use crate::db::now_ms;
use crate::parse::parse_message;
use crate::state::{key_lock, AppState};

pub const ATT_BASE: &str = "http://postatt.localhost";

fn hash(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn respond(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        // A failure (offline, Gmail hiccup) mustn't be remembered: only cache real answers.
        .header("Cache-Control", if (200..300).contains(&status) { "max-age=86400" } else { "no-store" })
        .body(body)
        .unwrap()
}

// ---------------- attachments ----------------

fn att_dir(cache: &Path) -> PathBuf {
    cache.join("attachments")
}

/// Get attachment bytes, from disk cache or Gmail. Returns (bytes, mime, filename).
pub async fn fetch_attachment(st: &AppState, msg_id: &str, part_id: &str) -> Result<(Vec<u8>, String, String)> {
    let lock = key_lock(&st.att_locks, &format!("{msg_id}/{part_id}"));
    let _g = lock.lock().await;
    let dir = att_dir(&st.cache_dir);
    let path = dir.join(hash(&format!("{msg_id}/{part_id}")));

    let mut atts = st.db.message_attachments(msg_id).unwrap_or_default();
    if !atts.iter().any(|a| a.part_id == part_id) {
        let v = st.gmail.get_message(msg_id).await?;
        let m = parse_message(&v)?;
        atts = m.attachments.clone();
        if st.db.message_exists(msg_id) {
            let _ = st.db.update_attachments(msg_id, &atts);
        }
    }
    let meta = atts
        .iter()
        .find(|a| a.part_id == part_id)
        .cloned()
        .ok_or_else(|| anyhow!("attachment not found"))?;

    if let Ok(bytes) = tokio::fs::read(&path).await {
        let _ = filetime_touch(&path);
        return Ok((bytes, meta.mime_type, meta.filename));
    }
    let bytes = match st.gmail.attachment(msg_id, &meta.attachment_id).await {
        Ok(b) => b,
        Err(_) => {
            // Attachment ids can go stale; refetch the message to get fresh ones.
            let v = st.gmail.get_message(msg_id).await?;
            let m = parse_message(&v)?;
            let _ = st.db.update_attachments(msg_id, &m.attachments);
            let fresh = m
                .attachments
                .iter()
                .find(|a| a.part_id == part_id)
                .ok_or_else(|| anyhow!("attachment not found"))?;
            st.gmail.attachment(msg_id, &fresh.attachment_id).await?
        }
    };
    let _ = tokio::fs::create_dir_all(&dir).await;
    let _ = tokio::fs::write(&path, &bytes).await;
    Ok((bytes, meta.mime_type, meta.filename))
}

fn filetime_touch(path: &Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new().append(true).open(path)?;
    f.set_modified(std::time::SystemTime::now())
}

/// Keep the attachment cache under ~500 MB, evicting least recently used.
pub fn prune_attachment_cache(cache: &Path) {
    let dir = att_dir(cache);
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect();
    files.sort_by(|a, b| b.2.cmp(&a.2));
    let mut total = 0u64;
    for (p, len, _) in files {
        total += len;
        if total > 500 * 1024 * 1024 {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub async fn handle_attachment(st: &AppState, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = req.uri().path().trim_start_matches('/').to_string();
    let mut it = path.splitn(2, '/');
    let (Some(msg), Some(part)) = (it.next(), it.next()) else {
        return respond(400, "text/plain", b"bad request".to_vec());
    };
    let part = urlencoding::decode(part).map(|s| s.into_owned()).unwrap_or_default();
    match fetch_attachment(st, msg, &part).await {
        // Serve it as what it really is: a PDF sent as "application/octet-stream" won't preview otherwise.
        Ok((bytes, mime, _)) => respond(200, crate::ai::sniff(&bytes).unwrap_or(&mime), bytes),
        Err(e) => respond(502, "text/plain", e.to_string().into_bytes()),
    }
}

// ---------------- avatars ----------------

const CONSUMER: &[&str] = &[
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
    "yandex.com", "zoho.com", "fastmail.com", "hey.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
];

fn brand_domain(email: &str) -> Option<String> {
    let domain = email.rsplit('@').next()?.to_lowercase();
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let n = labels.len();
    let base = if n >= 3 && labels[n - 1].len() == 2 && labels[n - 2].len() <= 3 {
        labels[n - 3..].join(".")
    } else {
        labels[n - 2..].join(".")
    };
    if CONSUMER.contains(&base.as_str()) {
        return None;
    }
    Some(base)
}

fn avatar_dir(cache: &Path) -> PathBuf {
    cache.join("avatars")
}

fn png_width(b: &[u8]) -> Option<u32> {
    if b.len() > 24 && &b[1..4] == b"PNG" {
        Some(u32::from_be_bytes([b[16], b[17], b[18], b[19]]))
    } else {
        None
    }
}

pub fn cached_avatar_path(st: &AppState, email: &str) -> Option<PathBuf> {
    let email = email.to_lowercase();
    let dir = avatar_dir(&st.cache_dir);
    for key in [email.clone(), format!("domain:{}", brand_domain(&email).unwrap_or_default())] {
        if let Some((true, _, _)) = st.db.avatar_get(&key) {
            let p = dir.join(hash(&key));
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

async fn fetch_image(st: &AppState, url: &str) -> Option<(Vec<u8>, String)> {
    let r = st.http.get(url).timeout(std::time::Duration::from_secs(10)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let mime = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    if !mime.starts_with("image/") {
        return None;
    }
    let b = r.bytes().await.ok()?.to_vec();
    Some((b, mime))
}

async fn resolve_key(st: &AppState, key: &str, fetcher: impl std::future::Future<Output = Option<(Vec<u8>, String)>>) -> Option<(Vec<u8>, String)> {
    let path = avatar_dir(&st.cache_dir).join(hash(key));
    if let Some((found, mime, fetched)) = st.db.avatar_get(key) {
        if found {
            if let Ok(b) = tokio::fs::read(&path).await {
                return Some((b, mime.unwrap_or_else(|| "image/png".into())));
            }
        } else if now_ms() - fetched < 7 * 24 * 3600_000 {
            return None;
        }
    }
    match fetcher.await {
        Some((b, mime)) => {
            let _ = tokio::fs::create_dir_all(avatar_dir(&st.cache_dir)).await;
            let _ = tokio::fs::write(&path, &b).await;
            st.db.avatar_set(key, true, Some(&mime));
            Some((b, mime))
        }
        None => {
            st.db.avatar_set(key, false, None);
            None
        }
    }
}

pub async fn avatar(st: &AppState, email: &str) -> Option<(Vec<u8>, String)> {
    let email = email.to_lowercase();
    let lock = key_lock(&st.avatar_locks, &email);
    let _g = lock.lock().await;

    // 1. Google contact photo
    if let Some(url) = st.db.contact_photo(&email) {
        let url = regex::Regex::new(r"=s\d+(-c)?$").unwrap().replace(&url, "").to_string() + "=s128-c";
        if let Some(r) = resolve_key(st, &email, fetch_image(st, &url)).await {
            return Some(r);
        }
    }
    // 2. Brand logo via favicon service
    let domain = brand_domain(&email)?;
    let key = format!("domain:{domain}");
    let dlock = key_lock(&st.avatar_locks, &key);
    let _dg = dlock.lock().await;
    let url = format!("https://www.google.com/s2/favicons?domain={domain}&sz=128");
    resolve_key(st, &key, async {
        let (b, mime) = fetch_image(st, &url).await?;
        // Tiny icons look bad in a 32px circle; fall back to initials.
        match png_width(&b) {
            Some(w) if w < 32 => None,
            _ => Some((b, mime)),
        }
    })
    .await
}

pub async fn handle_avatar(st: &AppState, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let email = urlencoding::decode(req.uri().path().trim_start_matches('/'))
        .map(|s| s.into_owned())
        .unwrap_or_default();
    match avatar(st, &email).await {
        Some((b, mime)) => respond(200, &mime, b),
        None => respond(404, "text/plain", Vec::new()),
    }
}
