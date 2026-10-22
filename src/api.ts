import { invoke } from "@tauri-apps/api/core";

export type MailFolder = "INBOX" | "SENT" | "DRAFT" | "SNOOZED" | "SCHEDULED" | "TRASH" | "SPAM";
/** A mailbox folder, or a section from the sidebar ("sec:<id>"). */
export type Folder = MailFolder | `sec:${string}`;

/**
 * A sidebar section: one sender, a group (senders, domains or subject words), or an AI category
 * that Claude fills from its description. Older sections only have `email` and `name`.
 */
export interface SenderView {
  email: string;
  name: string;
  id: string;
  kind: "" | "sender" | "group" | "ai";
  senders: string[];
  domains: string[];
  subjects: string[];
  description: string;
}

export interface CategoryIdea {
  name: string;
  description: string;
}

export interface Address {
  name: string;
  email: string;
}

export interface Participant {
  name: string;
  email: string;
  isMe: boolean;
  unread: boolean;
}

export interface ThreadSummary {
  threadId: string;
  folder: string;
  date: number;
  subject: string;
  snippet: string;
  participants: Participant[];
  count: number;
  unread: boolean;
  hasAttachments: boolean;
  avatarEmail: string;
  snoozedUntil: number | null;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  partId: string;
  contentId: string | null;
  inline: boolean;
  url: string;
}

/** What the AI assistant made of a request (see AskAction): an answer, or conversations to act on. */
export interface CommandResult {
  kind: "answer" | "act" | "unsupported";
  answer: AskAnswer | null;
  action: "archive" | "delete" | "read" | "unread" | "star" | "unstar" | "pin" | "unpin" | "snooze" | "rsvp" | "show" | "";
  response: "yes" | "maybe" | "no" | "";
  /** For snooze: local time, "YYYY-MM-DDTHH:MM". */
  until: string;
  summary: string;
  threads: AskSource[];
}

/** What Claude decided to do with a request about one email (see AiAssist). */
export interface AssistPlan {
  /** "inbox": the request is about mail beyond this email; "clarify": unclear which, so ask. */
  action: "reply" | "rsvp" | "answer" | "inbox" | "clarify";
  text: string;
  replyAll: boolean;
  response: "yes" | "maybe" | "no";
}

export interface Message {
  id: string;
  threadId: string;
  date: number;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  isDraft: boolean;
  attachments: Attachment[];
  text: string;
  html: string | null;
  messageIdHeader: string;
  references: string;
  canUnsubscribe: boolean;
  ics: string | null;
}

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ThreadDetail {
  threadId: string;
  subject: string;
  messages: Message[];
  snoozedUntil: number | null;
}

export interface LocalAttachment {
  path: string;
  name: string;
}

export interface ForwardAttachment {
  messageId: string;
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ComposeData {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  attachments: LocalAttachment[];
  forwardAttachments: ForwardAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  threadId?: string | null;
  draftId?: string | null;
  from?: Address | null;
}

export interface OutboxItem {
  id: number;
  sendAt: number;
  kind: "undo" | "scheduled";
  status: string;
  error: string | null;
  compose: ComposeData;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  accent: string;
  composeMode: ComposeMode;
  signature: string;
  undoSeconds: number;
  displayName: string;
  notifications: boolean;
  launchAtStartup: boolean;
  htmlCacheMb: number;
  pollSeconds: number;
  emailDarkMode: boolean;
  sidebarOpen: boolean;
  zoom: number;
  notifyPeopleOnly: boolean;
  quietHours: boolean;
  quietStart: number;
  quietEnd: number;
  templates: Template[];
  globalShortcut: boolean;
  aiEnabled: boolean;
  aiCapUsd: number;
  homeLayout: HomeModuleCfg[];
  listWidth: number;
  remoteImages: boolean;
  imageSenders: string[];
  senderViews: SenderView[];
  sendCheck: boolean;
  /** A mood from moods.ts ("classic", "paper", …). */
  mood: string;
  /** The window background behind the panes, as #rrggbb ("" = the mood's own). */
  windowColor: string;
  /** When the Auto mood goes dark and comes back, in minutes after midnight. */
  autoDarkStart: number;
  autoDarkEnd: number;
  /** A faint pattern for the season behind the panes. */
  seasonal: boolean;
  /** With a custom window background, the inbox card takes on a little of its color. */
  cardTint: boolean;
  /** With a custom window background, the inbox card is mostly see-through (wins over cardTint). */
  cardClear: boolean;
  /** With a custom window background, the inbox card is a thin white veil over it (wins over cardTint). */
  cardFrost: boolean;
  /** Looks saved as moods of your own. */
  savedLooks: SavedLook[];
  /** Buttons with a keyboard shortcut show its key beside their name, for learning them. */
  showKeys: boolean;
}

/** A look saved as a mood of your own: a mood's colors plus what was chosen with it. */
export interface SavedLook {
  name: string;
  mood: string;
  accent: string;
  windowColor: string;
  card: "white" | "tinted" | "frost" | "clear";
  seasonal: boolean;
}

export interface AskSource {
  n: number;
  threadId: string;
  subject: string;
  from: string;
  date: number;
}

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
}

