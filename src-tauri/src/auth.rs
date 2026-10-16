use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::{now_ms, Db};
use crate::parse::b64url_encode;

const KR_SERVICE: &str = "Post Mail (app.post.mail)";
pub const AUTH_REQUIRED: &str = "AUTH_REQUIRED";
const SCOPES: &str = "https://www.googleapis.com/auth/gmail.modify \
https://www.googleapis.com/auth/contacts.readonly \
https://www.googleapis.com/auth/contacts.other.readonly \
https://www.googleapis.com/auth/calendar.readonly";

pub struct Auth {
    db: Arc<Db>,
    http: reqwest::Client,
    token: tokio::sync::Mutex<Option<(String, i64)>>,
}

fn entry(user: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KR_SERVICE, user)?)
}

/// Read a secret. `Ok(None)` only when Credential Manager says there is no such entry;
/// any other failure is an error, so callers never mistake a hiccup for "signed out".
fn secret_read(user: &str) -> Result<Option<String>> {
    match entry(user)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Read with a few quick retries for transient Credential Manager failures.
fn secret_read_retry(user: &str) -> Result<Option<String>> {
    let mut last = None;
    for attempt in 0..4 {
        match secret_read(user) {
            Ok(v) => return Ok(v),
            Err(e) => {
                log::warn!("credential read for {user} failed (attempt {}): {e}", attempt + 1);
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
    }
    Err(last.unwrap())
}

fn secret_get(user: &str) -> Option<String> {
    secret_read_retry(user).ok().flatten()
}

fn secret_set(user: &str, v: &str) -> Result<()> {
    entry(user)?.set_password(v)?;
    SIGNED_IN.lock().unwrap().take();
    Ok(())
}

fn secret_del(user: &str) {
    if let Ok(e) = entry(user) {
        let _ = e.delete_credential();
    }
    SIGNED_IN.lock().unwrap().take();
}

/// The sync and send loops ask "signed in?" several times a second; Credential Manager is only
/// read again after a short while (or right away once the token is saved or removed).
static SIGNED_IN: std::sync::Mutex<Option<(bool, std::time::Instant)>> = std::sync::Mutex::new(None);

pub fn is_auth_required(e: &anyhow::Error) -> bool {
    e.to_string().contains(AUTH_REQUIRED)
}

impl Auth {
    pub fn new(db: Arc<Db>, http: reqwest::Client) -> Self {
        Auth { db, http, token: tokio::sync::Mutex::new(None) }
    }

    pub fn client(&self) -> Option<(String, String)> {
        let id = self.db.kv_get("client_id")?;
        let secret = secret_get("client_secret").unwrap_or_default();
        Some((id, secret))
    }

    pub fn set_client(&self, id: &str, secret: &str) -> Result<()> {
        self.db.kv_set("client_id", id.trim())?;
        secret_set("client_secret", secret.trim())?;
        Ok(())
    }

    /// Signed out only when the refresh token is definitely absent. If Credential Manager
    /// can't be read right now, assume we're still signed in; a real problem surfaces later
    /// as an auth error from Google, which triggers the reconnect flow properly.
    pub fn signed_in(&self) -> bool {
        if let Some((v, at)) = *SIGNED_IN.lock().unwrap() {
            if at.elapsed() < std::time::Duration::from_secs(30) {
                return v;
            }
        }
        let v = match secret_read_retry("refresh_token") {
            Ok(v) => v.is_some(),
            Err(_) => !self.db.my_email().is_empty(),
        };
        *SIGNED_IN.lock().unwrap() = Some((v, std::time::Instant::now()));
        v
    }

    pub async fn sign_out(&self) {
        secret_del("refresh_token");
        *self.token.lock().await = None;
    }

    pub async fn invalidate(&self) {
        *self.token.lock().await = None;
    }

    /// Full OAuth 2.0 installed-app flow with PKCE and a loopback redirect.
    pub async fn sign_in<F: Fn(&str)>(&self, open_browser: F) -> Result<()> {
        let (client_id, client_secret) = self.client().ok_or_else(|| anyhow!("No OAuth client configured"))?;
        let mut raw = [0u8; 48];
        rand::thread_rng().fill_bytes(&mut raw);
        let verifier = b64url_encode(&raw);
        let challenge = b64url_encode(&Sha256::digest(verifier.as_bytes()));
        let mut st = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut st);
        let state = b64url_encode(&st);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let url = url::Url::parse_with_params(
            "https://accounts.google.com/o/oauth2/v2/auth",
            &[
                ("client_id", client_id.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", SCOPES),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("access_type", "offline"),
                ("prompt", "consent"),
                ("state", state.as_str()),
            ],
        )?;
        open_browser(url.as_str());

        let code = tokio::time::timeout(std::time::Duration::from_secs(300), async {
            loop {
                let (mut sock, _) = listener.accept().await?;
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await?;
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let parsed = url::Url::parse(&format!("http://localhost{path}"))?;
                let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
                let (ok, body) = if let Some(c) = q.get("code") {
                    if q.get("state") != Some(&state) {
                        (None, "State mismatch. Please try signing in again.")
                    } else {
                        (Some(c.clone()), "You're signed in. You can close this tab and return to Post.")
                    }
                } else if q.contains_key("error") {
                    (None, "Sign-in was cancelled. You can close this tab.")
                } else {
                    let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                };
                let html = format!(
                    "<!doctype html><meta charset=utf-8><title>Post</title>\
                     <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;color:#333\">\
                     <p style=\"font-size:18px\">{body}</p></body>"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
                return match ok {
                    Some(c) => Ok::<String, anyhow::Error>(c),
                    None => Err(anyhow!("{}", body)),
                };
            }
        })
        .await
        .map_err(|_| anyhow!("Timed out waiting for Google sign-in"))??;

        let resp: Value = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("code", code.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await?
            .json()
            .await?;
        let refresh = resp["refresh_token"]
            .as_str()
            .ok_or_else(|| anyhow!("Token exchange failed: {}", resp))?;
        secret_set("refresh_token", refresh)?;
        if let (Some(at), Some(exp)) = (resp["access_token"].as_str(), resp["expires_in"].as_i64()) {
            *self.token.lock().await = Some((at.to_string(), now_ms() + exp * 1000));
        }
        Ok(())
    }

    pub async fn access_token(&self) -> Result<String> {
        let mut guard = self.token.lock().await;
        if let Some((t, exp)) = guard.as_ref() {
            if *exp - 60_000 > now_ms() {
                return Ok(t.clone());
            }
        }
        let refresh = match secret_read_retry("refresh_token") {
            Ok(Some(t)) => t,
            Ok(None) => bail!(AUTH_REQUIRED),
            // Not an auth problem: let the caller retry later rather than asking to reconnect.
            Err(e) => bail!("Couldn't read saved sign-in from Windows Credential Manager: {e}"),
        };
        let (client_id, client_secret) = self.client().ok_or_else(|| anyhow!(AUTH_REQUIRED))?;
        let resp = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            if v["error"].as_str() == Some("invalid_grant") {
                secret_del("refresh_token");
                bail!(AUTH_REQUIRED);
            }
            bail!("Token refresh failed ({}): {}", status, v);
        }
        let at = v["access_token"].as_str().ok_or_else(|| anyhow!("No access token"))?.to_string();
        let exp = v["expires_in"].as_i64().unwrap_or(3600);
        *guard = Some((at.clone(), now_ms() + exp * 1000));
        Ok(at)
    }
}
