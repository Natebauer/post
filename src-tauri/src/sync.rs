use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::Result;
use futures::stream::{self, StreamExt};
use tauri::{AppHandle, Emitter};

use crate::auth::is_auth_required;
use crate::db::now_ms;
use crate::gmail::api_status;
use crate::parse::parse_message;
use crate::state::{emit_changed, set_status, state, AppState};
use crate::types::StoredMessage;

/// Number of most recent messages whose full HTML is always kept.
pub const RECENT_HTML: i64 = 2000;
const BACKFILL_PAGE: u32 = 100;

/// (start time, messages done at start) of this app session's backfill, for rate/ETA.
static SESSION: once_cell::sync::Lazy<std::sync::Mutex<Option<(i64, i64)>>> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

pub fn start(app: AppHandle) {
    let a = app.clone();
    tauri::async_runtime::spawn(async move { sync_loop(a).await });
    let a = app.clone();
    tauri::async_runtime::spawn(async move { live_loop(a).await });
    let a = app.clone();
    tauri::async_runtime::spawn(async move { snooze_loop(a).await });
}

/// Fetch and parse many messages concurrently. Messages deleted in the meantime are skipped.
pub async fn fetch_many(st: &AppState, ids: Vec<String>, concurrency: usize) -> (Vec<StoredMessage>, Option<anyhow::Error>) {
    let results: Vec<Result<Option<StoredMessage>>> = stream::iter(ids)
        .map(|id| async move {
            match st.gmail.get_message(&id).await {
                Ok(v) => match std::panic::catch_unwind(|| parse_message(&v)) {
                    Ok(r) => r.map(Some),
                    Err(_) => {
                        log::error!("parser panicked on message {id}; skipping it");
                        Ok(None)
                    }
                },
                Err(e) if api_status(&e) == Some(404) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;
    let mut out = Vec::new();
    let mut err = None;
    for r in results {
        match r {
            Ok(Some(m)) => out.push(m),
            Ok(None) => {}
            Err(e) => err = Some(e),
        }
    }
    (out, err)
}

/// Checks Gmail for changes every few seconds (and immediately when woken, e.g. after sending).
/// Runs separately from the backfill so new mail never waits behind it.
async fn live_loop(app: AppHandle) {
    let st = state(&app);
    migrate_poll_default(&st);
    loop {
        if st.auth.signed_in() && st.db.kv_get("history_id").is_some() {
            let a = app.clone();
            let result = match tauri::async_runtime::spawn(async move { incremental(&a).await }).await {
                Ok(r) => r,
                Err(e) => Err(anyhow::anyhow!("sync crashed: {e}")),
            };
            report(&app, result.map(|_| None));
        }
        let offline = !st.status.lock().unwrap().online;
        let secs = st.db.settings().poll_seconds.clamp(5, 900) as u64;
        let wait = Duration::from_secs(if offline { secs.max(30) } else { secs });
        let _ = tokio::time::timeout(wait, st.wake.notified()).await;
    }
}

/// The old default was a 20-second check; checks are cheap, so move that default to 5 seconds.
fn migrate_poll_default(st: &AppState) {
    if st.db.kv_get("poll_default_v2").is_some() {
        return;
    }
    let mut s = st.db.settings();
    if s.poll_seconds == 20 {
        s.poll_seconds = 5;
        if let Ok(json) = serde_json::to_string(&s) {
            let _ = st.db.kv_set("settings", &json);
        }
    }
    let _ = st.db.kv_set("poll_default_v2", "1");
}

/// Apply the outcome of a sync pass to the status shown in the app.
/// `backfilling` is Some only for backfill passes.
fn report(app: &AppHandle, result: Result<Option<bool>>) {
    match result {
        Ok(backfilling) => set_status(app, |s| {
            s.online = true;
            s.error = None;
            s.last_sync = now_ms();
            if let Some(b) = backfilling {
                s.phase = if b { "backfill".into() } else { "idle".into() };
            } else if s.phase == "signed_out" {
                s.phase = "idle".into();
            }
        }),
        Err(e) if is_auth_required(&e) => {
            set_status(app, |s| s.phase = "signed_out".into());
            let _ = app.emit("auth-required", ());
        }
        Err(e) => {
            log::warn!("sync error: {e:#}");
            set_status(app, |s| {
                s.online = false;
                s.error = Some(format!("{e}"));
            });
        }
    }
}

/// First-time setup, the mailbox backfill, and periodic housekeeping.
async fn sync_loop(app: AppHandle) {
    let st = state(&app);
    if let Some(us) = st.db.kv_get("gmail_floor_us").and_then(|s| s.parse().ok()) {
        st.gmail.set_floor_us(us);
    }
    let mut saved_floor = st.gmail.floor_us();
    let mut last_contacts: i64 = st.db.kv_get("contacts_synced").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut last_prune: i64 = 0;
    let mut last_ai: i64 = 0;
    loop {
        if !st.auth.signed_in() {
            set_status(&app, |s| s.phase = "signed_out".into());
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        // Run each pass as its own task so a panic is reported instead of killing the loop.
        let a = app.clone();
        let result = match tauri::async_runtime::spawn(async move { cycle(&a).await }).await {
            Ok(r) => r,
            Err(e) => Err(anyhow::anyhow!("sync crashed: {e}")),
        };
        let backfilling = matches!(result, Ok(true));
        report(&app, result.map(Some));

        // Remember the learned Gmail speed limit so the next launch doesn't have to rediscover it.
        let floor = st.gmail.floor_us();
        if floor != saved_floor {
            saved_floor = floor;
            let _ = st.db.kv_set("gmail_floor_us", &floor.to_string());
        }

        let now = now_ms();
        if now - last_prune > 10 * 60_000 {
            last_prune = now;
            let cap = st.db.settings().html_cache_mb.max(10) * 1024 * 1024;
            if let Err(e) = st.db.prune_html(RECENT_HTML, cap) {
                log::warn!("prune failed: {e}");
            }
            crate::protocols::prune_attachment_cache(&st.cache_dir);
        }
        if now - last_ai > 3 * 60_000 {
            last_ai = now;
            let a = app.clone();
            let st2 = st.clone();
            tauri::async_runtime::spawn(async move {
                match crate::ai::classify_waiting(&st2).await {
                    Ok(n) if n > 0 => {
                        log::info!("AI triaged {n} emails for 'waiting on you'");
                        let _ = a.emit("home-changed", ());
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("AI triage skipped: {e}"),
                }
                // Sort new mail into AI categories.
                for section in st2.db.settings().sender_views.iter().filter(|v| v.is_ai()) {
                    match crate::ai::classify_category(&st2, section, 30).await {
                        Ok(n) if n > 0 => emit_changed(&a),
                        Ok(_) => {}
                        Err(e) => log::warn!("sorting into '{}' skipped: {e}", section.name),
                    }
                }
            });
        }
        if now - last_contacts > 24 * 3600_000 {
            last_contacts = now;
            let st2 = st.clone();
            tauri::async_runtime::spawn(async move {
                match st2.gmail.contacts().await {
                    Ok(list) => {
                        let _ = st2.db.upsert_contacts(&list);
                        let _ = st2.db.kv_set("contacts_synced", &now_ms().to_string());
                    }
                    Err(e) => log::warn!("contacts sync failed: {e}"),
                }
            });
        }

        let wait = if backfilling { Duration::from_millis(50) } else { Duration::from_secs(60) };
        tokio::time::sleep(wait).await;
    }
}

/// One setup/backfill pass. Returns whether backfill still has work.
async fn cycle(app: &AppHandle) -> Result<bool> {
    let st = state(app);
    if st.db.kv_get("history_id").is_none() {
        let (email, hid, total) = st.gmail.profile().await?;
        st.db.kv_set("email", &email.to_lowercase())?;
        st.db.kv_set("history_id", &hid)?;
        st.db.kv_set("backfill_state", "running")?;
        st.db.kv_set("backfill_total", &total.to_string())?;
        st.db.kv_set("backfill_done", "0")?;
        st.db.kv_del("backfill_page")?;
        let _ = app.emit("account", email);
        st.wake.notify_one();
    }
    if st.db.kv_get("backfill_state").as_deref() == Some("running") {
        crate::gmail::bulk(backfill_page(app)).await?;
        return Ok(st.db.kv_get("backfill_state").as_deref() == Some("running"));
    }
    Ok(false)
}

async fn incremental(app: &AppHandle) -> Result<()> {
    let st = state(app);
    let start = st.db.kv_get("history_id").unwrap_or_default();
    let ch = match st.gmail.history(&start).await {
        Ok(c) => c,
        Err(e) if api_status(&e) == Some(404) => {
            // History expired (offline too long). Re-walk the mailbox, refreshing labels.
            let (_, hid, total) = st.gmail.profile().await?;
            st.db.kv_set("history_id", &hid)?;
            st.db.kv_set("backfill_state", "running")?;
            st.db.kv_set("backfill_resync", "1")?;
            st.db.kv_set("backfill_total", &total.to_string())?;
            st.db.kv_set("backfill_done", "0")?;
            st.db.kv_del("backfill_page")?;
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    if ch.history_id == start && ch.added.is_empty() && ch.deleted.is_empty() && ch.labels.is_empty() {
        return Ok(());
    }

    let mut changed = false;
    let deleted: HashSet<String> = ch.deleted.iter().cloned().collect();
    if !ch.deleted.is_empty() {
        st.db.delete_messages(&ch.deleted)?;
        changed = true;
    }

    let mut seen = HashSet::new();
    let new_ids: Vec<String> = ch
        .added
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| !deleted.contains(id) && seen.insert(id.clone()))
        .collect();
    let existing = st.db.existing_ids(&new_ids);
    let to_fetch: Vec<String> = new_ids.into_iter().filter(|id| !existing.contains(id)).collect();
    let (mut msgs, err) = fetch_many(&st, to_fetch, 8).await;
    let muted = st.db.muted_threads();
    let mut archive: Vec<String> = Vec::new();
    for m in msgs.iter_mut() {
        if muted.contains(&m.thread_id) && m.labels.iter().any(|l| l == "INBOX") {
            m.labels.retain(|l| l != "INBOX");
            if !archive.contains(&m.thread_id) {
                archive.push(m.thread_id.clone());
            }
        }
    }
    if !msgs.is_empty() {
        st.db.store_messages(&msgs, true)?;
        changed = true;
    }
    for t in &archive {
        if let Err(e) = st.gmail.modify_thread(t, &[], &["INBOX"]).await {
            log::warn!("couldn't archive a reply to a muted thread: {e}");
        }
    }
    if let Some(e) = err {
        // Keep the old history id so we retry the missing ones.
        if changed {
            emit_changed(app);
        }
        return Err(e);
    }

    let fetched: HashSet<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
    let mut last: HashMap<String, Vec<String>> = HashMap::new();
    for (id, labels) in &ch.labels {
        if !fetched.contains(id.as_str()) && !deleted.contains(id) {
            last.insert(id.clone(), labels.clone());
        }
    }
    if !last.is_empty() {
        st.db.set_labels(&last.into_iter().collect::<Vec<_>>())?;
        changed = true;
    }
    st.db.kv_set("history_id", &ch.history_id)?;

    if changed {
        emit_changed(app);
    }

    let me = st.db.my_email();
    let fresh: Vec<&StoredMessage> = msgs
        .iter()
        .filter(|m| {
            m.labels.iter().any(|l| l == "INBOX")
                && m.labels.iter().any(|l| l == "UNREAD")
                && !m.labels.iter().any(|l| l == "SENT" || l == "DRAFT" || l == "SPAM" || l == "TRASH")
                && m.from.email.to_lowercase() != me
                && m.internal_date > now_ms() - 3 * 24 * 3600_000
        })
        .collect();
    if !fresh.is_empty() {
        crate::notify::new_mail(app, &fresh);
        let _ = app.emit("new-mail", fresh.len());
    }
    Ok(())
}

async fn backfill_page(app: &AppHandle) -> Result<()> {
    let st = state(app);
    let page = st.db.kv_get("backfill_page");
    let resync = st.db.kv_get("backfill_resync").is_some();
    let started = std::time::Instant::now();
    let (ids, next) = st.gmail.list_messages(None, page.as_deref(), BACKFILL_PAGE, true).await?;
    let id_list: Vec<String> = ids.iter().map(|(i, _)| i.clone()).collect();
    let existing = st.db.existing_ids(&id_list);
    let missing: Vec<String> = id_list.iter().filter(|i| !existing.contains(*i)).cloned().collect();
    let done: i64 = st.db.kv_get("backfill_done").and_then(|s| s.parse().ok()).unwrap_or(0);

    let (msgs, err) = fetch_many(&st, missing, 8).await;
    if !msgs.is_empty() {
        st.db.store_messages(&msgs, done < RECENT_HTML)?;
    }
    if let Some(e) = err {
        if !msgs.is_empty() {
            emit_changed(app);
        }
        return Err(e);
    }

    if resync && !existing.is_empty() {
        let existing: Vec<String> = existing.into_iter().collect();
        let labels: Vec<(String, Vec<String>)> = stream::iter(existing)
            .map(|id| {
                let st = st.clone();
                async move { st.gmail.get_message_labels(&id).await.ok().map(|l| (id, l)) }
            })
            .buffer_unordered(10)
            .filter_map(|x| async move { x })
            .collect()
            .await;
        st.db.set_labels(&labels)?;
    }

    let done = done + id_list.len() as i64;
    let next_is_last = next.is_none();
    st.db.kv_set("backfill_done", &done.to_string())?;
    match next {
        Some(p) => st.db.kv_set("backfill_page", &p)?,
        None => {
            st.db.kv_set("backfill_state", "done")?;
            st.db.kv_del("backfill_page")?;
            st.db.kv_del("backfill_resync")?;
        }
    }
    let total: i64 = st.db.kv_get("backfill_total").and_then(|s| s.parse().ok()).unwrap_or(0);
    let rate = {
        let mut sess = SESSION.lock().unwrap();
        let (t0, d0) = *sess.get_or_insert((now_ms(), done - id_list.len() as i64));
        let mins = (now_ms() - t0) as f64 / 60_000.0;
        if mins > 0.05 { (done - d0) as f64 / mins } else { 0.0 }
    };
    if done <= 1000 || done % 2000 < BACKFILL_PAGE as i64 || next_is_last {
        log::info!("backfill {done}/{total} (last page {:.1}s)", started.elapsed().as_secs_f32());
    }
    let spacing = st.gmail.spacing_ms();
    set_status(app, |s| {
        s.rate = rate;
        s.spacing_ms = spacing;
        s.backfilled = done;
        s.total = total.max(done);
    });
    emit_changed(app);
    Ok(())
}

async fn snooze_loop(app: AppHandle) {
    let st = state(&app);
    loop {
        let due = st.db.due_snoozes();
        if !due.is_empty() {
            for t in &due {
                let _ = st.db.unsnooze(t, true);
            }
            emit_changed(&app);
            if let Ok(sums) = st.db.thread_summaries(&due) {
                crate::notify::snooze_back(&app, &sums);
            }
        }
        nudge_no_reply(&app);
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

/// "Remind me if no reply": notify once for each sent email that's gone 3 days unanswered.
/// On first run, existing ones are marked as seen so old mail doesn't trigger a burst.
fn nudge_no_reply(app: &AppHandle) {
    let st = state(app);
    let Ok(items) = st.db.no_reply(3, 30) else { return };
    let first_run = st.db.kv_get("nudge_init").is_none();
    let mut shown = 0;
    for it in items {
        let key = format!("nudged:{}", it.message_id);
        if st.db.kv_get(&key).is_some() {
            continue;
        }
        let _ = st.db.kv_set(&key, "1");
        if first_run || shown >= 2 {
            continue;
        }
        shown += 1;
        crate::notify::no_reply(app, &it);
    }
    if first_run {
        let _ = st.db.kv_set("nudge_init", "1");
    }
}