export interface HomeModuleCfg {
  id: string;
  wide: boolean;
  hidden: boolean;
  /** Row on the home screen; modules sharing a row split its width (max 4). */
  row?: number | null;
}

export interface AiStatus {
  hasKey: boolean;
  keyHint: string | null;
  enabled: boolean;
  model: string;
  monthSpend: number;
  monthCalls: number;
  cap: number;
  capped: boolean;
}

export interface Template {
  name: string;
  body: string;
}

export interface SendAs {
  email: string;
  name: string;
  isDefault: boolean;
}

export type ComposeMode = "inline" | "window" | "floating" | "fullscreen";

export interface SyncStatus {
  phase: string;
  backfilled: number;
  total: number;
  lastSync: number;
  online: boolean;
  error: string | null;
  rate: number;
  spacingMs: number;
}

export interface AppInfo {
  configured: boolean;
  signedIn: boolean;
  email: string;
  settings: Settings;
  status: SyncStatus;
  unread: number;
  counts: Record<string, number>;
}

export interface HomeItem {
  threadId: string;
  messageId: string;
  name: string;
  email: string;
  subject: string;
  snippet: string;
  date: number;
  tag: string | null;
}

export interface HomeAttachment extends Omit<Attachment, "url"> {
  threadId: string;
  messageId: string;
  from: string;
  date: number;
  url: string;
}

export interface HomeInvite {
  threadId: string;
  messageId: string;
  subject: string;
  ics: string;
}

export interface Home {
  receivedToday: number;
  peopleToday: number;
  unread: number;
  waiting: HomeItem[];
  waitingAi: boolean;
  noReply: HomeItem[];
  pinned: HomeItem[];
  packages: HomeItem[];
  trips: HomeItem[];
  invites: HomeInvite[];
  attachments: HomeAttachment[];
}

export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  link: string;
  calendar: string;
  color: string;
  /** Video meeting link (Zoom, Meet, Teams…), or "". */
  meeting: string;
}

export interface CalendarResult {
  status: "ok" | "needs_permission" | "api_disabled" | "error";
  message: string;
  enableUrl: string | null;
  events: CalEvent[];
}

export interface Contact {
  name: string;
  email: string;
}

