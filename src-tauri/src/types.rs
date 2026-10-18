use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Address {
    #[serde(default)]
    pub name: String,
    pub email: String,
}

impl Address {
    pub fn display(&self) -> String {
        if self.name.is_empty() {
            self.email.clone()
        } else {
            self.name.clone()
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub attachment_id: String,
    pub part_id: String,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub inline: bool,
}

/// A Gmail message, parsed into the shape we persist locally.
#[derive(Debug, Clone, Default)]
pub struct StoredMessage {
    pub id: String,
    pub thread_id: String,
    pub internal_date: i64,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    pub labels: Vec<String>,
    pub attachments: Vec<AttachmentMeta>,
    pub text_body: String,
    pub html_body: Option<String>,
    pub message_id_header: String,
    pub in_reply_to: String,
    pub references: String,
    pub list_unsubscribe: String,
    pub list_unsubscribe_post: bool,
    pub calendar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub name: String,
    pub email: String,
    pub is_me: bool,
    pub unread: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub thread_id: String,
    pub folder: String,
    pub date: i64,
    pub subject: String,
    pub snippet: String,
    pub participants: Vec<Participant>,
    pub count: i64,
    pub unread: bool,
    pub has_attachments: bool,
    pub avatar_email: String,
    pub snoozed_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentView {
    #[serde(flatten)]
    pub meta: AttachmentMeta,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub thread_id: String,
    pub date: i64,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    pub labels: Vec<String>,
    pub unread: bool,
    pub is_draft: bool,
    pub attachments: Vec<AttachmentView>,
    pub text: String,
    pub html: Option<String>,
    pub message_id_header: String,
    pub references: String,
    pub can_unsubscribe: bool,
    pub ics: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub thread_id: String,
    pub subject: String,
    pub messages: Vec<MessageView>,
    pub snoozed_until: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachment {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardAttachment {
    pub message_id: String,
    pub part_id: String,
    pub filename: String,
    pub mime_type: String,
    #[serde(default)]
    pub size: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeData {
    #[serde(default)]
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    #[serde(default)]
    pub bcc: Vec<Address>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub attachments: Vec<LocalAttachment>,
    #[serde(default)]
    pub forward_attachments: Vec<ForwardAttachment>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub draft_id: Option<String>,
    #[serde(default)]
    pub from: Option<Address>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: i64,
    pub send_at: i64,
    pub kind: String,
    pub status: String,
    pub error: Option<String>,
    pub compose: ComposeData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub compose_mode: String,
    pub signature: String,
    pub undo_seconds: i64,
    pub display_name: String,
    pub notifications: bool,
    pub launch_at_startup: bool,
    pub html_cache_mb: i64,
    pub poll_seconds: i64,
    pub email_dark_mode: bool,
    pub sidebar_open: bool,
    pub zoom: f64,
    pub notify_people_only: bool,
    pub quiet_hours: bool,
    pub quiet_start: i64,
    pub quiet_end: i64,
    pub templates: Vec<Template>,
    pub global_shortcut: bool,
    pub ai_enabled: bool,
    pub ai_cap_usd: f64,
    /// Home screen modules in display order (empty = default layout).
    pub home_layout: Vec<HomeModule>,
    /// Inbox list width in px (0 = automatic).
    pub list_width: i64,
    /// Load pictures from the web in emails. Off: they stay hidden until you choose to show them.
    pub remote_images: bool,
    /// Senders whose pictures always load (lowercase addresses).
    pub image_senders: Vec<String>,
    /// Sender sections in the sidebar (drag an email there to add one).
    pub sender_views: Vec<SenderView>,
    /// Look over a message before it's sent (missing attachment, wrong weekday, sharp tone).
    pub send_check: bool,
    /// The app's mood (see src/moods.ts): "classic", "paper", "slate", …
    pub mood: String,
    /// The window background behind the panes, as #rrggbb ("" = the mood's own).
    pub window_color: String,
    /// When the Auto mood goes dark, in minutes after midnight (21:00 = 1260).
    pub auto_dark_start: i64,
    /// When the Auto mood comes back from dark, in minutes after midnight (05:00 = 300).
    pub auto_dark_end: i64,
    /// A faint pattern for the season (leaves, snowflakes, petals, sun) behind the panes.
    pub seasonal: bool,
}

/// A section in the sidebar: one sender, a group (senders, domains or subject words), or an AI
/// category that Claude fills by its description and examples. Older saved sections only have
/// `email` and `name`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SenderView {
    pub email: String,
    pub name: String,
    pub id: String,
    /// "" or "sender" for one address, "group", or "ai".
    pub kind: String,
    pub senders: Vec<String>,
    pub domains: Vec<String>,
    pub subjects: Vec<String>,
    /// What belongs in an AI category, in plain words.
    pub description: String,
}

impl SenderView {
    /// Stable id; the folder is "sec:<key>".
    pub fn key(&self) -> String {
        if self.id.is_empty() {
            self.email.to_lowercase()
        } else {
            self.id.clone()
        }
    }

    pub fn is_ai(&self) -> bool {
        self.kind == "ai"
    }

    pub fn sender_list(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .senders
            .iter()
            .chain(std::iter::once(&self.email))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect();
        v.sort();
        v.dedup();
        v
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HomeModule {
    pub id: String,
    #[serde(default)]
    pub wide: bool,
    #[serde(default)]
    pub hidden: bool,
    /// Row index on the home screen (modules sharing a row split its width). None = legacy layout.
    #[serde(default)]
    pub row: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Template {
    pub name: String,
    pub body: String,
}

/// Post's teal, the app icon's color.
pub const DEFAULT_ACCENT: &str = "#2a737b";

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            accent: DEFAULT_ACCENT.into(),
            compose_mode: "inline".into(),
            signature: String::new(),
            undo_seconds: 5,
            display_name: String::new(),
            notifications: true,
            launch_at_startup: true,
            html_cache_mb: 150,
            poll_seconds: 5,
            email_dark_mode: true,
            sidebar_open: false,
            zoom: 1.0,
            notify_people_only: false,
            quiet_hours: false,
            quiet_start: 22,
            quiet_end: 7,
            templates: Vec::new(),
            global_shortcut: true,
            ai_enabled: false,
            ai_cap_usd: 5.0,
            home_layout: Vec::new(),
            list_width: 0,
            remote_images: true,
            image_senders: Vec::new(),
            sender_views: Vec::new(),
            send_check: true,
            mood: "classic".into(),
            window_color: String::new(),
            auto_dark_start: 21 * 60,
            auto_dark_end: 5 * 60,
            seasonal: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: String,
    pub backfilled: i64,
    pub total: i64,
    pub last_sync: i64,
    pub online: bool,
    pub error: Option<String>,
    /// Messages per minute during the current backfill session.
    pub rate: f64,
    /// Current spacing between Gmail requests, in ms (higher = throttled by quota).
    pub spacing_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSuggestion {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAs {
    pub email: String,
    pub name: String,
    pub is_default: bool,
}