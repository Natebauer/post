use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use reqwest::Method;
use serde_json::{json, Value};

use crate::auth::Auth;
use crate::parse::{b64url_decode, b64url_encode};

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const PEOPLE: &str = "https://people.googleapis.com/v1";
/// Fastest request spacing. Projects default to 6,000 units/min/user and a message
/// fetch costs 5, so 60ms (~1,000 requests/min = 5,000 units) leaves headroom.
const MIN_INTERVAL_US: u64 = 60_000;

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = serde_json::from_str::<Value>(&self.body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| self.body.chars().take(200).collect());
        write!(f, "Gmail API error {}: {}", self.status, msg)
    }
}
impl std::error::Error for ApiError {}

pub fn api_status(e: &anyhow::Error) -> Option<u16> {
    e.downcast_ref::<ApiError>().map(|a| a.status)
}

pub struct Gmail {
    pub http: reqwest::Client,
    pub auth: Arc<Auth>,
    pacer: std::sync::Mutex<Pacer>,
    interval_us: AtomicU64,
    /// Slowest-safe spacing learned from Gmail's quota refusals; bulk work never goes faster.
    floor_us: AtomicU64,
}

tokio::task_local! {
    static BULK: bool;
}

/// Run background bulk work (the mailbox backfill) in the slow lane. Everything else (checking
/// for new mail, opening an email, user actions) skips ahead of it, so new mail isn't stuck
/// behind thousands of queued backfill requests.
pub async fn bulk<F: std::future::Future>(f: F) -> F::Output {
    BULK.scope(true, f).await
}

struct Pacer {
    next: tokio::time::Instant,
    paused_until: tokio::time::Instant,
    window_start: tokio::time::Instant,
    sent: u64,
}

pub struct HistoryChanges {
    pub added: Vec<(String, Vec<String>)>,
    pub deleted: Vec<String>,
    pub labels: Vec<(String, Vec<String>)>,
    pub history_id: String,
}