export const api = {
  appState: () => invoke<AppInfo>("get_app_state"),
  setClient: (clientId: string, clientSecret: string) => invoke<void>("set_client", { clientId, clientSecret }),
  signIn: () => invoke<string>("sign_in"),
  signOut: () => invoke<void>("sign_out"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  syncNow: () => invoke<void>("sync_now"),
  quit: () => invoke<void>("quit_app"),

  listThreads: (folder: string, offset: number, limit: number) =>
    invoke<{ threads: ThreadSummary[]; total: number }>("list_threads", { folder, offset, limit }),
  getThread: (threadId: string, folder: string) => invoke<ThreadDetail>("get_thread", { threadId, folder }),
  markRead: (threadIds: string[], read: boolean) => invoke<void>("mark_read", { threadIds, read }),
  trash: (threadIds: string[]) => invoke<void>("trash_threads", { threadIds }),
  untrash: (threadIds: string[]) => invoke<void>("untrash_threads", { threadIds }),
  spam: (threadIds: string[], spam: boolean) => invoke<void>("spam_threads", { threadIds, spam }),
  labelThreads: (threadIds: string[], add: string[], remove: string[]) => invoke<void>("label_threads", { threadIds, add, remove }),
  muteThread: (threadId: string, muted: boolean) => invoke<void>("mute_thread", { threadId, muted }),
  isMuted: (threadId: string) => invoke<boolean>("is_muted", { threadId }),
  snooze: (threadId: string, until: number) => invoke<void>("snooze_thread", { threadId, until }),
  unsnooze: (threadId: string) => invoke<void>("unsnooze_thread", { threadId }),

  searchLocal: (query: string) => invoke<ThreadSummary[]>("search_local", { query }),
  searchRemote: (query: string) => invoke<ThreadSummary[]>("search_remote", { query }),
  unsubscribe: (messageId: string) => invoke<"done" | "mailto" | "opened">("unsubscribe", { messageId }),

  queueSend: (compose: ComposeData, sendAt: number | null) =>
    invoke<{ id: number; sendAt: number; kind: "undo" | "scheduled" }>("queue_send", { compose, sendAt }),
  cancelSend: (id: number) => invoke<ComposeData | null>("cancel_send", { id }),
  listOutbox: () => invoke<OutboxItem[]>("list_outbox"),
  saveDraft: (compose: ComposeData) => invoke<{ draftId: string; messageId: string }>("save_draft", { compose }),
  deleteDraft: (draftId: string) => invoke<void>("delete_draft", { draftId }),
  loadDraft: (messageId: string) => invoke<ComposeData>("load_draft", { messageId }),
  suggestContacts: (query: string) => invoke<Contact[]>("suggest_contacts", { query }),

  openComposeWindow: (init: unknown) => invoke<void>("open_compose_window", { init }),
  takeComposeInit: (label: string) => invoke<unknown | null>("take_compose_init", { label }),
  takeLaunchMailto: () => invoke<ComposeData | null>("take_launch_mailto"),

  /** "confirm" means the file can run code; ask, then call again with confirmed. */
  openAttachment: (messageId: string, partId: string, confirmed = false) =>
    invoke<"opened" | "confirm">("open_attachment", { messageId, partId, confirmed }),
  /** Opens a save dialog; false if cancelled. */
  saveAttachment: (messageId: string, partId: string) => invoke<boolean>("save_attachment", { messageId, partId }),
  /** Opens a file picker; the chosen files are copied where Post sends from. */
  pickAttachments: () => invoke<{ path: string; name: string }[]>("pick_attachments"),

  setBadge: (png: number[] | null) => invoke<void>("set_badge", { png }),
  makeDefaultMailApp: () => invoke<void>("make_default_mail_app"),
  showMain: () => invoke<void>("show_main_window"),

  markAllRead: (folder: string) => invoke<number>("mark_all_read", { folder }),
  getRaw: (messageId: string) => invoke<string>("get_raw", { messageId }),
  saveRaw: (messageId: string, name: string) => invoke<boolean>("save_raw", { messageId, name }),
  saveAllAttachments: (messageId: string) => invoke<number | null>("save_all_attachments", { messageId }),
  listSendAs: () => invoke<SendAs[]>("list_send_as"),
  rsvp: (messageId: string, ics: string, response: "yes" | "maybe" | "no") => invoke<void>("rsvp", { messageId, ics, response }),
  rsvpStatus: (messageIds: string[]) => invoke<Record<string, string>>("rsvp_status", { messageIds }),

  aiStatus: () => invoke<AiStatus>("ai_status"),
  setAiKey: (key: string) => invoke<AiStatus>("set_ai_key", { key }),
  clearAiKey: () => invoke<AiStatus>("clear_ai_key"),
  testAi: () => invoke<string>("test_ai"),

  homeSummary: () => invoke<Home>("home_summary"),
  pinThread: (threadId: string, pinned: boolean) => invoke<void>("pin_thread", { threadId, pinned }),
  aiDescribeCategory: (threadIds: string[]) => invoke<CategoryIdea>("ai_describe_category", { threadIds }),
  askInbox: (question: string) => invoke<AskAnswer>("ask_inbox", { question }),
  /** Summarize one conversation (empty history) or answer a follow-up about it. */
  askThread: (threadId: string, history: AskTurn[]) => invoke<string>("ask_thread", { threadId, history }),
  toneCheck: (text: string) => invoke<{ flag: boolean; note: string }>("tone_check", { text }),
  /** Ask Claude to do something with one email; `invites` lists invitations still to answer. */
  /** A question or an instruction for the AI assistant. */
  aiCommand: (request: string) => invoke<CommandResult>("ai_command", { request }),
  aiAssist: (threadId: string, instruction: string, invites: string, thisEmailOnly = false) =>
    invoke<AssistPlan>("ai_assist", { threadId, instruction, invites, thisEmailOnly }),
  categoryMark: (sectionId: string, threadIds: string[], member: boolean) =>
    invoke<void>("category_mark", { sectionId, threadIds, member }),
  categoryClassify: (sectionId: string, reset = false) => invoke<void>("category_classify", { sectionId, reset }),
  isPinned: (threadId: string) => invoke<boolean>("is_pinned", { threadId }),
  calendarUpcoming: (from?: string, days?: number) => invoke<CalendarResult>("calendar_upcoming", { from, days }),
};

export function avatarUrl(email: string) {
  return `http://avatar.localhost/${encodeURIComponent(email.toLowerCase())}`;
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
