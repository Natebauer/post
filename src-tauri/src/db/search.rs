//! Search: the local full-text index and the query parser (from:, has:, before: …).

use super::*;

impl Db {
    // ---------- search ----------

    pub fn search_local(&self, q: &ParsedQuery, limit: i64) -> Result<Vec<String>> {
        let c = self.r.lock().unwrap();
        let mut sql = String::from("SELECT m.thread_id, MAX(m.internal_date) AS d FROM messages m");
        let mut wh: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if !q.fts.is_empty() {
            sql.push_str(" JOIN fts ON fts.rowid = m.rid");
            wh.push(format!("fts MATCH ?{}", args.len() + 1));
            args.push(q.fts.clone().into());
        }
        for l in &q.labels {
            wh.push(format!("m.labels LIKE ?{}", args.len() + 1));
            args.push(format!("%,{},%", l).into());
        }
        if !q.include_trash {
            wh.push("m.labels NOT LIKE '%,TRASH,%' AND m.labels NOT LIKE '%,SPAM,%'".into());
        }
        if q.has_attachment {
            wh.push("m.has_attachments = 1".into());
        }
        if let Some(a) = q.after {
            wh.push(format!("m.internal_date >= ?{}", args.len() + 1));
            args.push(a.into());
        }
        if let Some(b) = q.before {
            wh.push(format!("m.internal_date < ?{}", args.len() + 1));
            args.push(b.into());
        }
        if !wh.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wh.join(" AND "));
        }
        sql.push_str(&format!(" GROUP BY m.thread_id ORDER BY d DESC LIMIT {}", limit));
        let mut st = c.prepare(&sql)?;
        let r = st
            .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(r)
    }

    /// A conversation's latest messages as plain text (newest first), for answering questions.
    /// (from name, from email, date, subject, text)
    pub fn thread_attachments(&self, thread_id: &str) -> Result<Vec<(String, AttachmentMeta)>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare_cached(
            "SELECT id, attachments_json FROM messages WHERE thread_id = ?1 ORDER BY internal_date ASC",
        )?;
        let rows = st
            .query_map([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .flat_map(|(id, json)| {
                serde_json::from_str::<Vec<AttachmentMeta>>(&json)
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |a| (id.clone(), a))
            })
            .collect())
    }

    /// Whether a conversation has a calendar invitation in it (inline or as an attached file).
    pub fn thread_has_invite(&self, thread_id: &str) -> bool {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT 1 FROM messages WHERE thread_id = ?1
               AND ((ics IS NOT NULL AND ics != '') OR attachments_json LIKE '%text/calendar%') LIMIT 1",
            params![thread_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Whether a conversation is in the inbox, and whether any of it is unread.
    pub fn thread_flags(&self, thread_id: &str) -> (bool, bool) {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT MAX(labels LIKE '%,INBOX,%'), MAX(labels LIKE '%,UNREAD,%') FROM messages WHERE thread_id = ?1",
            params![thread_id],
            |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0) > 0, r.get::<_, Option<i64>>(1)?.unwrap_or(0) > 0)),
        )
        .unwrap_or((false, false))
    }

    pub fn thread_text(&self, thread_id: &str, max_msgs: i64) -> Result<Vec<(String, String, i64, String, String)>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare_cached(
            "SELECT from_name, from_email, internal_date, subject, snippet, text_z FROM messages
             WHERE thread_id = ?1 ORDER BY internal_date DESC LIMIT ?2",
        )?;
        let rows = st
            .query_map(params![thread_id, max_msgs], |r| {
                let text_z: Option<Vec<u8>> = r.get(5)?;
                let snippet: String = r.get(4)?;
                let text = text_z.map(|z| decompress(&z)).filter(|t| !t.trim().is_empty()).unwrap_or(snippet);
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, text))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn wipe(&self) -> Result<()> {
        let c = self.w.lock().unwrap();
        c.execute_batch(
            "DELETE FROM messages; DELETE FROM fts; DELETE FROM thread_folders; DELETE FROM snoozes;
             DELETE FROM outbox; DELETE FROM contacts; DELETE FROM correspondents; DELETE FROM avatars;
             DELETE FROM kv WHERE k != 'settings' AND k != 'client_id';",
        )?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct ParsedQuery {
    pub fts: String,
    pub labels: Vec<String>,
    pub include_trash: bool,
    pub has_attachment: bool,
    pub after: Option<i64>,
    pub before: Option<i64>,
}

pub(crate) fn fts_phrase(s: &str) -> String {
    format!("\"{}\"", s.replace('"', ""))
}

pub(crate) fn parse_date(s: &str) -> Option<i64> {
    let s = s.replace('/', "-");
    chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp_millis())
}

/// Parse a Gmail-style query into FTS + SQL filters.
pub fn parse_query(q: &str) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    let mut terms: Vec<String> = Vec::new();
    // tokenize respecting quotes
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut inq = false;
    for ch in q.chars() {
        match ch {
            '"' => {
                inq = !inq;
                cur.push(ch);
            }
            c if c.is_whitespace() && !inq => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    for t in tokens {
        let (k, v) = match t.split_once(':') {
            Some((k, v)) if !v.is_empty() => (k.to_lowercase(), v.trim_matches('"').to_string()),
            _ => (String::new(), t.trim_matches('"').to_string()),
        };
        match k.as_str() {
            "from" => terms.push(format!("sender : {}", fts_phrase(&v))),
            "to" | "cc" => terms.push(format!("recipients : {}", fts_phrase(&v))),
            "subject" => terms.push(format!("subject : {}", fts_phrase(&v))),
            "has" if v.eq_ignore_ascii_case("attachment") => out.has_attachment = true,
            "is" => match v.to_lowercase().as_str() {
                "unread" => out.labels.push("UNREAD".into()),
                "starred" => out.labels.push("STARRED".into()),
                _ => {}
            },
            "in" => match v.to_lowercase().as_str() {
                "inbox" => out.labels.push("INBOX".into()),
                "sent" => out.labels.push("SENT".into()),
                "drafts" | "draft" => out.labels.push("DRAFT".into()),
                "trash" => {
                    out.labels.push("TRASH".into());
                    out.include_trash = true;
                }
                "spam" => {
                    out.labels.push("SPAM".into());
                    out.include_trash = true;
                }
                "anywhere" => out.include_trash = true,
                _ => {}
            },
            "after" | "newer" => out.after = parse_date(&v),
            "before" | "older" => out.before = parse_date(&v),
            _ => {
                let v = if k.is_empty() { v } else { t.replace(':', " ") };
                let clean: String = v.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '@' || *c == '.' || *c == '-' || *c == '_').collect();
                for w in clean.split_whitespace() {
                    // phrase-ify tokens with punctuation, prefix-match the rest
                    if w.chars().all(|c| c.is_alphanumeric()) {
                        terms.push(format!("{}*", fts_phrase(w)));
                    } else {
                        terms.push(fts_phrase(w));
                    }
                }
            }
        }
    }
    out.fts = terms.join(" AND ");
    out
}
