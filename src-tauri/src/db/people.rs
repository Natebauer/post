//! Contacts (for recipient suggestions) and cached avatars.

use super::*;

impl Db {
    // ---------- contacts ----------

    pub fn upsert_contacts(&self, list: &[(String, String, Option<String>)]) -> Result<()> {
        let mut c = self.w.lock().unwrap();
        let tx = c.transaction()?;
        for (email, name, photo) in list {
            tx.execute(
                "INSERT INTO contacts (email, name, photo_url) VALUES (?1, ?2, ?3)
                 ON CONFLICT(email) DO UPDATE SET name = excluded.name,
                   photo_url = COALESCE(excluded.photo_url, contacts.photo_url)",
                params![email.to_lowercase(), name, photo],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn contact_photo(&self, email: &str) -> Option<String> {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT photo_url FROM contacts WHERE email = ?1", [email], |r| r.get::<_, Option<String>>(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    pub fn suggest_contacts(&self, q: &str, limit: i64) -> Result<Vec<ContactSuggestion>> {
        let c = self.r.lock().unwrap();
        let like = format!("{}%", q.to_lowercase().replace('%', "").replace('_', ""));
        let word = format!("% {}", &like);
        let mut st = c.prepare(
            "SELECT email, name, MAX(score) AS s FROM (
               SELECT email, name, score + 100 AS score FROM correspondents
                 WHERE email LIKE ?1 OR LOWER(name) LIKE ?1 OR LOWER(name) LIKE ?2
               UNION ALL
               SELECT email, name, 50 AS score FROM contacts
                 WHERE email LIKE ?1 OR LOWER(name) LIKE ?1 OR LOWER(name) LIKE ?2
             ) GROUP BY email ORDER BY s DESC LIMIT ?3",
        )?;
        let r = st
            .query_map(params![like, word, limit], |r| {
                Ok(ContactSuggestion { email: r.get(0)?, name: r.get(1)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(r)
    }

    // ---------- avatars ----------

    pub fn avatar_get(&self, key: &str) -> Option<(bool, Option<String>, i64)> {
        let c = self.r.lock().unwrap();
        c.query_row("SELECT found, mime, fetched FROM avatars WHERE key = ?1", [key], |r| {
            Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?))
        })
        .optional()
        .ok()
        .flatten()
    }

    pub fn avatar_set(&self, key: &str, found: bool, mime: Option<&str>) {
        let c = self.w.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO avatars (key, found, mime, fetched) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET found = excluded.found, mime = excluded.mime, fetched = excluded.fetched",
            params![key, found as i64, mime, now_ms()],
        );
    }
}
