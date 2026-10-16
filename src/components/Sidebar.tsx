import { AlarmClock, CalendarClock, File, Inbox, OctagonAlert, PenSquare, Send, Settings, Sparkles, Trash2 } from "lucide-react";
import type { Folder, MailFolder } from "../api";
import { sectionFolder, sectionKey, sectionOf } from "../senders";
import { GroupPopover, SectionEditor, SectionItem } from "./Sections";
import { useStore } from "../store";
import { compose, goFolder, openAssistant } from "../actions";
import { cx } from "../util";
import { etaText, SyncRing } from "./TitleBar";

export const FOLDER_NAMES: Record<MailFolder, string> = {
  INBOX: "Inbox",
  SNOOZED: "Snoozed",
  SCHEDULED: "Scheduled",
  SENT: "Sent",
  DRAFT: "Drafts",
  TRASH: "Trash",
  SPAM: "Spam",
};

const ICONS: Record<MailFolder, JSX.Element> = {
  INBOX: <Inbox size={16} />,
  SNOOZED: <AlarmClock size={16} />,
  SCHEDULED: <CalendarClock size={16} />,
  SENT: <Send size={16} />,
  DRAFT: <File size={16} />,
  TRASH: <Trash2 size={16} />,
  SPAM: <OctagonAlert size={16} />,
};

/** Heading for the list pane: a folder name, or the sender's name for a sender section. */
export function folderTitle(f: Folder): string {
  return sectionOf(f)?.name ?? FOLDER_NAMES[f as MailFolder];
}

function Item({ f, count }: { f: MailFolder; count?: number; tab?: number }) {
  const active = useStore((s) => s.folder === f && !s.search);
  return (
    <button
      className={cx("nav-item", active && "active")}
      onClick={() => goFolder(f)}
      aria-current={active ? "page" : undefined}
      aria-label={count ? `${FOLDER_NAMES[f]}, ${count}` : FOLDER_NAMES[f]}
      title={FOLDER_NAMES[f]}
    >
      {ICONS[f]}
      <span className="nav-text">{FOLDER_NAMES[f]}</span>
      {!!count && <span className="count">{count > 999 ? "999+" : count}</span>}
    </button>
  );
}

function SyncFoot() {
  const status = useStore((s) => s.status);
  if (!status || status.phase !== "backfill" || !status.total) return null;
  const pct = Math.min(100, Math.round((status.backfilled / status.total) * 100));
  return (
    <button className="sync-foot" onClick={() => useStore.setState({ settingsOpen: true })} title="Sync details">
      <SyncRing size={18} />
      <span className="nav-text" style={{ textAlign: "left" }}>
        Indexing mail · {pct}%
        {etaText(status) && (
          <>
            <br />
            {etaText(status)}
          </>
        )}
      </span>
    </button>
  );
}

// Only unread counts for mail you want to read (Inbox and sender sections) are shown; counts on
// Spam or Drafts just pull your eye toward mail that doesn't need it.
export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const counts = useStore((s) => s.counts);
  const outboxCount = useStore((s) => s.outbox.filter((o) => o.kind === "scheduled").length);
  const senders = useStore((s) => s.settings?.senderViews ?? []);
  // Collapsed, the sidebar is a narrow rail of icons (labels come back while dragging an email).
  const tab = 0;
  return (
    <nav className={cx("sidebar", open ? "open" : "rail")} aria-label="Folders" data-drop-label="Drop to add a sender">
      <div className="sidebar-inner">
        <button className="compose-btn" onClick={compose} title="Compose (C)" aria-label="Compose">
          <PenSquare size={16} /> <span className="nav-text">Compose</span>
        </button>
        <Item f="INBOX" count={counts.INBOX} tab={tab} />
        {(counts.SNOOZED ?? 0) > 0 && <Item f="SNOOZED" tab={tab} />}
        {outboxCount > 0 && <Item f="SCHEDULED" tab={tab} />}
        <Item f="SENT" tab={tab} />
        <Item f="DRAFT" tab={tab} />
        <button
          className="nav-item"
          data-ask=""
          tabIndex={tab}
          onClick={() => openAssistant()}
          title="Ask about your email or tell AI what to do with it (Ctrl+J). Drop an email here to summarize it."
        >
          <Sparkles size={16} /> <span className="nav-text">AI assistant</span>
        </button>
        {senders.length > 0 && (
          <>
            <div className="nav-sep" />
            <div className="nav-group" role="group" aria-label="Sections">
              {senders.map((v) => (
                <SectionItem key={sectionKey(v)} v={v} count={counts[sectionFolder(v)]} tab={tab} />
              ))}
            </div>
          </>
        )}
        <div className="nav-sep" />
        <Item f="SPAM" tab={tab} />
        <Item f="TRASH" tab={tab} />
        <div className="sidebar-foot">
          <SyncFoot />
          <button className="nav-item" onClick={() => useStore.setState({ settingsOpen: true })} title="Settings">
            <Settings size={16} /> <span className="nav-text">Settings</span>
          </button>
        </div>
      </div>
      <GroupPopover />
      <SectionEditor />
    </nav>
  );
}
