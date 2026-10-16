//! Turning rows into app types, and writing messages and their conversations.

use super::*;

pub fn attachment_url(msg_id: &str, a: &AttachmentMeta) -> String {
    format!(
        "{}/{}/{}?name={}&mime={}",
        crate::protocols::ATT_BASE,
        msg_id,
        urlencoding::encode(&a.part_id),
        urlencoding::encode(&a.filename),
        urlencoding::encode(&a.mime_type)
    )
}

pub(crate) fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<ThreadSummary> {
    Ok(ThreadSummary {
        folder: r.get(0)?,
        thread_id: r.get(1)?,
        date: r.get(2)?,
        subject: r.get(3)?,
        snippet: r.get(4)?,
        participants: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        count: r.get(6)?,
        unread: r.get::<_, i64>(7)? != 0,
        has_attachments: r.get::<_, i64>(8)? != 0,
        avatar_email: r.get(9)?,
        snoozed_until: r.get(10)?,
    })
}

pub(crate) fn row_to_outbox(r: &rusqlite::Row) -> rusqlite::Result<OutboxItem> {
    Ok(OutboxItem {
        id: r.get(0)?,
        send_at: r.get(1)?,
        kind: r.get(2)?,
        status: r.get(3)?,
        error: r.get(4)?,
        compose: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
    })
}

pub(crate) fn upsert_message(c: &Connection, m: &StoredMessage, keep_html: bool, me: &str) -> Result<()> {
    let existing: Option<i64> = c
        .query_row("SELECT rid FROM messages WHERE id = ?1", [&m.id], |r| r.get(0))
        .optional()?;
    let text = if m.text_body.len() > 200_000 {
        let mut end = 200_000;
        while !m.text_body.is_char_boundary(end) {
            end -= 1;
        }
        &m.text_body[..end]
    } else {
        &m.text_body[..]
    };
    let text_z = compress(text);
    let html_z = if keep_html { m.html_body.as_deref().map(compress) } else { None };
    let html_size = html_z.as_ref().map(|z| z.len() as i64);
    let html_accessed = if html_z.is_some() { Some(now_ms()) } else { None };
    c.execute(
        "INSERT INTO messages (id, thread_id, internal_date, from_name, from_email, to_json, cc_json, bcc_json,
            reply_to_json, subject, snippet, labels, attachments_json, has_attachments, text_z, has_html, html_z,
            html_size, html_accessed, msgid, in_reply_to, refs, list_unsub, list_unsub_post, ics)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
         ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id, labels = excluded.labels, snippet = excluded.snippet,
            attachments_json = excluded.attachments_json, has_attachments = excluded.has_attachments,
            text_z = excluded.text_z, has_html = excluded.has_html,
            html_z = COALESCE(excluded.html_z, messages.html_z),
            html_size = COALESCE(excluded.html_size, messages.html_size),
            html_accessed = COALESCE(excluded.html_accessed, messages.html_accessed),
            ics = COALESCE(excluded.ics, messages.ics)",
        params![
            m.id,
            m.thread_id,
            m.internal_date,
            m.from.name,
            m.from.email.to_lowercase(),
            addrs_json(&m.to),
            addrs_json(&m.cc),
            addrs_json(&m.bcc),
            addrs_json(&m.reply_to),
            m.subject,
            m.snippet,
            labels_str(&m.labels),
            serde_json::to_string(&m.attachments)?,
            m.attachments.iter().any(|a| !a.inline) as i64,
            text_z,
            m.html_body.is_some() as i64,
            html_z,
            html_size,
            html_accessed,
            m.message_id_header,
            m.in_reply_to,
            m.references,
            m.list_unsubscribe,
            m.list_unsubscribe_post as i64,
            m.calendar,
        ],
    )?;
    let rid: i64 = c.query_row("SELECT rid FROM messages WHERE id = ?1", [&m.id], |r| r.get(0))?;
    if existing.is_some() {
        c.execute("DELETE FROM fts WHERE rowid = ?1", [rid])?;
    }
    let recipients = m
        .to
        .iter()
        .chain(m.cc.iter())
        .map(|a| format!("{} {}", a.name, a.email))
        .collect::<Vec<_>>()
        .join(" ");
    let index_body: String = text.chars().take(30_000).collect();
    c.execute(
        "INSERT INTO fts (rowid, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rid, m.subject, format!("{} {}", m.from.name, m.from.email), recipients, index_body],
    )?;

    // Track people we correspond with, for autocomplete.
    if existing.is_none() {
        let is_sent = m.labels.iter().any(|l| l == "SENT");
        let bump = |a: &Address, w: f64| -> Result<()> {
            let e = a.email.to_lowercase();
            if e.is_empty() || e == me || e.contains("noreply") || e.contains("no-reply") {
                return Ok(());
            }
            c.execute(
                "INSERT INTO correspondents (email, name, score, last) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(email) DO UPDATE SET score = score + excluded.score,
                   name = CASE WHEN excluded.name != '' THEN excluded.name ELSE correspondents.name END,
                   last = MAX(last, excluded.last)",
                params![e, a.name, w, m.internal_date],
            )?;
            Ok(())
        };
        if is_sent {
            for a in m.to.iter().chain(m.cc.iter()) {
                bump(a, 3.0)?;
            }
        } else if !m.list_unsubscribe.is_empty() {
            // bulk mail: don't suggest
        } else {
            bump(&m.from, 0.5)?;
        }
    }
    Ok(())
}

