//! Snoozes and the outbox (scheduled and undo-able sends).

use super::*;

impl Db {
    // ---------- snooze ----------

    pub fn snooze(&self, thread_id: &str, until: i64) -> Result<()> {
        let me = self.my_email();
        let c = self.w.lock().unwrap();
        c.execute(
            "INSERT INTO snoozes (thread_id, until, resurfaced_at) VALUES (?1, ?2, NULL)
             ON CONFLICT(thread_id) DO UPDATE SET until = excluded.until",
            params![thread_id, until],
        )?;
        refresh_thread(&c, thread_id, &me)?;
        Ok(())
    }

    pub fn unsnooze(&self, thread_id: &str, resurface: bool) -> Result<()> {
        let me = self.my_email();
        let c = self.w.lock().unwrap();
        if resurface {
            c.execute(
                "UPDATE snoozes SET until = NULL, resurfaced_at = ?2 WHERE thread_id = ?1",
                params![thread_id, now_ms()],
            )?;
        } else {
            c.execute("UPDATE snoozes SET until = NULL WHERE thread_id = ?1", [thread_id])?;
        }
        refresh_thread(&c, thread_id, &me)?;
        Ok(())
    }

    pub fn due_snoozes(&self) -> Vec<String> {
        let c = self.r.lock().unwrap();
        let mut st = c
            .prepare("SELECT thread_id FROM snoozes WHERE until IS NOT NULL AND until <= ?1")
            .unwrap();
        st.query_map([now_ms()], |r| r.get(0))
            .map(|r| r.flatten().collect())
            .unwrap_or_default()
    }

    // ---------- outbox ----------

    pub fn outbox_add(&self, compose: &ComposeData, send_at: i64, kind: &str) -> Result<i64> {
        let c = self.w.lock().unwrap();
        c.execute(
            "INSERT INTO outbox (send_at, kind, status, payload, created) VALUES (?1, ?2, 'pending', ?3, ?4)",
            params![send_at, kind, serde_json::to_string(compose)?, now_ms()],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// Remove a pending outbox item; returns its payload if it hadn't been sent yet.
    pub fn outbox_take(&self, id: i64) -> Result<Option<ComposeData>> {
        let c = self.w.lock().unwrap();
        let p: Option<String> = c
            .query_row(
                "SELECT payload FROM outbox WHERE id = ?1 AND status IN ('pending', 'failed')",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if p.is_some() {
            c.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        }
        Ok(p.and_then(|p| serde_json::from_str(&p).ok()))
    }

    /// Atomically claim due items so they are sent once.
    pub fn outbox_claim_due(&self) -> Result<Vec<OutboxItem>> {
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        let items = {
            let mut st = tx.prepare(
                "SELECT id, send_at, kind, status, error, payload FROM outbox WHERE status = 'pending' AND send_at <= ?1",
            )?;
            let r = st
                .query_map([now_ms()], row_to_outbox)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        };
        for i in &items {
            tx.execute("UPDATE outbox SET status = 'sending' WHERE id = ?1", [i.id])?;
        }
        tx.commit()?;
        Ok(items)
    }

    pub fn outbox_finish(&self, id: i64, error: Option<&str>) -> Result<()> {
        let c = self.w.lock().unwrap();
        match error {
            None => c.execute("DELETE FROM outbox WHERE id = ?1", [id])?,
            Some(e) => c.execute(
                "UPDATE outbox SET status = 'failed', error = ?2 WHERE id = ?1",
                params![id, e],
            )?,
        };
        Ok(())
    }

    /// Post closed mid-send: Gmail may already have the message, so resending blindly could send it
    /// twice. Those wait as "failed" for you to check Sent and retry if needed.
    pub fn outbox_reset_stuck(&self) -> Result<()> {
        let c = self.w.lock().unwrap();
        c.execute(
            "UPDATE outbox SET status = 'failed',
               error = 'Post closed while this was sending. Check Sent before sending it again.'
             WHERE status = 'sending'",
            [],
        )?;
        Ok(())
    }

    pub fn outbox_list(&self) -> Result<Vec<OutboxItem>> {
        let c = self.r.lock().unwrap();
        let mut st = c.prepare(
            "SELECT id, send_at, kind, status, error, payload FROM outbox
             WHERE kind = 'scheduled' OR status = 'failed' ORDER BY send_at ASC",
        )?;
        let r = st
            .query_map([], row_to_outbox)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(r)
    }

    pub fn outbox_overdue_scheduled(&self, grace_ms: i64) -> i64 {
        let c = self.r.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM outbox WHERE kind = 'scheduled' AND status = 'pending' AND send_at < ?1",
            [now_ms() - grace_ms],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }
}
