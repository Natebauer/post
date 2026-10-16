# Post

A calm, minimal Gmail client for Windows 11. Post is a local desktop app built with Tauri, Rust and React.

- **Your mail, locally.** Post stores the headers and plain text of every message in SQLite with full-text search,
  zstd-compressed (about 200–400 MB for an 80k mailbox). Your newest 2,000 emails keep their full HTML. Older HTML is
  fetched when you open a message and kept in a size-capped cache. Attachments are downloaded only when you open them.
- **Hybrid search.** Local results appear instantly while Gmail's server search runs alongside, and the two are merged.
  Search supports `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `in:sent`, `after:2024/01/01` and `before:`.
- **Quiet UI.** A collapsible sidebar, threaded two-line list and reading pane. Light and dark follow Windows, with a
  pickable accent and moods. In dark mode, HTML emails are recolored to match.
- **Writing.** Basic rich text with a signature, contact autocomplete, undo send, schedule send and drafts synced to
  Gmail. Compose opens inline, as a floating panel, full screen or in a separate window.
- **Background.** Post lives in the tray and starts with Windows. You get a Windows notification for each new email
  with a **Mark as read** button, and a count badge on the taskbar icon.
- **Keyboard first.** Gmail shortcuts (`j`/`k`, `r`, `a`, `f`, `#`, `/`, `c`, `g i` …) plus a `Ctrl+K` command palette.
- Snooze, one-click unsubscribe and report spam are built in, and Post can be your default `mailto:` handler.
- **Optional AI** with your own Anthropic key: an assistant that answers questions about your mail and, after you
  confirm, archives, snoozes or accepts invitations for you; drafted replies; summaries; and AI sections.

## Getting started

1. Install with `src-tauri/target/release/bundle/nsis/Post_0.1.0_x64-setup.exe`.
2. Follow [SETUP.md](SETUP.md) to create your Google OAuth client (one-time, about 10 minutes). Post walks you through
   it on first launch.
3. Optional: add an Anthropic API key (Post offers after sign-in, or **Settings → AI**) to turn on the AI assistant,
   drafted replies, summaries and AI sections.

## Development

Requirements: Node 18+, Rust (stable, MSVC), and Visual Studio Build Tools with the C++ workload.

```bash
npm install
npm run tauri dev      # run the app with hot reload
npm run dev            # UI only, in a browser, with fake data (src/dev-mock.ts)
npm run tauri build    # release build + NSIS installer
```

Rust unit tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`.

## Architecture

| Layer | Where | Notes |
| --- | --- | --- |
| OAuth | `src-tauri/src/auth.rs` | Installed-app flow with PKCE and loopback redirect. Tokens live in Windows Credential Manager. |
| Gmail API | `src-tauri/src/gmail.rs` | Retries with backoff on 429/5xx and refreshes on 401. |
| Storage | `src-tauri/src/db.rs` | SQLite in WAL mode: `messages`, contentless FTS5 index, per-folder `thread_folders` summaries, outbox, snoozes. |
| Sync | `src-tauri/src/sync.rs` | Newest-first resumable backfill, then `history.list` polling (default 20s). Re-walks the mailbox if history expires. |
| Outbox | `src-tauri/src/outbox.rs` | Undo send and schedule send share one queue. MIME is built with `mail-builder`, and pasted images become inline `cid:` parts. |
| Protocols | `src-tauri/src/protocols.rs` | `postatt://` serves attachments (disk cache, 500 MB LRU). `avatar://` serves contact photos and brand logos. |
| Platform | `src-tauri/src/platform.rs`, `notify.rs` | Tray, taskbar overlay badge, toasts with actions, `mailto:` registration, autostart. |
| UI | `src/` | React + Zustand. TipTap for the editor. Emails render in a sandboxed, script-free iframe. |

Data lives in `%APPDATA%\app.post.mail\mail.db`. Caches (attachments, avatars) live in `%LOCALAPPDATA%\app.post.mail\`.

## Known limits

- **Schedule send and snooze are local.** Gmail's API has no scheduling, so Post sends scheduled mail itself. If your
  PC is off at the scheduled time, the mail goes out the next time Post starts, and Post tells you so. Snoozed threads
  are hidden only in Post; gmail.com still shows them in the inbox.
- Brand logos come from Google's favicon service, not BIMI.
- Gmail labels, categories and stars are intentionally not shown.
