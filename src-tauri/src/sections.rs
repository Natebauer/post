//! Sidebar sections: conversations from chosen senders, domains or subject words, or an AI
//! category whose members Claude decides (stored per conversation in `category_members`).

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{params, params_from_iter, types::Value as Sql};

use crate::db::{row_to_summary, Db};
use crate::types::{SenderView, ThreadSummary};

const IN_INBOX: &str = "tf.folder IN ('INBOX', 'SNOOZED')";

/// A conversation as Claude sees it when sorting: its latest message, briefly.
#[derive(Debug, Clone)]
pub struct Brief {
    pub thread_id: String,
    pub from_name: String,
    pub from_email: String,
    pub subject: String,
    pub snippet: String,
}

/// A LIKE pattern piece that matches the text literally (\, % and _ escaped with \).
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// SQL condition on `thread_folders tf` for a section, with its parameters (numbered from 1).
fn section_where(v: &SenderView) -> (String, Vec<Sql>) {
    if v.is_ai() {
        return (
            format!("{IN_INBOX} AND tf.thread_id IN (SELECT thread_id FROM category_members WHERE section_id = ?1 AND member = 1)"),
            vec![Sql::Text(v.key())],
        );
    }
    let (rule, args) = message_rule(v);
    if rule == "0" {
        return (rule, args);
    }
    // An IN list of matching threads, not a correlated EXISTS: SQLite runs the subquery once
    // (by index for senders); with EXISTS it can choose to re-scan messages per conversation,
    // which took about a minute on a real mailbox.
    (format!("{IN_INBOX} AND tf.thread_id IN (SELECT m.thread_id FROM messages m WHERE {rule})"), args)
}

/// For a sender/group section: the condition on a message `m` (its sender, domain or subject),
/// with its parameters numbered from 1. "0" when the section has no rules.
fn message_rule(v: &SenderView) -> (String, Vec<Sql>) {
    let mut args: Vec<Sql> = Vec::new();
    let mut ors = Vec::new();
    for s in v.sender_list() {
        args.push(Sql::Text(s));
        ors.push(format!("m.from_email = ?{} COLLATE NOCASE", args.len()));
    }
    for d in &v.domains {
        args.push(Sql::Text(format!("%@{}", like_escape(&d.trim_start_matches('@').to_lowercase()))));
        ors.push(format!("m.from_email LIKE ?{} ESCAPE '\\'", args.len()));
    }
    for k in &v.subjects {
        args.push(Sql::Text(format!("%{}%", like_escape(k))));
        ors.push(format!("m.subject LIKE ?{} ESCAPE '\\'", args.len()));
    }
    if ors.is_empty() {
        return ("0".into(), args);
    }
    (format!("({})", ors.join(" OR ")), args)
}

impl Db {
    fn section(&self, key: &str) -> Option<SenderView> {
        self.settings().sender_views.into_iter().find(|v| v.key() == key)
    }

    /// Inbox conversations in a section, newest first.
    pub fn list_section(&self, key: &str, offset: i64, limit: i64) -> Result<(Vec<ThreadSummary>, i64)> {
        let Some(v) = self.section(key) else { return Ok((vec![], 0)) };
        let (cond, mut args) = section_where(&v);
        let c = self.r.lock().unwrap();
        let total: i64 = c.query_row(
            &format!("SELECT COUNT(*) FROM thread_folders tf WHERE {cond}"),
            params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        let n = args.len();
        args.push(Sql::Integer(limit));
        args.push(Sql::Integer(offset));
        let mut st = c.prepare(&format!(
            "SELECT tf.folder, tf.thread_id, tf.sort_date, tf.subject, tf.snippet, tf.participants_json, tf.msg_count,
                    tf.unread, tf.has_attachments, tf.avatar_email, s.until
             FROM thread_folders tf LEFT JOIN snoozes s ON s.thread_id = tf.thread_id
             WHERE {cond} ORDER BY tf.sort_date DESC LIMIT ?{} OFFSET ?{}",
            n + 1,
            n + 2
        ))?;
        let rows = st
            .query_map(params_from_iter(args.iter()), row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, total))
    }

    /// Unread inbox conversations per section, keyed by folder ("sec:<key>").
    pub fn section_unread(&self, sections: &[SenderView]) -> HashMap<String, i64> {
        let c = self.r.lock().unwrap();
        let mut out = HashMap::new();
        for v in sections {
            // Unread inbox conversations are few, so start from them and check their messages
            // (CROSS JOIN keeps that order) instead of matching the rule across the whole mailbox.
            let (sql, args) = if v.is_ai() {
                let (cond, args) = section_where(v);
                (format!("SELECT COUNT(*) FROM thread_folders tf WHERE tf.folder = 'INBOX' AND tf.unread = 1 AND {cond}"), args)
            } else {
                let (rule, args) = message_rule(v);
                (
                    format!(
                        "SELECT COUNT(DISTINCT tf.thread_id) FROM thread_folders tf CROSS JOIN messages m
                           ON m.thread_id = tf.thread_id WHERE tf.folder = 'INBOX' AND tf.unread = 1 AND {rule}"
                    ),
                    args,
                )
            };
            let n = c.query_row(&sql, params_from_iter(args.iter()), |r| r.get::<_, i64>(0)).unwrap_or(0);
            out.insert(format!("sec:{}", v.key()), n);
        }
        out
    }

