//! The home screen: a summary of what matters, built from the local index.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::db::{addrs_from, now_ms, Db};
use crate::types::AttachmentMeta;

const DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeItem {
    pub thread_id: String,
    pub message_id: String,
    pub name: String,
    pub email: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    /// Card-specific label: package status, "AI", etc.
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeAttachment {
    pub thread_id: String,
    pub message_id: String,
    pub from: String,
    pub date: i64,
    #[serde(flatten)]
    pub meta: AttachmentMeta,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeInvite {
    pub thread_id: String,
    pub message_id: String,
    pub subject: String,
    pub ics: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub received_today: i64,
    pub people_today: i64,
    pub unread: i64,
    pub waiting: Vec<HomeItem>,
    /// True when "waiting on you" has been filtered by AI.
    pub waiting_ai: bool,
    pub no_reply: Vec<HomeItem>,
    pub pinned: Vec<HomeItem>,
    pub packages: Vec<HomeItem>,
    pub trips: Vec<HomeItem>,
    pub invites: Vec<HomeInvite>,
    pub attachments: Vec<HomeAttachment>,
}

/// SQL fragment: mail written by a person (not bulk, not automated).
const PERSON: &str = "m.list_unsub = '' AND m.from_email NOT LIKE '%noreply%' AND m.from_email NOT LIKE '%no-reply%'
  AND m.from_email NOT LIKE '%notification%' AND m.from_email NOT LIKE '%donotreply%' AND m.from_email NOT LIKE '%mailer%'
  AND m.labels NOT LIKE '%,CATEGORY_PROMOTIONS,%' AND m.labels NOT LIKE '%,CATEGORY_UPDATES,%'
  AND m.labels NOT LIKE '%,CATEGORY_SOCIAL,%' AND m.labels NOT LIKE '%,CATEGORY_FORUMS,%'";

/// SQL fragment: this message is the newest live message in its thread.
const LATEST: &str = "m.internal_date = (SELECT MAX(x.internal_date) FROM messages x WHERE x.thread_id = m.thread_id
  AND x.labels NOT LIKE '%,TRASH,%' AND x.labels NOT LIKE '%,SPAM,%' AND x.labels NOT LIKE '%,DRAFT,%')";

fn local_midnight() -> i64 {
    use chrono::TimeZone;
    let now = chrono::Local::now();
    chrono::Local
        .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms() - DAY)
}

fn item(r: &rusqlite::Row) -> rusqlite::Result<HomeItem> {
    Ok(HomeItem {
        message_id: r.get(0)?,
        thread_id: r.get(1)?,
        name: r.get(2)?,
        email: r.get(3)?,
        subject: r.get(4)?,
        snippet: r.get(5)?,
        date: r.get(6)?,
        tag: None,
    })
}

const COLS: &str = "m.id, m.thread_id, m.from_name, m.from_email, m.subject, m.snippet, m.internal_date";

/// Classify a shipping email's status from its subject.
fn package_status(subject: &str) -> Option<&'static str> {
    let s = subject.to_lowercase();
    if s.contains("delivered") {
        Some("Delivered")
    } else if s.contains("out for delivery") {
        Some("Out for delivery")
    } else if s.contains("arriving") || s.contains("arrives") || s.contains("on the way") || s.contains("on its way") {
        Some("On the way")
    } else if s.contains("shipped") || s.contains("has shipped") || s.contains("shipment") {
        Some("Shipped")
    } else if s.contains("delayed") || s.contains("delay") {
        Some("Delayed")
    } else {
        None
    }
}

