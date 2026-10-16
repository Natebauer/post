//! Reading and changing mail: lists, threads, labels, search and unsubscribe.

use super::*;

// ---------------- mailbox ----------------

#[tauri::command]
pub async fn list_threads(st: St<'_>, folder: String, offset: i64, limit: i64) -> R<Value> {
    let (threads, total) = st.db.list_threads(&folder, offset, limit)?;
    Ok(json!({ "threads": threads, "total": total }))
}

#[tauri::command]
pub async fn get_thread(st: St<'_>, thread_id: String, folder: String) -> R<ThreadDetail> {
    let rows = st.db.thread_messages(&thread_id, &folder)?;
    let missing: Vec<String> = rows.iter().filter(|(_, need)| *need).map(|(m, _)| m.id.clone()).collect();
    let mut fetched = std::collections::HashMap::new();
    if !missing.is_empty() {
        let (msgs, _) = fetch_many(&st, missing, 6).await;
        for m in msgs {
            if let Some(h) = &m.html_body {
                let _ = st.db.update_html(&m.id, h, &m.attachments);
            }
            fetched.insert(m.id.clone(), m);
        }
    }
    let ids: Vec<String> = rows.iter().map(|(m, _)| m.id.clone()).collect();
    st.db.touch_html(&ids);
    let messages: Vec<MessageView> = rows
        .into_iter()
        .map(|(mut m, _)| {
            if let Some(f) = fetched.get(&m.id) {
                m.html = f.html_body.clone();
                m.attachments = f
                    .attachments
                    .iter()
                    .map(|a| AttachmentView { url: crate::db::attachment_url(&m.id, a), meta: a.clone() })
                    .collect();
            }
            m
        })
        .collect();
    let subject = messages.iter().find(|m| !m.subject.is_empty()).map(|m| m.subject.clone()).unwrap_or_default();
    let snoozed_until = st
        .db
        .thread_summaries(&[thread_id.clone()])?
        .into_iter()
        .next()
        .and_then(|s| s.snoozed_until)
        .filter(|u| *u > now_ms());
    Ok(ThreadDetail { thread_id, subject, messages, snoozed_until })
}