    /// Record which conversations belong to a category. Your own choices (`manual`) always win;
    /// Claude's verdicts never overwrite them.
    pub fn cat_set(&self, section: &str, items: &[(String, bool)], manual: bool) -> Result<()> {
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        {
            let sql = if manual {
                "INSERT INTO category_members (section_id, thread_id, member, manual) VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT(section_id, thread_id) DO UPDATE SET member = excluded.member, manual = 1"
            } else {
                "INSERT INTO category_members (section_id, thread_id, member, manual) VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT(section_id, thread_id) DO UPDATE SET member = excluded.member WHERE manual = 0"
            };
            let mut st = tx.prepare(sql)?;
            for (t, m) in items {
                st.execute(params![section, t, *m as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Forget Claude's verdicts (e.g. after the description changed); your own examples stay.
    pub fn cat_reset_auto(&self, section: &str) -> Result<()> {
        self.w.lock().unwrap().execute("DELETE FROM category_members WHERE section_id = ?1 AND manual = 0", [section])?;
        Ok(())
    }

    /// Recent inbox conversations Claude hasn't sorted for this category yet, newest first.
    pub fn cat_unjudged(&self, section: &str, since_ms: i64, limit: i64) -> Result<Vec<String>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare(&format!(
            "SELECT tf.thread_id FROM thread_folders tf
             WHERE {IN_INBOX} AND tf.sort_date >= ?2
               AND NOT EXISTS (SELECT 1 FROM category_members x WHERE x.section_id = ?1 AND x.thread_id = tf.thread_id)
             ORDER BY tf.sort_date DESC LIMIT ?3"
        ))?;
        let ids = st
            .query_map(params![section, since_ms, limit], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Conversations you've put in (or taken out of) a category yourself.
    pub fn cat_examples(&self, section: &str, member: bool, limit: i64) -> Result<Vec<String>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare(
            "SELECT thread_id FROM category_members WHERE section_id = ?1 AND manual = 1 AND member = ?2
             ORDER BY rowid DESC LIMIT ?3",
        )?;
        let ids = st
            .query_map(params![section, member as i64, limit], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// The latest message of each conversation, for sorting prompts.
    pub fn thread_briefs(&self, thread_ids: &[String]) -> Result<Vec<Brief>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare_cached(
            "SELECT from_name, from_email, subject, snippet FROM messages WHERE thread_id = ?1
             ORDER BY internal_date DESC LIMIT 1",
        )?;
        let mut out = Vec::new();
        for t in thread_ids {
            if let Ok((from_name, from_email, subject, snippet)) =
                st.query_row([t], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            {
                out.push(Brief { thread_id: t.clone(), from_name, from_email, subject, snippet });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(kind: &str) -> SenderView {
        SenderView { id: "s1".into(), kind: kind.into(), ..Default::default() }
    }

    #[test]
    fn rules_combine_with_or() {
        let mut v = view("group");
        v.email = "A@x.com".into();
        v.senders = vec!["b@y.com".into(), "a@x.com".into()];
        v.domains = vec!["@delta.com".into()];
        v.subjects = vec!["invoice".into()];
        let (sql, args) = section_where(&v);
        assert_eq!(args.len(), 4, "duplicate senders collapse: {sql}");
        assert!(sql.contains(" OR "));
        assert!(matches!(&args[2], Sql::Text(s) if s == "%@delta.com"));
    }

    #[test]
    fn empty_group_matches_nothing() {
        assert_eq!(section_where(&view("group")).0, "0");
    }

    #[test]
    fn ai_uses_members() {
        let (sql, args) = section_where(&view("ai"));
        assert!(sql.contains("category_members"));
        assert!(matches!(&args[0], Sql::Text(s) if s == "s1"));
    }
    /// Time the sidebar/list queries on a real mailbox: set POST_DB to a copy of mail.db and run
    /// `cargo test --release timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn timing() {
        let Ok(path) = std::env::var("POST_DB") else { return };
        let db = Db::open(std::path::Path::new(&path)).unwrap();
        let t = |name: &str, f: &dyn Fn()| {
            let s = std::time::Instant::now();
            f();
            println!("{name}: {:?}", s.elapsed());
        };
        let views = db.settings().sender_views;
        t("list INBOX", &|| {
            db.list_threads("INBOX", 0, 100).unwrap();
        });
        for v in &views {
            t(&format!("list sec:{}", v.key()), &|| {
                db.list_threads(&format!("sec:{}", v.key()), 0, 100).unwrap();
            });
        }
        // A group using every kind of rule (domains and subject words can't use an index).
        let group = SenderView {
            id: "timing".into(),
            kind: "group".into(),
            senders: vec!["noreply@example.com".into()],
            domains: vec!["google.com".into()],
            subjects: vec!["invoice".into()],
            ..Default::default()
        };
        let (cond, args) = section_where(&group);
        t("group count", &|| {
            let c = db.r.lock().unwrap();
            let _: i64 = c
                .query_row(&format!("SELECT COUNT(*) FROM thread_folders tf WHERE {cond}"), params_from_iter(args.iter()), |r| r.get(0))
                .unwrap();
        });
        let mut all = views.clone();
        all.push(group.clone());
        t("section_unread", &|| {
            db.section_unread(&all);
        });
        t("folder_counts", &|| {
            db.folder_counts();
        });
        t("home", &|| {
            db.home().unwrap();
        });
    }
}
