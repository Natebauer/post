//! The database schema, migrations, and importing a copy left in a redirected folder.

use super::*;

pub(crate) const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS messages (
  rid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  thread_id TEXT NOT NULL,
  internal_date INTEGER NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT ',',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  text_z BLOB,
  has_html INTEGER NOT NULL DEFAULT 0,
  html_z BLOB,
  html_size INTEGER,
  html_accessed INTEGER,
  msgid TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  list_unsub TEXT NOT NULL DEFAULT '',
  list_unsub_post INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_email COLLATE NOCASE);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  subject, sender, recipients, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS thread_folders (
  folder TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sort_date INTEGER NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  msg_count INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  avatar_email TEXT NOT NULL,
  PRIMARY KEY (folder, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_tf_sort ON thread_folders(folder, sort_date DESC);
CREATE INDEX IF NOT EXISTS idx_tf_thread ON thread_folders(thread_id);

CREATE TABLE IF NOT EXISTS snoozes (
  thread_id TEXT PRIMARY KEY,
  until INTEGER,
  resurfaced_at INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  send_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  payload TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  photo_url TEXT
);

CREATE TABLE IF NOT EXISTS correspondents (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  last INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts);

CREATE TABLE IF NOT EXISTS category_members (
  section_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (section_id, thread_id)
);

CREATE TABLE IF NOT EXISTS ai_verdicts (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  verdict INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);

CREATE TABLE IF NOT EXISTS pins (
  thread_id TEXT PRIMARY KEY,
  pinned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avatars (
  key TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  mime TEXT,
  fetched INTEGER NOT NULL
);
"#;

pub(crate) fn has_client_id(path: &Path) -> bool {
    let Ok(c) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    c.query_row("SELECT 1 FROM kv WHERE k = 'client_id'", [], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// When Post is started from inside an MSIX-packaged app (for example the Claude desktop app),
/// Windows redirects its AppData writes into that package's private LocalCache. A later normal
/// launch then finds an empty data folder. If our real database has no setup but such a
/// redirected copy does, import it once. Returns the source folder when an import happened.
pub fn import_redirected_copy(data_dir: &Path, identifier: &str) -> Result<Option<std::path::PathBuf>> {
    let real = data_dir.join("mail.db");
    if real.exists() && has_client_id(&real) {
        return Ok(None);
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return Ok(None) };
    let packages = Path::new(&local).join("Packages");
    let Ok(rd) = std::fs::read_dir(&packages) else { return Ok(None) };
    // Newest redirected copy that actually holds a configured account.
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for pkg in rd.flatten() {
        let dir = pkg.path().join("LocalCache").join("Roaming").join(identifier);
        let db = dir.join("mail.db");
        if !db.exists() || !has_client_id(&db) {
            continue;
        }
        let modified = ["mail.db", "mail.db-wal"]
            .iter()
            .filter_map(|f| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok())
            .max()
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, dir));
        }
    }
    let Some((_, src_dir)) = best else { return Ok(None) };

    // VACUUM INTO writes a consistent single-file snapshot (WAL contents included).
    let tmp = data_dir.join("mail.import.db");
    let _ = std::fs::remove_file(&tmp);
    {
        let src = Connection::open(src_dir.join("mail.db"))?;
        src.busy_timeout(std::time::Duration::from_secs(10))?;
        src.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
    }
    for f in ["mail.db", "mail.db-wal", "mail.db-shm"] {
        let p = data_dir.join(f);
        if p.exists() {
            std::fs::remove_file(&p)?;
        }
    }
    std::fs::rename(&tmp, &real)?;
    // Keep the remembered window size/position too.
    let ws = src_dir.join(".window-state.json");
    if ws.exists() {
        let _ = std::fs::copy(&ws, data_dir.join(".window-state.json"));
    }
    Ok(Some(src_dir))
}

/// Additive schema changes for databases created by earlier versions.
pub(crate) fn migrate(c: &Connection) -> Result<()> {
    let has_ics: bool = c
        .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'ics'")?
        .exists([])?;
    if !has_ics {
        c.execute_batch("ALTER TABLE messages ADD COLUMN ics TEXT;")?;
    }
    Ok(())
}

pub const FOLDERS: [&str; 5] = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM"];
