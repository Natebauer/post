import type React from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlarmClock,
  CalendarClock,
  Contrast,
  File,
  Forward,
  Inbox,
  Keyboard,
  LogOut,
  Mail,
  MailCheck,
  MailMinus,
  Monitor,
  Moon,
  OctagonAlert,
  PanelLeft,
  PenSquare,
  Power,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  AppWindow,
  CheckCheck,
  Printer,
  FileCode,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api, type ComposeMode, type Folder } from "../api";
import { useStore } from "../store";
import * as A from "../actions";
import { cx } from "../util";
import { usePresence } from "../hooks";

interface Cmd {
  id: string;
  label: string;
  icon: JSX.Element;
  hint?: string;
  keywords?: string;
  when?: () => boolean;
  run: () => void;
}

const hasThread = () => !!useStore.getState().selectedId;

/** Sections shown when the palette opens (searching shows one ranked list instead). */
const GROUPS = ["Actions", "Go to", "View", "Post"] as const;
function groupOf(id: string): (typeof GROUPS)[number] {
  if (id.startsWith("go-")) return "Go to";
  if (/^(zoom|sidebar|theme|email-dark|mode-)/.test(id)) return "View";
  if (["settings", "shortcuts", "default", "signout", "quit"].includes(id)) return "Post";
  return "Actions";
}

function commands(): Cmd[] {
  const st = useStore.getState;
  const go = (f: Folder, label: string, icon: JSX.Element, hint: string): Cmd => ({
    id: `go-${f}`,
    label: `Go to ${label}`,
    icon,
    hint,
    keywords: "folder open",
    run: () => A.goFolder(f),
  });
  const mode = (m: ComposeMode, label: string): Cmd => ({
    id: `mode-${m}`,
    label: `Compose in ${label}`,
    icon: <AppWindow size={16} />,
    keywords: "compose mode setting window floating inline fullscreen",
    run: () => {
      void st().saveSettings({ composeMode: m });
      st().snack({ text: `New messages will open ${label}` });
    },
  });
  return [
    { id: "compose", label: "Compose new message", icon: <PenSquare size={16} />, hint: "C", keywords: "new write email", run: A.compose },
    {
      id: "ask",
      label: "AI assistant…",
      icon: <Sparkles size={16} />,
      hint: "Ctrl+J",
      keywords: "ask question ai claude answer find archive accept rsvp invitations snooze do",
      run: () => A.openAssistant(),
    },
    { id: "search", label: "Search mail", icon: <Search size={16} />, hint: "/", run: () => window.dispatchEvent(new Event("post:focus-search")) },
    { id: "reply", label: "Reply", icon: <Reply size={16} />, hint: "R", when: hasThread, run: () => A.respond("reply") },
    { id: "replyall", label: "Reply all", icon: <ReplyAll size={16} />, hint: "A", when: hasThread, run: () => A.respond("replyAll") },
    { id: "forward", label: "Forward", icon: <Forward size={16} />, hint: "F", when: hasThread, run: () => A.respond("forward") },
    { id: "trash", label: "Delete conversation", icon: <Trash2 size={16} />, hint: "#", keywords: "trash remove", when: hasThread, run: () => void A.trash() },
    { id: "allread", label: "Mark all as read", icon: <CheckCheck size={16} />, keywords: "clear unread", run: () => void A.markAllRead() },
    { id: "read", label: "Mark as read", icon: <MailCheck size={16} />, hint: "Shift+I", when: hasThread, run: () => void A.markRead(true) },
    { id: "unread", label: "Mark as unread", icon: <Mail size={16} />, hint: "Shift+U", when: hasThread, run: () => void A.markRead(false) },
    { id: "snooze", label: "Snooze…", icon: <AlarmClock size={16} />, hint: "B", keywords: "later remind", when: hasThread, run: A.openSnooze },
    { id: "spam", label: "Report spam", icon: <OctagonAlert size={16} />, hint: "!", when: hasThread, run: () => void A.spam() },
    {
      id: "unsub",
      label: "Unsubscribe from this sender",
      icon: <MailMinus size={16} />,
      keywords: "newsletter list",
      when: () => !!st().thread?.messages.some((m) => m.canUnsubscribe),
      run: () => {
        const m = st().thread?.messages.find((x) => x.canUnsubscribe);
        if (m) void A.unsubscribe(m.id);
      },
    },
    {
      id: "print",
      label: "Print message",
      icon: <Printer size={16} />,
      hint: "Ctrl+P",
      when: () => !!st().thread,
      run: () => {
        const m = st().thread?.messages.at(-1);
        if (m) A.printMessage(m);
      },
    },
    {
      id: "eml",
      label: "Save message as .eml",
      icon: <FileCode size={16} />,
      keywords: "original source export download",
      when: () => !!st().thread,
      run: () => {
        const m = st().thread?.messages.at(-1);
        if (m) void A.saveOriginal(m);
      },
    },
    { id: "zoomin", label: "Zoom in", icon: <ZoomIn size={16} />, hint: "Ctrl+=", keywords: "text size bigger", run: () => void A.setZoom((st().settings?.zoom ?? 1) + 0.1) },
    { id: "zoomout", label: "Zoom out", icon: <ZoomOut size={16} />, hint: "Ctrl+-", keywords: "text size smaller", run: () => void A.setZoom((st().settings?.zoom ?? 1) - 0.1) },
    { id: "zoomreset", label: "Reset zoom", icon: <ZoomIn size={16} />, hint: "Ctrl+0", keywords: "text size", run: () => void A.setZoom(1) },
    go("INBOX", "Inbox", <Inbox size={16} />, "G I"),
    go("SNOOZED", "Snoozed", <AlarmClock size={16} />, "G B"),
    go("SCHEDULED", "Scheduled", <CalendarClock size={16} />, ""),
    go("SENT", "Sent", <Send size={16} />, "G T"),
    go("DRAFT", "Drafts", <File size={16} />, "G D"),
    go("SPAM", "Spam", <OctagonAlert size={16} />, "G !"),
    go("TRASH", "Trash", <Trash2 size={16} />, ""),
    { id: "sidebar", label: "Toggle sidebar", icon: <PanelLeft size={16} />, hint: "Ctrl+B", run: A.toggleSidebar },
    { id: "check", label: "Check for new mail", icon: <RefreshCw size={16} />, keywords: "sync refresh", run: () => void api.syncNow() },
    { id: "theme-system", label: "Theme: match Windows", icon: <Monitor size={16} />, keywords: "appearance", run: () => void st().saveSettings({ theme: "system" }) },
    { id: "theme-light", label: "Theme: light", icon: <Sun size={16} />, keywords: "appearance", run: () => void st().saveSettings({ theme: "light" }) },
    { id: "theme-dark", label: "Theme: dark", icon: <Moon size={16} />, keywords: "appearance", run: () => void st().saveSettings({ theme: "dark" }) },
    {
      id: "email-dark",
      label: "Toggle dark colors for emails",
      icon: <Contrast size={16} />,
      keywords: "invert newsletter",
      run: () => void st().saveSettings({ emailDarkMode: !st().settings?.emailDarkMode }),
    },
    mode("inline", "the reading pane"),
    mode("floating", "a floating panel"),
    mode("fullscreen", "full screen"),
    mode("window", "a separate window"),
    { id: "settings", label: "Settings", icon: <Settings size={16} />, hint: "Ctrl+,", keywords: "preferences options", run: () => useStore.setState({ settingsOpen: true }) },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={16} />, hint: "?", run: () => useStore.setState({ shortcutsOpen: true }) },
    { id: "default", label: "Make Post the default email app", icon: <Mail size={16} />, keywords: "mailto", run: () => void api.makeDefaultMailApp() },
    {
      id: "signout",
      label: "Sign out",
      icon: <LogOut size={16} />,
      keywords: "account logout",
      run: () => {
        if (window.confirm("Sign out of Post? Your local mail cache will be cleared.")) void api.signOut().then(() => st().init());
      },
    },
    { id: "quit", label: "Quit Post", icon: <Power size={16} />, keywords: "exit close", run: () => void api.quit() },
  ];
}