fn str_vec(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

impl Gmail {
    pub fn new(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        Gmail {
            http,
            auth,
            pacer: std::sync::Mutex::new(Pacer {
                next: tokio::time::Instant::now(),
                paused_until: tokio::time::Instant::now(),
                window_start: tokio::time::Instant::now(),
                sent: 0,
            }),
            interval_us: AtomicU64::new(MIN_INTERVAL_US),
            floor_us: AtomicU64::new(MIN_INTERVAL_US),
        }
    }

    /// Space requests evenly so we stay under Gmail's per-user quota (often 6,000 units/min;
    /// a message fetch costs 5). On a quota refusal everything pauses once and the spacing
    /// widens; it eases back toward the fastest rate as requests succeed.
    async fn pace(&self) {
        let slot = {
            let mut p = self.pacer.lock().unwrap();
            let now = tokio::time::Instant::now();
            let slot = if BULK.try_with(|b| *b).unwrap_or(false) {
                let slot = p.next.max(p.paused_until).max(now);
                p.next = slot + Duration::from_micros(self.interval_us.load(Ordering::Relaxed));
                slot
            } else {
                // Priority: only a quota pause holds it back.
                p.paused_until.max(now)
            };
            p.sent += 1;
            if now.duration_since(p.window_start) >= Duration::from_secs(60) {
                log::info!("Gmail: {} requests in the last minute (spacing {}ms)", p.sent, self.interval_us.load(Ordering::Relaxed) / 1000);
                p.window_start = now;
                p.sent = 0;
            }
            slot
        };
        tokio::time::sleep_until(slot).await;
    }

    fn on_success(&self) {
        // Ease back toward full speed slowly (0.2% per success), so a learned limit holds
        // for a while but a raised quota is eventually used.
        // Never below the learned floor, so the backfill doesn't keep running into the limit
        // (each refusal pauses everything, including checks for new mail, for a minute).
        let cur = self.interval_us.load(Ordering::Relaxed);
        let floor = self.floor_us.load(Ordering::Relaxed);
        if cur > floor {
            self.interval_us.store((cur * 998 / 1000).max(floor), Ordering::Relaxed);
        }
    }

    fn on_quota(&self, pause: Duration, body: &str) {
        let mut p = self.pacer.lock().unwrap();
        let now = tokio::time::Instant::now();
        // Many in-flight requests fail together; react once per pause, not once per request.
        if now < p.paused_until {
            return;
        }
        p.paused_until = now + pause;
        // Learn the real limit: if Gmail refused after N requests this minute, aim for ~80% of N.
        let learned = if pause.as_secs() >= 60 && p.sent >= 10 { 60_000_000 * 5 / (p.sent * 4) } else { 0 };
        let slower = (self.interval_us.load(Ordering::Relaxed) * 3 / 2).max(learned).min(2_000_000);
        self.interval_us.store(slower, Ordering::Relaxed);
        if learned > 0 {
            let floor = learned.min(2_000_000).max(self.floor_us.load(Ordering::Relaxed));
            self.floor_us.store(floor, Ordering::Relaxed);
        }
        let msg = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| body.chars().take(200).collect());
        log::warn!(
            "Gmail quota hit after {} requests this minute; pausing {}s, spacing now {}ms. Gmail said: {msg}",
            p.sent,
            pause.as_secs(),
            slower / 1000
        );
    }

    async fn call(&self, method: Method, url: &str, body: Option<&Value>) -> Result<Value> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            self.pace().await;
            let token = self.auth.access_token().await?;
            let mut rb = self.http.request(method.clone(), url).bearer_auth(&token);
            if let Some(b) = body {
                rb = rb.json(b);
            }
            let resp = match rb.timeout(Duration::from_secs(60)).send().await {
                Ok(r) => r,
                Err(e) => {
                    if attempt < 4 {
                        tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                        continue;
                    }
                    return Err(e.into());
                }
            };
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                self.on_success();
                let text = resp.text().await?;
                if text.trim().is_empty() {
                    return Ok(Value::Null);
                }
                return Ok(serde_json::from_str(&text)?);
            }
            let text = resp.text().await.unwrap_or_default();
            let quota = status == 429
                || (status == 403
                    && ["rateLimitExceeded", "userRateLimitExceeded", "Quota exceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED"]
                        .iter()
                        .any(|m| text.contains(m)));
            if status == 401 && attempt < 2 {
                self.auth.invalidate().await;
                continue;
            }
            if quota && attempt < 8 {
                let per_minute = text.contains("per minute");
                self.on_quota(Duration::from_secs(if per_minute { 60 } else { 5 }), &text);
                continue;
            }
            if status >= 500 && attempt < 6 {
                log::warn!("Gmail {status} (attempt {attempt}): {}", url.split('?').next().unwrap_or(url));
                let jitter = rand::random::<u64>() % 400;
                tokio::time::sleep(Duration::from_millis(250 * 2u64.pow(attempt.min(5)) + jitter)).await;
                continue;
            }
            return Err(ApiError { status, body: text }.into());
        }
    }

    pub async fn get(&self, url: &str) -> Result<Value> {
        self.call(Method::GET, url, None).await
    }

    pub async fn post(&self, url: &str, body: &Value) -> Result<Value> {
        self.call(Method::POST, url, Some(body)).await
    }

    pub async fn profile(&self) -> Result<(String, String, i64)> {
        let v = self.get(&format!("{BASE}/profile")).await?;
        Ok((
            v["emailAddress"].as_str().unwrap_or("").to_string(),
            v["historyId"].as_str().unwrap_or("").to_string(),
            v["messagesTotal"].as_i64().unwrap_or(0),
        ))
    }

    /// List message ids (newest first).
    pub async fn list_messages(
        &self,
        q: Option<&str>,
        page_token: Option<&str>,
        max: u32,
        include_spam_trash: bool,
    ) -> Result<(Vec<(String, String)>, Option<String>)> {
        let mut url = url::Url::parse(&format!("{BASE}/messages"))?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("maxResults", &max.to_string());
            if include_spam_trash {
                qp.append_pair("includeSpamTrash", "true");
            }
            if let Some(q) = q {
                qp.append_pair("q", q);
            }
            if let Some(p) = page_token {
                qp.append_pair("pageToken", p);
            }
        }
        let v = self.get(url.as_str()).await?;
        let ids = v["messages"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|m| {
                        (
                            m["id"].as_str().unwrap_or("").to_string(),
                            m["threadId"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok((ids, v["nextPageToken"].as_str().map(String::from)))
    }

    pub async fn get_message(&self, id: &str) -> Result<Value> {
        self.get(&format!("{BASE}/messages/{id}?format=full")).await
    }

    /// Full RFC 822 source of a message.
    pub async fn get_raw(&self, id: &str) -> Result<Vec<u8>> {
        let v = self.get(&format!("{BASE}/messages/{id}?format=raw")).await?;
        Ok(b64url_decode(v["raw"].as_str().unwrap_or("")))
    }

    /// Calendars shown in the user's Google Calendar (primary, their own, and shared ones they've
    /// checked), as (id, name, color).
    pub async fn calendar_list(&self) -> Result<Vec<(String, String, String)>> {
        let v = self
            .get("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250")
            .await?;
        Ok(v["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| !c["hidden"].as_bool().unwrap_or(false))
            .filter(|c| c["selected"].as_bool().unwrap_or(false) || c["primary"].as_bool().unwrap_or(false))
            .map(|c| {
                (
                    c["id"].as_str().unwrap_or("").to_string(),
                    c["summaryOverride"].as_str().or(c["summary"].as_str()).unwrap_or("").to_string(),
                    c["backgroundColor"].as_str().unwrap_or("").to_string(),
                )
            })
            .filter(|c| !c.0.is_empty())
            .collect())
    }

    /// Events on one calendar from the start of `from` (local time) through `days` days.
    pub async fn calendar_events(&self, calendar_id: &str, from: chrono::NaiveDate, days: i64) -> Result<Value> {
        use chrono::TimeZone;
        let now = chrono::Local::now();
        let start = chrono::Local
            .from_local_datetime(&from.and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap_or(now);
        let mut url = url::Url::parse(&format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events",
            urlencoding::encode(calendar_id)
        ))?;
        url.query_pairs_mut()
            .append_pair("timeMin", &start.to_rfc3339())
            .append_pair("timeMax", &(start + chrono::Duration::days(days)).to_rfc3339())
            .append_pair("singleEvents", "true")
            .append_pair("orderBy", "startTime")
            .append_pair("maxResults", "250");
        self.get(url.as_str()).await
    }

    /// Addresses this account can send as (primary plus aliases).
    pub async fn send_as(&self) -> Result<Vec<crate::types::SendAs>> {
        let v = self.get(&format!("{BASE}/settings/sendAs")).await?;
        Ok(v["sendAs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| s["verificationStatus"].as_str().map(|v| v == "accepted").unwrap_or(true))
            .map(|s| crate::types::SendAs {
                email: s["sendAsEmail"].as_str().unwrap_or("").to_string(),
                name: s["displayName"].as_str().unwrap_or("").to_string(),
                is_default: s["isDefault"].as_bool().unwrap_or(false),
            })
            .collect())
    }

    /// The learned safe spacing, so it can be remembered across restarts.
    pub fn floor_us(&self) -> u64 {
        self.floor_us.load(Ordering::Relaxed)
    }

    pub fn set_floor_us(&self, us: u64) {
        let us = us.clamp(MIN_INTERVAL_US, 2_000_000);
        self.floor_us.store(us, Ordering::Relaxed);
        self.interval_us.fetch_max(us, Ordering::Relaxed);
    }

    pub fn spacing_ms(&self) -> u64 {
        self.interval_us.load(Ordering::Relaxed) / 1000
    }

    pub async fn get_message_labels(&self, id: &str) -> Result<Vec<String>> {
        let v = self.get(&format!("{BASE}/messages/{id}?format=minimal")).await?;
        Ok(str_vec(&v["labelIds"]))
    }

    /// Fetch all history since `start`. Returns Err with status 404 when the id is too old.
    pub async fn history(&self, start: &str) -> Result<HistoryChanges> {
        let mut out = HistoryChanges { added: vec![], deleted: vec![], labels: vec![], history_id: start.to_string() };
        let mut page: Option<String> = None;
        loop {
            let mut url = format!(
                "{BASE}/history?startHistoryId={start}&maxResults=500\
                 &historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved"
            );
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", urlencoding::encode(p)));
            }
            let v = self.get(&url).await?;
            if let Some(h) = v["historyId"].as_str() {
                out.history_id = h.to_string();
            }
            for rec in v["history"].as_array().into_iter().flatten() {
                for a in rec["messagesAdded"].as_array().into_iter().flatten() {
                    let m = &a["message"];
                    out.added.push((m["id"].as_str().unwrap_or("").into(), str_vec(&m["labelIds"])));
                }
                for d in rec["messagesDeleted"].as_array().into_iter().flatten() {
                    out.deleted.push(d["message"]["id"].as_str().unwrap_or("").into());
                }
                for key in ["labelsAdded", "labelsRemoved"] {
                    for l in rec[key].as_array().into_iter().flatten() {
                        let m = &l["message"];
                        out.labels.push((m["id"].as_str().unwrap_or("").into(), str_vec(&m["labelIds"])));
                    }
                }
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_string()),
                None => break,
            }
        }
        Ok(out)
    }

    pub async fn modify_thread(&self, thread_id: &str, add: &[&str], remove: &[&str]) -> Result<()> {
        self.post(
            &format!("{BASE}/threads/{thread_id}/modify"),
            &json!({ "addLabelIds": add, "removeLabelIds": remove }),
        )
        .await?;
        Ok(())
    }

    pub async fn trash_thread(&self, thread_id: &str) -> Result<()> {
        self.post(&format!("{BASE}/threads/{thread_id}/trash"), &json!({})).await?;
        Ok(())
    }

    pub async fn untrash_thread(&self, thread_id: &str) -> Result<()> {
        self.post(&format!("{BASE}/threads/{thread_id}/untrash"), &json!({})).await?;
        Ok(())
    }

    pub async fn send_raw(&self, raw: &[u8], thread_id: Option<&str>) -> Result<Value> {
        let mut body = json!({ "raw": b64url_encode(raw) });
        if let Some(t) = thread_id {
            body["threadId"] = json!(t);
        }
        self.post(&format!("{BASE}/messages/send"), &body).await
    }

    pub async fn save_draft(&self, draft_id: Option<&str>, raw: &[u8], thread_id: Option<&str>) -> Result<(String, String)> {
        let mut msg = json!({ "raw": b64url_encode(raw) });
        if let Some(t) = thread_id {
            msg["threadId"] = json!(t);
        }
        let v = match draft_id {
            Some(d) => {
                let r = self
                    .call(Method::PUT, &format!("{BASE}/drafts/{d}"), Some(&json!({ "id": d, "message": msg })))
                    .await;
                match r {
                    Ok(v) => v,
                    // Draft vanished (sent or deleted elsewhere): create a new one.
                    Err(e) if api_status(&e) == Some(404) => {
                        self.post(&format!("{BASE}/drafts"), &json!({ "message": msg })).await?
                    }
                    Err(e) => return Err(e),
                }
            }
            None => self.post(&format!("{BASE}/drafts"), &json!({ "message": msg })).await?,
        };
        Ok((
            v["id"].as_str().unwrap_or("").to_string(),
            v["message"]["id"].as_str().unwrap_or("").to_string(),
        ))
    }

    pub async fn delete_draft(&self, draft_id: &str) -> Result<()> {
        match self.call(Method::DELETE, &format!("{BASE}/drafts/{draft_id}"), None).await {
            Ok(_) => Ok(()),
            Err(e) if api_status(&e) == Some(404) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Find the draft id wrapping a given message id.
    pub async fn find_draft(&self, message_id: &str) -> Result<Option<String>> {
        let mut page: Option<String> = None;
        loop {
            let mut url = format!("{BASE}/drafts?maxResults=500");
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", urlencoding::encode(p)));
            }
            let v = self.get(&url).await?;
            for d in v["drafts"].as_array().into_iter().flatten() {
                if d["message"]["id"].as_str() == Some(message_id) {
                    return Ok(d["id"].as_str().map(String::from));
                }
            }
            match v["nextPageToken"].as_str() {
                Some(p) => page = Some(p.to_string()),
                None => return Ok(None),
            }
        }
    }

    pub async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        let v = self
            .get(&format!("{BASE}/messages/{message_id}/attachments/{attachment_id}"))
            .await?;
        match v["data"].as_str() {
            Some(d) => Ok(b64url_decode(d)),
            None => bail!("attachment had no data"),
        }
    }

    /// Contacts and "other contacts" (people you've emailed) from the People API.
    pub async fn contacts(&self) -> Result<Vec<(String, String, Option<String>)>> {
        let mut out = Vec::new();
        for (endpoint, list_key, fields_param) in [
            ("people/me/connections", "connections", "personFields=names,emailAddresses,photos"),
            ("otherContacts", "otherContacts", "readMask=names,emailAddresses,photos"),
        ] {
            let mut page: Option<String> = None;
            loop {
                let mut url = format!("{PEOPLE}/{endpoint}?pageSize=1000&{fields_param}");
                if let Some(p) = &page {
                    url.push_str(&format!("&pageToken={}", urlencoding::encode(p)));
                }
                let v = match self.get(&url).await {
                    Ok(v) => v,
                    Err(e) if matches!(api_status(&e), Some(403) | Some(404)) => break,
                    Err(e) => return Err(e),
                };
                for p in v[list_key].as_array().into_iter().flatten() {
                    let name = p["names"][0]["displayName"].as_str().unwrap_or("").to_string();
                    let photo = p["photos"]
                        .as_array()
                        .and_then(|a| a.iter().find(|ph| !ph["default"].as_bool().unwrap_or(false)))
                        .and_then(|ph| ph["url"].as_str())
                        .map(String::from);
                    for e in p["emailAddresses"].as_array().into_iter().flatten() {
                        if let Some(addr) = e["value"].as_str() {
                            out.push((addr.to_string(), name.clone(), photo.clone()));
                        }
                    }
                }
                match v["nextPageToken"].as_str() {
                    Some(p) => page = Some(p.to_string()),
                    None => break,
                }
            }
        }
        Ok(out)
    }
}