/// Recompute the per-folder summary rows for one thread.
pub fn refresh_thread(c: &Connection, thread_id: &str, me: &str) -> Result<()> {
    struct M {
        date: i64,
        from: Address,
        to: Vec<Address>,
        subject: String,
        snippet: String,
        labels: String,
        has_att: bool,
    }
    let msgs: Vec<M> = {
        let mut st = c.prepare_cached(
            "SELECT internal_date, from_name, from_email, to_json, subject, snippet, labels, has_attachments
             FROM messages WHERE thread_id = ?1 ORDER BY internal_date ASC",
        )?;
        let r = st
            .query_map([thread_id], |r| {
                Ok(M {
                    date: r.get(0)?,
                    from: Address { name: r.get(1)?, email: r.get(2)? },
                    to: addrs_from(&r.get::<_, String>(3)?),
                    subject: r.get(4)?,
                    snippet: r.get(5)?,
                    labels: r.get(6)?,
                    has_att: r.get::<_, i64>(7)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        r
    };
    c.execute("DELETE FROM thread_folders WHERE thread_id = ?1", [thread_id])?;
    if msgs.is_empty() {
        c.execute("DELETE FROM snoozes WHERE thread_id = ?1", [thread_id])?;
        return Ok(());
    }
    let snooze: Option<(Option<i64>, Option<i64>)> = c
        .query_row("SELECT until, resurfaced_at FROM snoozes WHERE thread_id = ?1", [thread_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let now = now_ms();
    let snoozed = matches!(snooze, Some((Some(u), _)) if u > now);
    let resurfaced = snooze.and_then(|s| s.1).unwrap_or(0);

    for folder in FOLDERS {
        let relevant: Vec<&M> = msgs
            .iter()
            .filter(|m| {
                let trash = has_label(&m.labels, "TRASH");
                let spam = has_label(&m.labels, "SPAM");
                match folder {
                    "TRASH" => trash,
                    "SPAM" => spam,
                    _ => !trash && !spam,
                }
            })
            .collect();
        if relevant.is_empty() {
            continue;
        }
        let member = match folder {
            "TRASH" | "SPAM" => true,
            f => relevant.iter().any(|m| has_label(&m.labels, f)),
        };
        if !member {
            continue;
        }
        let name = if folder == "INBOX" && snoozed { "SNOOZED" } else { folder };
        let last = relevant.last().unwrap();
        let mut sort_date = last.date;
        if folder == "INBOX" {
            sort_date = sort_date.max(resurfaced);
        }
        let unread = relevant.iter().any(|m| has_label(&m.labels, "UNREAD"));
        let subject = relevant
            .iter()
            .find(|m| !m.subject.is_empty())
            .map(|m| m.subject.clone())
            .unwrap_or_default();
        let has_att = relevant.iter().any(|m| m.has_att);

        let mut parts: Vec<Participant> = Vec::new();
        let mut avatar = String::new();
        if folder == "SENT" || folder == "DRAFT" {
            for m in &relevant {
                for a in &m.to {
                    let e = a.email.to_lowercase();
                    if !parts.iter().any(|p| p.email == e) {
                        parts.push(Participant { name: a.display(), email: e.clone(), is_me: e == me, unread: false });
                    }
                }
            }
            avatar = parts.iter().find(|p| !p.is_me).map(|p| p.email.clone()).unwrap_or_default();
        } else {
            for m in &relevant {
                let e = m.from.email.to_lowercase();
                let u = has_label(&m.labels, "UNREAD");
                if let Some(p) = parts.iter_mut().find(|p| p.email == e) {
                    p.unread |= u;
                } else {
                    parts.push(Participant { name: m.from.display(), email: e.clone(), is_me: e == me, unread: u });
                }
                if e != me {
                    avatar = e;
                }
            }
            if avatar.is_empty() {
                avatar = last.from.email.to_lowercase();
            }
        }
        c.execute(
            "INSERT INTO thread_folders (folder, thread_id, sort_date, subject, snippet, participants_json, msg_count,
                unread, has_attachments, avatar_email) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                name,
                thread_id,
                sort_date,
                subject,
                last.snippet,
                serde_json::to_string(&parts)?,
                relevant.len() as i64,
                unread as i64,
                has_att as i64,
                avatar
            ],
        )?;
    }
    Ok(())
}