/** A command's name with the words you typed in bold. */
function marked(label: string, q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return label;
  const on = new Array<boolean>(label.length).fill(false);
  for (const w of words) {
    const i = label.toLowerCase().indexOf(w);
    if (i >= 0) for (let j = i; j < i + w.length; j++) on[j] = true;
  }
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < label.length) {
    let j = i;
    while (j < label.length && on[j] === on[i]) j++;
    out.push(on[i] ? <b key={i}>{label.slice(i, j)}</b> : label.slice(i, j));
    i = j;
  }
  return out;
}

/** The command run last, so it can lead the list next time. */
const LAST = "post.lastCommand";
function lastCommand(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

function score(c: Cmd, q: string): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.keywords ?? ""}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : hay[i - 1] === " " ? 2 : 1;
  }
  return s;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo(() => {
    if (!open) return [] as Cmd[];
    const list = commands()
      .filter((c) => !c.when || c.when())
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (q.trim() ? b.s - a.s : GROUPS.indexOf(groupOf(a.c.id)) - GROUPS.indexOf(groupOf(b.c.id))))
      .map((x) => x.c);
    // With nothing typed, the command you used last comes first.
    if (!q.trim()) {
      const i = list.findIndex((c) => c.id === lastCommand());
      if (i > 0) list.unshift(...list.splice(i, 1));
    }
    if (q.trim())
      list.push({
        id: "search-q",
        label: `Search mail for "${q.trim()}"`,
        icon: <Search size={16} />,
        run: () => {
          useStore.getState().setSearch(q.trim());
          void useStore.getState().runRemoteSearch();
        },
      });
    return list;
  }, [open, q]);

  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!mounted) return null;
  const close = () => useStore.setState({ paletteOpen: false });
  const run = (c: Cmd) => {
    try {
      if (c.id !== "search-q") localStorage.setItem(LAST, c.id);
    } catch {
      /* storage unavailable */
    }
    close();
    setTimeout(c.run, 0);
  };

  return createPortal(
    <>
      <div className={cx("scrim", closing && "closing")} onClick={close} />
      <div className={cx("modal palette", closing && "closing")} role="dialog" aria-label="Command palette">
        <Search className="palette-search" size={17} aria-hidden />
        <input
          autoFocus
          value={q}
          placeholder="Type a command or search…"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && items[active]) run(items[active]);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((c, i) => {
            const recent = !q.trim() && i === 0 && c.id === lastCommand();
            const group = q.trim() ? null : recent ? "Recent" : groupOf(c.id);
            const heading = group && (i === 0 || (i === 1 && items[0].id === lastCommand()) || groupOf(items[i - 1].id) !== group);
            return (
              <Fragment key={c.id}>
                {heading && <div className="menu-label palette-group">{group}</div>}
                <button
                  className={cx("menu-item", i === active && "active")}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span className="pi">{c.icon}</span>
                  <span>{marked(c.label, q)}</span>
                  {c.hint && (
                    <span className="hint keys">
                      {c.hint.split(/(?<=\S)[ +](?=\S)/).map((k, j) => (
                        <kbd key={j}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
          {items.length === 0 && <div className="menu-label">No matching commands</div>}
        </div>
        <div className="palette-foot" aria-hidden>
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
