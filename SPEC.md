# Post — Product Spec

A calm, minimal, local desktop client for a single Gmail account, built with Tauri for Windows 11.
"Post" is a placeholder name.

## Platform & architecture
- **Tauri 2** (Rust backend, web frontend). Windows 11 is the target.
- **Gmail API** with Google OAuth (loopback redirect + PKCE). The user creates their own Google Cloud project: unverified app, publishing status **In production** so refresh tokens don't expire every 7 days. A `SETUP.md` walks through it, and a first-run screen takes the client ID and secret.
- Tokens are stored in **Windows Credential Manager**. No app lock and no cache encryption.
- **Single account.**

## Sync & storage (SQLite)
- Tiered cache, no attachments stored:
  - **Every message:** headers, labels, snippet, and plain-text body (zstd-compressed), with an FTS5 full-text index. Target size is roughly 200–400 MB.
  - **Most recent ~2,000:** full HTML bodies cached for instant rendering.
  - **Older HTML** is fetched when opened, then kept in a size-capped LRU cache.
  - **Attachments** are fetched on click and kept in a small temp cache.
- The initial backfill runs newest-first in the background and shows progress. The app is usable immediately.
- Incremental sync polls the Gmail `history` API every ~15–30 seconds.
- Search is **hybrid**. The local FTS index returns results instantly, Gmail server search runs in parallel, and the results are merged. Gmail operators such as `from:` and `has:attachment` are supported.

## Layout & look
- Minimal and calm. Inter-style sans typeface. Subtle 120–200 ms motion.
- **Collapsible sidebar** (hidden by default, toggled by a key) plus a **split view** of list and reading pane.
- Sidebar contains Inbox, Sent, Drafts, Trash, and Spam. There are no labels or categories, and no star or important markers.
- Custom integrated title bar with Mica. Search and window controls sit in the top strip.
- Light and dark themes follow Windows, with a manual override. The accent color is **user-pickable** from curated presets or a color picker.
- **Threaded** conversations. Inbox rows are **two lines**: sender and time on the first, subject and snippet on the second, plus attachment and thread-count markers. Unread rows are bold with an accent dot.
- **Real avatars:** Google contact photos and brand logos (BIMI or favicon), falling back to initials.
- HTML emails render **as the sender designed them** in a sandboxed iframe, with smart dark-mode adaptation. Remote images **load automatically**.
- Attachments get **inline previews**: image thumbnails and a quick-look viewer for PDFs and images. Other files can be opened in their default app or saved.

## Actions
- Reply, Reply all, Forward, Delete, Mark unread, Report spam, and one-click Unsubscribe (using the `List-Unsubscribe` header and the one-click POST when available).
- **Snooze** is implemented locally: the thread is hidden until the chosen time, then resurfaces at the top.
- Keyboard: **Gmail-style shortcuts** (j/k, r, a, f, #, /, c, and so on) plus a **Ctrl+K command palette** covering every action and setting.

## Compose
- Four compose modes, chosen in Settings: **inline in the reading pane, separate window, floating panel, full-screen focus**.
- **Basic rich text:** bold, italic, links, lists, quotes, and inline images.
- Signature, contact autocomplete (from mail history plus Google contacts), **undo send** with a configurable delay, and **schedule send**. Scheduled sends live in a local queue that the app sends from. If the PC was off at the scheduled time, the message goes out on next launch and the user is told.
- Registers as the Windows **`mailto:`** handler.

## Background presence
- Starts with Windows and minimizes to the **system tray**.
- A **Windows toast for every new email** shows sender and subject, with a **"Mark as read"** action that works without opening the app. Clicking the toast opens the thread.
- The **taskbar icon shows a count badge** of unread inbox mail, displaying 99+ above that.

## Out of scope
- AI features, multiple accounts, IMAP, labels and categories, and stars.

## Delivery
- The full spec is built in one pass, not phased.
- Toolchain: Rust (rustup) and the MSVC Build Tools, installed via winget.
