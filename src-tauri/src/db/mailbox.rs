//! Messages, conversations, labels, settings and the key-value store.

use super::*;

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        let w = Connection::open(path)?;
        // Wait out locks first: a just-quit instance may still be finishing a write.
        w.busy_timeout(std::time::Duration::from_secs(10))?;
        w.execute_batch(SCHEMA)?;
        migrate(&w)?;
        let mut conns = Vec::new();
        for _ in 0..4 {
            let r = Connection::open(path)?;
            r.busy_timeout(std::time::Duration::from_secs(10))?;
            r.execute_batch("PRAGMA query_only = 1;")?;
            conns.push(Mutex::new(r));
        }
        Ok(Db { w: Mutex::new(w), r: ReadPool { conns, next: Default::default() } })
    }

    pub fn kv_get(&self, k: &str) -> Option<String> {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT v FROM kv WHERE k = ?1", [k], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn kv_set(&self, k: &str, v: &str) -> Result<()> {
        let c = self.w.lock().unwrap();
        c.execute(
            "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![k, v],
        )?;
        Ok(())
    }

    pub fn kv_del(&self, k: &str) -> Result<()> {
        self.w.lock().unwrap().execute("DELETE FROM kv WHERE k = ?1", [k])?;
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        self.kv_get("settings")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Post's default accent moved from periwinkle to the icon's teal: carry over anyone still on
    /// the old default (once, so picking periwinkle again later sticks).
    pub fn migrate_accent_default(&self) {
        if self.kv_get("accent_default_v2").is_some() {
            return;
        }
        let mut s = self.settings();
        if s.accent.eq_ignore_ascii_case("#5b74e8") {
            s.accent = crate::types::DEFAULT_ACCENT.into();
            if let Ok(json) = serde_json::to_string(&s) {
                let _ = self.kv_set("settings", &json);
            }
        }
        let _ = self.kv_set("accent_default_v2", "1");
    }

    /// Threads the user muted: new replies skip the inbox and don't notify. Gmail's API has no
    /// mute, so Post keeps the list itself.
    pub fn muted_threads(&self) -> std::collections::HashSet<String> {
        self.kv_get("muted_threads")
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .collect()
    }

    pub fn set_muted(&self, thread_id: &str, muted: bool) -> Result<()> {
        // Read and write the list under the write lock, so two quick mutes can't lose one.
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        let mut set: std::collections::HashSet<String> = tx
            .query_row("SELECT v FROM kv WHERE k = 'muted_threads'", [], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        if muted {
            set.insert(thread_id.to_string());
        } else {
            set.remove(thread_id);
        }
        let json = serde_json::to_string(&set.iter().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT INTO kv (k, v) VALUES ('muted_threads', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [json],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Forget "already nudged" marks for messages that are no longer on this computer.
    pub fn prune_kv(&self) {
        let c = self.w.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM kv WHERE k LIKE 'nudged:%' AND substr(k, 8) NOT IN (SELECT id FROM messages)",
            [],
        );
    }

    pub fn my_email(&self) -> String {
        self.kv_get("email").unwrap_or_default().to_lowercase()
    }

    pub fn message_exists(&self, id: &str) -> bool {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT 1 FROM messages WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn existing_ids(&self, ids: &[String]) -> HashSet<String> {
        let c = self.r.lock().unwrap();
        let mut out = HashSet::new();
        let mut st = c.prepare_cached("SELECT 1 FROM messages WHERE id = ?1").unwrap();
        for id in ids {
            if st.exists([id]).unwrap_or(false) {
                out.insert(id.clone());
            }
        }
        out
    }

    /// Insert or update messages, refresh their threads. Returns touched thread ids.
    pub fn store_messages(&self, msgs: &[StoredMessage], keep_html: bool) -> Result<HashSet<String>> {
        let me = self.my_email();
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        let mut threads = HashSet::new();
        for m in msgs {
            upsert_message(&tx, m, keep_html, &me)?;
            threads.insert(m.thread_id.clone());
        }
        for t in &threads {
            refresh_thread(&tx, t, &me)?;
        }
        tx.commit()?;
        Ok(threads)
    }

    pub fn update_html(&self, id: &str, html: &str, attachments: &[AttachmentMeta]) -> Result<()> {
        let c = self.w.lock().unwrap();
        let z = compress(html);
        c.execute(
            "UPDATE messages SET html_z = ?2, html_size = ?3, html_accessed = ?4, attachments_json = ?5 WHERE id = ?1",
            params![id, z, z.len() as i64, now_ms(), serde_json::to_string(attachments)?],
        )?;
        Ok(())
    }

    pub fn update_attachments(&self, id: &str, attachments: &[AttachmentMeta]) -> Result<()> {
        let c = self.w.lock().unwrap();
        c.execute(
            "UPDATE messages SET attachments_json = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(attachments)?],
        )?;
        Ok(())
    }

    /// Replace the label set of messages (from history records).
    pub fn set_labels(&self, changes: &[(String, Vec<String>)]) -> Result<HashSet<String>> {
        let me = self.my_email();
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        let mut threads = HashSet::new();
        for (id, labels) in changes {
            let t: Option<String> = tx
                .query_row("SELECT thread_id FROM messages WHERE id = ?1", [id], |r| r.get(0))
                .optional()?;
            if let Some(t) = t {
                tx.execute("UPDATE messages SET labels = ?2 WHERE id = ?1", params![id, labels_str(labels)])?;
                threads.insert(t);
            }
        }
        for t in &threads {
            refresh_thread(&tx, t, &me)?;
        }
        tx.commit()?;
        Ok(threads)
    }

    /// Add/remove labels on all messages of the given threads (optimistic local update).
    pub fn modify_thread_labels(&self, thread_ids: &[String], add: &[&str], remove: &[&str]) -> Result<()> {
        let me = self.my_email();
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        for t in thread_ids {
            let rows: Vec<(String, String)> = {
                let mut st = tx.prepare("SELECT id, labels FROM messages WHERE thread_id = ?1")?;
                let r = st
                    .query_map([t], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                r
            };
            for (id, labels) in rows {
                let mut set: Vec<String> = labels_vec(&labels);
                set.retain(|l| !remove.contains(&l.as_str()));
                for a in add {
                    if !set.iter().any(|l| l == a) {
                        set.push(a.to_string());
                    }
                }
                tx.execute("UPDATE messages SET labels = ?2 WHERE id = ?1", params![id, labels_str(&set)])?;
            }
            refresh_thread(&tx, t, &me)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_messages(&self, ids: &[String]) -> Result<HashSet<String>> {
        let me = self.my_email();
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        let mut threads = HashSet::new();
        for id in ids {
            let row: Option<(i64, String)> = tx
                .query_row("SELECT rid, thread_id FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            if let Some((rid, t)) = row {
                tx.execute("DELETE FROM fts WHERE rowid = ?1", [rid])?;
                tx.execute("DELETE FROM messages WHERE rid = ?1", [rid])?;
                threads.insert(t);
            }
        }
        for t in &threads {
            refresh_thread(&tx, t, &me)?;
        }
        tx.commit()?;
        Ok(threads)
    }

    pub fn list_threads(&self, folder: &str, offset: i64, limit: i64) -> Result<(Vec<ThreadSummary>, i64)> {
        if let Some(key) = folder.strip_prefix("sec:") {
            return self.list_section(key, offset, limit);
        }
        let c = self.r.lock().unwrap();
        let total: i64 = c.query_row(
            "SELECT COUNT(*) FROM thread_folders WHERE folder = ?1",
            [folder],
            |r| r.get(0),
        )?;
        let mut st = c.prepare_cached(
            "SELECT tf.folder, tf.thread_id, tf.sort_date, tf.subject, tf.snippet, tf.participants_json, tf.msg_count,
                    tf.unread, tf.has_attachments, tf.avatar_email, s.until
             FROM thread_folders tf LEFT JOIN snoozes s ON s.thread_id = tf.thread_id
             WHERE tf.folder = ?1 ORDER BY tf.sort_date DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = st
            .query_map(params![folder, limit, offset], row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, total))
    }

    pub fn thread_summaries(&self, thread_ids: &[String]) -> Result<Vec<ThreadSummary>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare_cached(
            "SELECT tf.folder, tf.thread_id, tf.sort_date, tf.subject, tf.snippet, tf.participants_json, tf.msg_count,
                    tf.unread, tf.has_attachments, tf.avatar_email, s.until
             FROM thread_folders tf LEFT JOIN snoozes s ON s.thread_id = tf.thread_id
             WHERE tf.thread_id = ?1
             ORDER BY CASE tf.folder WHEN 'INBOX' THEN 0 WHEN 'SNOOZED' THEN 1 WHEN 'SENT' THEN 2
                      WHEN 'DRAFT' THEN 3 WHEN 'SPAM' THEN 4 ELSE 5 END LIMIT 1",
        )?;
        let mut out = Vec::new();
        for t in thread_ids {
            if let Some(s) = st.query_row([t], row_to_summary).optional()? {
                out.push(s);
            }
        }
        Ok(out)
    }

    pub fn ai_record(&self, ts: i64, model: &str, purpose: &str, input: i64, output: i64, cost: f64) -> Result<()> {
        let c = self.w.lock().unwrap();
        c.execute(
            "INSERT INTO ai_usage (ts, model, purpose, input_tokens, output_tokens, cost_usd) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ts, model, purpose, input, output, cost],
        )?;
        Ok(())
    }

    /// (total USD, number of calls) since a timestamp.
    pub fn ai_spend_since(&self, ts: i64) -> (f64, i64) {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM ai_usage WHERE ts >= ?1",
            [ts],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0.0, 0))
    }

    pub fn unread_threads(&self, folder: &str) -> Vec<String> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare("SELECT thread_id FROM thread_folders WHERE folder = ?1 AND unread = 1").unwrap();
        st.query_map([folder], |r| r.get(0))
            .map(|r| r.flatten().collect())
            .unwrap_or_default()
    }

    pub fn inbox_unread(&self) -> i64 {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM thread_folders WHERE folder = 'INBOX' AND unread = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Sidebar badges: folders plus the user's sections.
    pub fn folder_counts(&self) -> HashMap<String, i64> {
        let mut out = self.mailbox_counts();
        let sections = self.settings().sender_views;
        if !sections.is_empty() {
            out.extend(self.section_unread(&sections));
        }
        out
    }

    pub(crate) fn mailbox_counts(&self) -> HashMap<String, i64> {
        let c = self.r.lock().unwrap();
        let mut out = HashMap::new();
        if let Ok(mut st) = c.prepare(
            "SELECT folder, SUM(unread), COUNT(*) FROM thread_folders GROUP BY folder",
        ) {
            let rows = st.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            });
            if let Ok(rows) = rows {
                for (f, unread, total) in rows.flatten() {
                    // Inbox/Spam show unread; Drafts/Snoozed show totals.
                    let n = match f.as_str() {
                        "DRAFT" | "SNOOZED" => total,
                        "INBOX" | "SPAM" => unread,
                        _ => 0,
                    };
                    out.insert(f, n);
                }
            }
        }
        out
    }

    /// Messages of a thread relevant to the given folder, oldest first.
    pub fn thread_messages(&self, thread_id: &str, folder: &str) -> Result<Vec<(MessageView, bool)>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare_cached(
            "SELECT id, thread_id, internal_date, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
                    subject, snippet, labels, attachments_json, text_z, has_html, html_z, msgid, refs, list_unsub, ics
             FROM messages WHERE thread_id = ?1 ORDER BY internal_date ASC",
        )?;
        let rows = st
            .query_map([thread_id], |r| {
                let labels: String = r.get(11)?;
                let text_z: Option<Vec<u8>> = r.get(13)?;
                let has_html: bool = r.get::<_, i64>(14)? != 0;
                let html_z: Option<Vec<u8>> = r.get(15)?;
                let atts: Vec<AttachmentMeta> =
                    serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default();
                let id: String = r.get(0)?;
                let attachments = atts
                    .into_iter()
                    .map(|meta| AttachmentView {
                        url: attachment_url(&id, &meta),
                        meta,
                    })
                    .collect();
                let need_fetch = has_html && html_z.is_none();
                Ok((
                    MessageView {
                        id,
                        thread_id: r.get(1)?,
                        date: r.get(2)?,
                        from: Address { name: r.get(3)?, email: r.get(4)? },
                        to: addrs_from(&r.get::<_, String>(5)?),
                        cc: addrs_from(&r.get::<_, String>(6)?),
                        bcc: addrs_from(&r.get::<_, String>(7)?),
                        reply_to: addrs_from(&r.get::<_, String>(8)?),
                        subject: r.get(9)?,
                        snippet: r.get(10)?,
                        unread: has_label(&labels, "UNREAD"),
                        is_draft: has_label(&labels, "DRAFT"),
                        labels: labels_vec(&labels),
                        attachments,
                        text: text_z.map(|z| decompress(&z)).unwrap_or_default(),
                        html: html_z.map(|z| decompress(&z)),
                        message_id_header: r.get(16)?,
                        references: r.get(17)?,
                        can_unsubscribe: !r.get::<_, String>(18)?.is_empty(),
                        ics: r.get(19)?,
                    },
                    need_fetch,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let rows = rows
            .into_iter()
            .filter(|(m, _)| {
                let trash = m.labels.iter().any(|l| l == "TRASH");
                let spam = m.labels.iter().any(|l| l == "SPAM");
                match folder {
                    "TRASH" => trash,
                    "SPAM" => spam,
                    _ => !trash && !spam,
                }
            })
            .collect::<Vec<_>>();
        Ok(rows)
    }

    pub fn touch_html(&self, ids: &[String]) {
        let mut c = self.w.lock().unwrap();
        let now = now_ms();
        // One transaction for the whole thread instead of a disk write per message.
        let Ok(tx) = c.transaction() else { return };
        for id in ids {
            let _ = tx.execute("UPDATE messages SET html_accessed = ?2 WHERE id = ?1 AND html_z IS NOT NULL", params![id, now]);
        }
        let _ = tx.commit();
    }

    pub fn message_attachments(&self, id: &str) -> Option<Vec<AttachmentMeta>> {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT attachments_json FROM messages WHERE id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .map(|s| serde_json::from_str(&s).unwrap_or_default())
    }

    pub fn thread_messages_thread(&self, id: &str) -> Option<String> {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT thread_id FROM messages WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn unsubscribe_info(&self, id: &str) -> Option<(String, bool)> {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT list_unsub, list_unsub_post FROM messages WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Drop cached HTML outside the recent window, keeping recently opened bodies up to `cap_bytes`.
    pub fn prune_html(&self, recent: i64, cap_bytes: i64) -> Result<usize> {
        let c = self.w.lock().unwrap();
        let n = c.execute(
            "UPDATE messages SET html_z = NULL, html_size = NULL WHERE rid IN (
               SELECT rid FROM (
                 SELECT rid, SUM(html_size) OVER (ORDER BY COALESCE(html_accessed, 0) DESC, internal_date DESC) AS cum
                 FROM messages
                 WHERE html_z IS NOT NULL
                   AND rid NOT IN (SELECT rid FROM messages ORDER BY internal_date DESC LIMIT ?1)
               ) WHERE cum > ?2
             )",
            params![recent, cap_bytes],
        )?;
        Ok(n)
    }
}