/// Shared by the command and the toast "Mark as read" button.
pub async fn set_read(app: &AppHandle, thread_ids: Vec<String>, read: bool) -> anyhow::Result<()> {
    let st = state(app);
    if read {
        st.db.modify_thread_labels(&thread_ids, &[], &["UNREAD"])?;
    } else {
        st.db.modify_thread_labels(&thread_ids, &["UNREAD"], &[])?;
    }
    emit_changed(app);
    for t in &thread_ids {
        let r = if read {
            st.gmail.modify_thread(t, &[], &["UNREAD"]).await
        } else {
            st.gmail.modify_thread(t, &["UNREAD"], &[]).await
        };
        if let Err(e) = r {
            log::warn!("modify failed: {e}");
            st.wake.notify_one();
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mark_read(app: AppHandle, thread_ids: Vec<String>, read: bool) -> R<()> {
    set_read(&app, thread_ids, read).await?;
    Ok(())
}

#[tauri::command]
pub async fn trash_threads(app: AppHandle, st: St<'_>, thread_ids: Vec<String>) -> R<()> {
    st.db.modify_thread_labels(&thread_ids, &["TRASH"], &["INBOX"])?;
    emit_changed(&app);
    for t in &thread_ids {
        st.gmail.trash_thread(t).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn untrash_threads(app: AppHandle, st: St<'_>, thread_ids: Vec<String>) -> R<()> {
    st.db.modify_thread_labels(&thread_ids, &[], &["TRASH"])?;
    emit_changed(&app);
    for t in &thread_ids {
        st.gmail.untrash_thread(t).await?;
    }
    st.wake.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn spam_threads(app: AppHandle, st: St<'_>, thread_ids: Vec<String>, spam: bool) -> R<()> {
    if spam {
        st.db.modify_thread_labels(&thread_ids, &["SPAM"], &["INBOX"])?;
    } else {
        st.db.modify_thread_labels(&thread_ids, &["INBOX"], &["SPAM"])?;
    }
    emit_changed(&app);
    for t in &thread_ids {
        if spam {
            st.gmail.modify_thread(t, &["SPAM"], &["INBOX"]).await?;
        } else {
            st.gmail.modify_thread(t, &["INBOX"], &["SPAM"]).await?;
        }
    }
    Ok(())
}

/// Add or remove Gmail labels on whole threads (Archive takes INBOX away; Star adds STARRED).
/// Only labels the reader's actions use are allowed.
#[tauri::command]
pub async fn label_threads(app: AppHandle, st: St<'_>, thread_ids: Vec<String>, add: Vec<String>, remove: Vec<String>) -> R<()> {
    const ALLOWED: [&str; 3] = ["INBOX", "STARRED", "IMPORTANT"];
    if add.iter().chain(remove.iter()).any(|l| !ALLOWED.contains(&l.as_str())) {
        return Err(CmdError("That label can't be changed here".into()));
    }
    let add: Vec<&str> = add.iter().map(String::as_str).collect();
    let remove: Vec<&str> = remove.iter().map(String::as_str).collect();
    st.db.modify_thread_labels(&thread_ids, &add, &remove)?;
    emit_changed(&app);
    for t in &thread_ids {
        st.gmail.modify_thread(t, &add, &remove).await?;
    }
    Ok(())
}

/// Mute a thread (it leaves the inbox now and whenever a reply arrives) or unmute it.
#[tauri::command]
pub async fn mute_thread(app: AppHandle, st: St<'_>, thread_id: String, muted: bool) -> R<()> {
    st.db.set_muted(&thread_id, muted)?;
    if muted {
        st.db.modify_thread_labels(std::slice::from_ref(&thread_id), &[], &["INBOX"])?;
        emit_changed(&app);
        st.gmail.modify_thread(&thread_id, &[], &["INBOX"]).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn is_muted(st: St<'_>, thread_id: String) -> bool {
    st.db.muted_threads().contains(&thread_id)
}

#[tauri::command]
pub fn snooze_thread(app: AppHandle, st: St<'_>, thread_id: String, until: i64) -> R<()> {
    st.db.snooze(&thread_id, until)?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn unsnooze_thread(app: AppHandle, st: St<'_>, thread_id: String) -> R<()> {
    st.db.unsnooze(&thread_id, false)?;
    emit_changed(&app);
    Ok(())
}

// ---------------- search ----------------

#[tauri::command]
pub fn search_local(st: St<'_>, query: String) -> R<Vec<ThreadSummary>> {
    let q = parse_query(&query);
    if q.fts.is_empty() && q.labels.is_empty() && !q.has_attachment && q.after.is_none() && q.before.is_none() {
        return Ok(vec![]);
    }
    let ids = st.db.search_local(&q, 200)?;
    Ok(st.db.thread_summaries(&ids)?)
}

#[tauri::command]
pub async fn search_remote(app: AppHandle, st: St<'_>, query: String) -> R<Vec<ThreadSummary>> {
    let (ids, _) = st.gmail.list_messages(Some(&query), None, 100, false).await?;
    let id_list: Vec<String> = ids.iter().map(|(i, _)| i.clone()).collect();
    let existing = st.db.existing_ids(&id_list);
    let missing: Vec<String> = id_list.iter().filter(|i| !existing.contains(*i)).cloned().collect();
    if !missing.is_empty() {
        let (msgs, _) = fetch_many(&st, missing, 8).await;
        st.db.store_messages(&msgs, false)?;
        emit_changed(&app);
    }
    let mut seen = HashSet::new();
    let threads: Vec<String> = ids
        .into_iter()
        .map(|(_, t)| t)
        .filter(|t| seen.insert(t.clone()))
        .collect();
    Ok(st.db.thread_summaries(&threads)?)
}

// ---------------- unsubscribe ----------------

#[tauri::command]
pub async fn unsubscribe(app: AppHandle, st: St<'_>, message_id: String) -> R<String> {
    let Some((header, one_click)) = st.db.unsubscribe_info(&message_id) else {
        return err("Message not found");
    };
    let urls: Vec<String> = header
        .split(',')
        .map(|s| s.trim().trim_start_matches('<').trim_end_matches('>').to_string())
        .collect();
    let https = urls.iter().find(|u| u.starts_with("https://") || u.starts_with("http://"));
    let mailto = urls.iter().find(|u| u.to_lowercase().starts_with("mailto:"));
    if let (Some(u), true) = (https, one_click) {
        let r = st
            .http
            .post(u)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body("List-Unsubscribe=One-Click")
            .send()
            .await
            .map_err(|e| CmdError(e.to_string()))?;
        if r.status().is_success() || r.status().is_redirection() {
            return Ok("done".into());
        }
    }
    if let Some(m) = mailto {
        if let Some(parsed) = crate::platform::parse_mailto(m) {
            // Only ever a plain "unsubscribe" note to the one listed address: a header can't add
            // Cc/Bcc recipients or its own message.
            let Some(to) = parsed.to.into_iter().next() else { return err("This unsubscribe address isn't valid.") };
            let c = crate::types::ComposeData {
                to: vec![to],
                subject: "unsubscribe".into(),
                html: "<p>unsubscribe</p>".into(),
                ..Default::default()
            };
            st.db.outbox_add(&c, now_ms(), "undo")?;
            return Ok("mailto".into());
        }
    }
    if let Some(u) = https {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(u, None::<&str>);
        return Ok("opened".into());
    }
    err("This sender doesn't offer an unsubscribe link.")
}