impl Db {
    /// Candidates for "waiting on you": the newest message in an inbox thread was written to me
    /// by a person in the last 3 weeks, and I haven't replied since.
    pub fn waiting_candidates(&self, limit: i64) -> Result<Vec<HomeItem>> {
        let me = self.my_email();
        let c = self.r.lock().unwrap();
        let sql = format!(
            "SELECT {COLS} FROM messages m WHERE m.internal_date > ?1 AND m.labels LIKE '%,INBOX,%'
               AND m.labels NOT LIKE '%,SENT,%' AND m.from_email != ?2 AND {PERSON} AND {LATEST}
               AND (m.to_json LIKE ?3 OR m.cc_json LIKE ?3)
               AND m.thread_id NOT IN (SELECT thread_id FROM snoozes WHERE until IS NOT NULL)
             ORDER BY m.internal_date DESC LIMIT ?4"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st
            .query_map(params![now_ms() - 21 * DAY, me, format!("%{me}%"), limit], item)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn ai_verdict(&self, message_id: &str, kind: &str) -> Option<bool> {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT verdict FROM ai_verdicts WHERE message_id = ?1 AND kind = ?2",
            params![message_id, kind],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|v| v != 0)
    }

    pub fn set_ai_verdicts(&self, kind: &str, verdicts: &[(String, bool)]) -> Result<()> {
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        for (id, v) in verdicts {
            tx.execute(
                "INSERT INTO ai_verdicts (message_id, kind, verdict, ts) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(message_id, kind) DO UPDATE SET verdict = excluded.verdict, ts = excluded.ts",
                params![id, kind, *v as i64, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_pinned(&self, thread_id: &str, pinned: bool) -> Result<()> {
        let c = self.w.lock().unwrap();
        if pinned {
            c.execute(
                "INSERT INTO pins (thread_id, pinned_at) VALUES (?1, ?2) ON CONFLICT(thread_id) DO NOTHING",
                params![thread_id, now_ms()],
            )?;
        } else {
            c.execute("DELETE FROM pins WHERE thread_id = ?1", [thread_id])?;
        }
        Ok(())
    }

    pub fn is_pinned(&self, thread_id: &str) -> bool {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT 1 FROM pins WHERE thread_id = ?1", [thread_id], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    /// Sent messages still without a reply after `after_days`.
    pub fn no_reply(&self, after_days: i64, limit: i64) -> Result<Vec<HomeItem>> {
        let c = self.r.lock().unwrap();
        let sql = format!(
            "SELECT m.id, m.thread_id, '', '', m.subject, m.snippet, m.internal_date, m.to_json FROM messages m
             WHERE m.labels LIKE '%,SENT,%' AND m.internal_date < ?1 AND m.internal_date > ?2 AND {LATEST}
               AND m.to_json NOT LIKE '%noreply%' AND m.to_json NOT LIKE '%no-reply%' AND m.to_json != '[]'
             ORDER BY m.internal_date DESC LIMIT ?3"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st
            .query_map(params![now_ms() - after_days * DAY, now_ms() - 30 * DAY, limit], |r| {
                let mut it = item(r)?;
                if let Some(a) = addrs_from(&r.get::<_, String>(7)?).into_iter().next() {
                    it.name = a.display();
                    it.email = a.email;
                }
                Ok(it)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn home(&self) -> Result<Home> {
        let me = self.my_email();
        let midnight = local_midnight();

        // Waiting on you: AI verdicts when available, otherwise the heuristic list.
        let candidates = self.waiting_candidates(40)?;
        let any_verdict = candidates.iter().any(|m| self.ai_verdict(&m.message_id, "needs_reply").is_some());
        let waiting: Vec<HomeItem> = candidates
            .into_iter()
            .filter(|m| self.ai_verdict(&m.message_id, "needs_reply").unwrap_or(true))
            .take(8)
            .collect();
        let no_reply = self.no_reply(3, 6)?;

        let c = self.r.lock().unwrap();
        let count = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> i64 { c.query_row(sql, p, |r| r.get(0)).unwrap_or(0) };
        let received_today = count(
            "SELECT COUNT(*) FROM messages m WHERE m.internal_date >= ?1 AND m.labels LIKE '%,INBOX,%' AND m.labels NOT LIKE '%,SENT,%'",
            &[&midnight],
        );
        let people_today = count(
            &format!(
                "SELECT COUNT(*) FROM messages m WHERE m.internal_date >= ?1 AND m.labels LIKE '%,INBOX,%' AND m.labels NOT LIKE '%,SENT,%' AND {PERSON}"
            ),
            &[&midnight],
        );
        let unread = count("SELECT COUNT(*) FROM thread_folders WHERE folder = 'INBOX' AND unread = 1", &[]);

        // Pinned conversations (newest message shown).
        let pinned = {
            let mut st = c.prepare(&format!(
                "SELECT {COLS} FROM pins p JOIN messages m ON m.thread_id = p.thread_id
                 WHERE {LATEST} ORDER BY p.pinned_at DESC LIMIT 20"
            ))?;
            let r = st.query_map([], item)?.collect::<rusqlite::Result<Vec<_>>>()?;
            r
        };

        // Packages: newest shipping update per thread from the last 3 weeks.
        let packages = {
            let mut st = c.prepare(&format!(
                "SELECT {COLS} FROM messages m WHERE m.internal_date > ?1 AND m.labels NOT LIKE '%,SENT,%'
                   AND m.labels NOT LIKE '%,TRASH,%' AND m.labels NOT LIKE '%,SPAM,%' AND (
                   m.subject LIKE '%shipped%' OR m.subject LIKE '%delivered%' OR m.subject LIKE '%out for delivery%'
                   OR m.subject LIKE '%arriving%' OR m.subject LIKE '%on its way%' OR m.subject LIKE '%on the way%'
                   OR m.subject LIKE '%shipment%' OR m.subject LIKE '%delayed%')
                 ORDER BY m.internal_date DESC LIMIT 60"
            ))?;
            let rows = st.query_map([now_ms() - 21 * DAY], item)?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for mut it in rows {
                let Some(status) = package_status(&it.subject) else { continue };
                if !seen.insert(it.thread_id.clone()) {
                    continue;
                }
                // Delivered items drop off after two days.
                if status == "Delivered" && it.date < now_ms() - 2 * DAY {
                    continue;
                }
                it.tag = Some(status.to_string());
                out.push(it);
                if out.len() >= 6 {
                    break;
                }
            }
            out
        };

        // Trips and events: travel confirmations and event registrations from the last 45 days.
        let trips = {
            let mut st = c.prepare(&format!(
                "SELECT {COLS} FROM messages m WHERE m.internal_date > ?1 AND m.labels NOT LIKE '%,SENT,%'
                   AND m.labels NOT LIKE '%,TRASH,%' AND m.labels NOT LIKE '%,SPAM,%' AND (
                   m.subject LIKE '%flight%' OR m.subject LIKE '%itinerary%' OR m.subject LIKE '%boarding pass%'
                   OR m.subject LIKE '%reservation%' OR m.subject LIKE '%booking%' OR m.subject LIKE '%check-in%'
                   OR m.subject LIKE '%trip to%' OR m.subject LIKE '%hotel%'
                   OR (m.from_email LIKE '%luma%' AND (m.subject LIKE '%registered%' OR m.subject LIKE '%going%'
                       OR m.subject LIKE '%reminder%' OR m.subject LIKE '%starting%' OR m.subject LIKE '%tomorrow%')))
                   AND m.subject NOT LIKE '%sale%' AND m.subject NOT LIKE '%deal%' AND m.subject NOT LIKE '% off%'
                 ORDER BY m.internal_date DESC LIMIT 30"
            ))?;
            let rows = st.query_map([now_ms() - 45 * DAY], item)?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut seen = HashSet::new();
            rows.into_iter().filter(|r| seen.insert(r.thread_id.clone())).take(6).collect::<Vec<_>>()
        };

        // Calendar invites from mail (the UI parses dates and keeps upcoming ones).
        let invites = {
            let mut st = c.prepare(
                "SELECT m.id, m.thread_id, m.subject, m.ics FROM messages m WHERE m.ics IS NOT NULL
                   AND m.internal_date > ?1 AND m.labels NOT LIKE '%,TRASH,%' ORDER BY m.internal_date DESC LIMIT 25",
            )?;
            let r = st
                .query_map([now_ms() - 90 * DAY], |r| {
                    Ok(HomeInvite { message_id: r.get(0)?, thread_id: r.get(1)?, subject: r.get(2)?, ics: r.get(3)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        };

        // Recent attachments people sent.
        let attachments = {
            let mut st = c.prepare(
                "SELECT m.id, m.thread_id, m.from_name, m.from_email, m.internal_date, m.attachments_json FROM messages m
                 WHERE m.has_attachments = 1 AND m.from_email != ?1 AND m.labels NOT LIKE '%,SENT,%'
                   AND m.labels NOT LIKE '%,TRASH,%' AND m.labels NOT LIKE '%,SPAM,%'
                 ORDER BY m.internal_date DESC LIMIT 20",
            )?;
            let rows = st
                .query_map([&me], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut out = Vec::new();
            for (id, thread, name, email, date, json) in rows {
                let metas: Vec<AttachmentMeta> = serde_json::from_str(&json).unwrap_or_default();
                for meta in metas.into_iter().filter(|a| !a.inline && !a.mime_type.contains("calendar")) {
                    out.push(HomeAttachment {
                        url: crate::db::attachment_url(&id, &meta),
                        thread_id: thread.clone(),
                        message_id: id.clone(),
                        from: if name.is_empty() { email.clone() } else { name.clone() },
                        date,
                        meta,
                    });
                    if out.len() >= 8 {
                        break;
                    }
                }
                if out.len() >= 8 {
                    break;
                }
            }
            out
        };

        Ok(Home {
            received_today,
            people_today,
            unread,
            waiting,
            waiting_ai: any_verdict,
            no_reply,
            pinned,
            packages,
            trips,
            invites,
            attachments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::package_status;
    use crate::db::{now_ms, Db};
    use crate::types::{Address, StoredMessage};

    fn m(id: &str, thread: &str, ago_days: i64, from: &str, to: &str, labels: &[&str], subject: &str) -> StoredMessage {
        StoredMessage {
            id: id.into(),
            thread_id: thread.into(),
            internal_date: now_ms() - ago_days * super::DAY - 1000,
            from: Address { name: from.split('@').next().unwrap().into(), email: from.into() },
            to: vec![Address { name: String::new(), email: to.into() }],
            subject: subject.into(),
            snippet: subject.into(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
            text_body: subject.into(),
            ..Default::default()
        }
    }

    #[test]
    fn home_summary_sections() {
        let dir = std::env::temp_dir().join(format!("post-home-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        db.kv_set("email", "me@x.com").unwrap();
        db.store_messages(
            &[
                // A friend asked something two days ago: waiting on you.
                m("a1", "ta", 2, "sam@gmail.com", "me@x.com", &["INBOX", "CATEGORY_PERSONAL"], "Dinner Saturday?"),
                // I wrote 5 days ago and got nothing back: no reply yet.
                m("b1", "tb", 5, "me@x.com", "lena@studio.com", &["SENT"], "Invoice question"),
                // Shipping update.
                m("c1", "tc", 1, "ship@amazon.com", "me@x.com", &["INBOX", "CATEGORY_UPDATES"], "Shipped: \"Desk lamp\""),
                // A friend thread I already answered: not waiting.
                m("d1", "td", 3, "ava@gmail.com", "me@x.com", &["INBOX"], "Photos"),
                m("d2", "td", 2, "me@x.com", "ava@gmail.com", &["SENT"], "Re: Photos"),
            ],
            true,
        )
        .unwrap();
        db.set_pinned("tc", true).unwrap();
        let h = db.home().unwrap();
        assert_eq!(h.waiting.iter().map(|w| w.thread_id.as_str()).collect::<Vec<_>>(), vec!["ta"]);
        assert_eq!(h.no_reply.len(), 1);
        assert_eq!(h.no_reply[0].email, "lena@studio.com");
        assert_eq!(h.packages.len(), 1);
        assert_eq!(h.packages[0].tag.as_deref(), Some("Shipped"));
        assert_eq!(h.pinned.len(), 1);

        // An AI "no" verdict hides it from waiting.
        db.set_ai_verdicts("needs_reply", &[("a1".into(), false)]).unwrap();
        let h = db.home().unwrap();
        assert!(h.waiting.is_empty());
        assert!(h.waiting_ai);
    }

    #[test]
    fn package_statuses() {
        assert_eq!(package_status("Shipped: \"Anker USB-C cable\""), Some("Shipped"));
        assert_eq!(package_status("Out for delivery: your package"), Some("Out for delivery"));
        assert_eq!(package_status("Delivered: 2 items"), Some("Delivered"));
        assert_eq!(package_status("Arriving tomorrow"), Some("On the way"));
        assert_eq!(package_status("Your weekly digest"), None);
    }
}
