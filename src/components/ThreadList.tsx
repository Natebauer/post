import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlarmClock,
  ArrowUpToLine,
  CheckCheck,
  Forward,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Search,
  OctagonAlert,
  Paperclip,
  Pin,
  Reply,
  ReplyAll,
  RotateCcw,
  Sparkles,
  Trash2,
  MailCheck,
} from "lucide-react";
import type { MailFolder, ThreadSummary } from "../api";
import { api } from "../api";
import { useStore } from "../store";
import { motionEase, motionMs, reduceMotion, scrollBehavior } from "../motionTokens";
import { claimHighlight } from "../motion";
import * as A from "../actions";
import { cx, participantLine, shortDate, whenLabel } from "../util";
import { Avatar } from "./Avatar";
import { KeyHint } from "./KeyHint";
import { RollingCount } from "./RollingCount";
import { InboxZeroConfetti } from "./Confetti";
import { EmptyArt, partOfDay, type EmptyKind } from "./EmptyArt";
import { folderTitle, ICONS } from "./Sidebar";
import { TimePicker } from "./TimePicker";
import { Popover } from "./Popover";
import { SearchBox } from "./SearchBox";
import { Highlight } from "./Highlight";
import { ScheduledList } from "./Scheduled";
import { togglePin } from "./Home";
import { dragJustEnded, startMailDrag } from "../mailDrag";
import { removeFromCategory, sectionOf } from "../senders";

const ROW = 68;
/** The list adapts to its width: very narrow shows only each email's photo; narrow shows avatar,
 *  subject and date; wide becomes a one-row-per-email table. These are the widths where it
 *  switches, and each layout's row height. */
type ListSize = "tiny" | "small" | "medium" | "large";
const TINY_BELOW = 160;
const SMALL_BELOW = 380;
const LARGE_FROM = 720;
const ROW_H: Record<ListSize, number> = { tiny: 52, small: 52, medium: ROW, large: 40 };
const sizeFor = (w: number): ListSize =>
  w < TINY_BELOW ? "tiny" : w < SMALL_BELOW ? "small" : w >= LARGE_FROM ? "large" : "medium";
/** Height of a date group label ("Today", "Yesterday", …) above the first row of each group. */
const GROUP = 30;

/** Date group a conversation falls in, for the labels between rows. */
function dateGroup(ms: number, now = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= day) return "Today";
  if (ms >= day - 86_400_000) return "Yesterday";
  if (ms >= day - 6 * 86_400_000) return "This week";
  const d = new Date(ms);
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "Earlier this month";
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
}

/** "Tomorrow at 3:55 AM" rather than "tomorrow at …", for a label that starts a chip. */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ThreadMenu({ t, point, onClose }: { t: ThreadSummary; point: { x: number; y: number }; onClose: () => void }) {
  const [snooze, setSnooze] = useState<HTMLElement | null>(null);
  const checked = useStore((s) => s.checked);
  const multi = checked.length > 1 && checked.includes(t.threadId);
  // Whether it's pinned, so the menu can say Pin or Unpin.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!multi) api.isPinned(t.threadId).then(setPinned).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.threadId]);
  const ids = multi ? checked : [t.threadId];
  const folder = t.folder || useStore.getState().folder;
  // In an AI category, you can tell Claude a conversation doesn't belong.
  const viewing = sectionOf(useStore.getState().folder);
  const category = viewing?.kind === "ai" ? viewing : null;
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <Popover point={point} onClose={onClose}>
      {!multi && (
        <>
          <button className="menu-item" onClick={run(() => void A.respond("reply", undefined, t.threadId))}>
            <Reply size={15} /> Reply
          </button>
          <button className="menu-item" onClick={run(() => void A.respond("replyAll", undefined, t.threadId))}>
            <ReplyAll size={15} /> Reply all
          </button>
          <button className="menu-item" onClick={run(() => void A.respond("forward", undefined, t.threadId))}>
            <Forward size={15} /> Forward
          </button>
          <div className="menu-sep" />
        </>
      )}
      {multi && <div className="menu-label">{ids.length} conversations</div>}
      {category && (
        <button className="menu-item" onClick={run(() => void removeFromCategory(category, ids))}>
          <Sparkles size={15} /> Not in {category.name}
        </button>
      )}
      {!multi && (
        <button className="menu-item" onClick={run(() => void togglePin(t.threadId))}>
          <Pin size={15} /> {pinned ? "Unpin from Home" : "Pin to Home"}
        </button>
      )}
      {/* One conversation: just the one that applies. Several: both. */}
      {(multi || t.unread) && (
        <button className="menu-item" onClick={run(() => void A.markRead(true, ids))}>
          <MailOpen size={15} /> Mark as read
        </button>
      )}
      {(multi || !t.unread) && (
        <button className="menu-item" onClick={run(() => void A.markRead(false, ids))}>
          <Mail size={15} /> Mark as unread
        </button>
      )}
      {(folder === "INBOX" || folder === "SNOOZED") && (
        <button className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={(e) => setSnooze(e.currentTarget)}>
          <AlarmClock size={15} /> Snooze…
        </button>
      )}
      <div className="menu-sep" />
      {folder !== "TRASH" && (
        <button className="menu-item" onClick={run(() => void A.spam(ids))}>
          <OctagonAlert size={15} /> {folder === "SPAM" ? "Not spam" : "Report spam"}
        </button>
      )}
      {folder === "TRASH" ? (
        <button className="menu-item" onClick={run(() => void A.restore(ids))}>
          <RotateCcw size={15} /> Restore
        </button>
      ) : (
        <button className="menu-item danger" onClick={run(() => void A.trash(ids))}>
          <Trash2 size={15} /> Delete
        </button>
      )}
      {snooze && (
        <TimePicker
          anchor={snooze}
          kind="snooze"
          onClose={() => setSnooze(null)}
          onPick={(ms) => {
            setSnooze(null);
            onClose();
            void A.snooze(ids, ms);
          }}
        />
      )}
    </Popover>
  );
}

/** While a list loads with nothing to show yet: shimmering rows in its shape, fading down the list. */
function ListSkeleton() {
  const widths = [62, 48, 70, 55, 66, 44, 58, 50];
  return (
    <div className="list-skeleton" aria-busy="true" aria-label="Loading">
      {widths.map((w, i) => (
        <div key={i} className="sk-row" style={{ opacity: 1 - i * 0.11 }}>
          <span className="skeleton sk-av" />
          <span className="sk-lines">
            <span className="skeleton sk-line" style={{ width: `${w - 18}%` }} />
            <span className="skeleton sk-line thin" style={{ width: `${w + 22}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Who a row is from. In Sent it's who it went to, after a quiet "To"; a draft says so in a tag. */
function SenderText({ sender, folder }: { sender: string; folder: string }) {
  const to = sender.startsWith("To: ") ? sender.slice(4) : null;
  if (folder === "DRAFT")
    return (
      <>
        <span className="row-tag draft">Draft</span>
        <Highlight text={to ?? sender} />
      </>
    );
  if (to === null) return <Highlight text={sender} />;
  return (
    <>
      <span className="row-tag to">To</span>
      <Highlight text={to} />
    </>
  );
}

function Row({
  t,
  top,
  selected,
  cursor,
  checked,
  leaving,
  fresh,
  onMenu,
  size,
}: {
  size: ListSize;
  t: ThreadSummary;
  top: number;
  selected: boolean;
  cursor: boolean;
  checked: boolean;
  leaving: boolean;
  fresh: boolean;
  onMenu: (t: ThreadSummary, p: { x: number; y: number }) => void;
}) {
  const folder = useStore((s) => s.folder);
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement | null>(null);
  const viewFolder = t.folder || folder;
  const sender = participantLine(t.participants, viewFolder);
  const avatarName = t.participants.find((p) => p.email === t.avatarEmail)?.name ?? sender;
  // A conversation with other people besides the sender shows the next one tucked behind.
  const others = t.participants.filter(
    (p, i, all) => !p.isMe && p.email !== t.avatarEmail && all.findIndex((q) => q.email === p.email) === i,
  );
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const st = useStore.getState;

  const onClick = (e: React.MouseEvent) => {
    if (dragJustEnded()) return;
    if (e.ctrlKey || e.metaKey) return st().toggleCheck(t.threadId);
    if (e.shiftKey) return st().checkRange(t.threadId);
    st().clearChecks();
    if (viewFolder === "DRAFT") void A.openDraftThread(t.threadId);
    // Clicking the open conversation again closes it.
    else if (st().selectedId === t.threadId) st().select(null);
    else st().select(t.threadId);
  };

  const label = `${t.unread ? "Unread. " : ""}${sender}. ${t.subject || "No subject"}. ${shortDate(t.date)}${
    t.hasAttachments ? ". Has attachments" : ""
  }`;

  return (
    <div
      id={`row-${t.threadId}`}
      className={cx(
        "row",
        t.unread && "unread",
        selected && "selected",
        cursor && "cursor",
        checked && "checked",
        leaving && "leaving",
        fresh && "fresh",
      )}
      style={{ transform: `translateY(${top}px)` }}
      onClick={onClick}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".row-actions") || t.threadId.startsWith("outbox:")) return;
        startMailDrag(e, t.threadId, { email: t.avatarEmail, name: avatarName }, t.subject);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(t, { x: e.clientX, y: e.clientY });
      }}
      role="option"
      aria-selected={selected || checked}
      aria-label={label}
      title={
        size === "tiny"
          ? `${sender}\n${t.subject || "(no subject)"}\n${shortDate(t.date)}`
          : size === "small"
            ? `${sender} · ${shortDate(t.date)}`
            : undefined
      }
    >
      <span className="dot" />
      {others.length > 0 && !checked && size !== "small" && size !== "large" && size !== "tiny" ? (
        <div className="avatar-group">
          <Avatar email={t.avatarEmail} name={avatarName} />
          <span className="avatar-second" title={others.map((p) => p.name || p.email).join(", ")}>
            <Avatar email={others[0].email} name={others[0].name || others[0].email} size="xs" />
            {others.length > 1 && <span className="avatar-more">+{others.length - 1}</span>}
          </span>
        </div>
      ) : (
        <Avatar email={t.avatarEmail} name={avatarName} checked={checked} size={size === "large" ? "xs" : size === "small" ? "sm" : undefined} />
      )}
      {size === "tiny" ? null : size === "small" ? (
        <div className="row-main">
          <div className="row-line">
            <span className="row-sub">
              <span className="subj">
                <Highlight text={t.subject || "(no subject)"} />
              </span>
            </span>
          </div>
        </div>
      ) : size === "large" ? (
        <>
          <span className="row-from">
            <SenderText sender={sender} folder={viewFolder} />
            {t.count > 1 && <span className="n">{t.count}</span>}
          </span>
          <span className="row-sub">
            <span className="subj">
              <Highlight text={t.subject || "(no subject)"} />
            </span>
            {t.snippet && (
              <span className="snip">
                {" · "}
                <Highlight text={t.snippet} />
              </span>
            )}
          </span>
          <span className="row-icons">
            {t.hasAttachments && <Paperclip size={13} aria-hidden />}
            {t.snoozedUntil && t.snoozedUntil > Date.now() && <span className="chip-snooze"><AlarmClock size={11} aria-hidden />{capitalize(whenLabel(t.snoozedUntil))}</span>}
          </span>
          <span className="row-date">{shortDate(t.date)}</span>
        </>
      ) : (
      <div className="row-main">
        <div className="row-line">
          <span className="row-from">
            <SenderText sender={sender} folder={viewFolder} />
            {t.count > 1 && <span className="n">{t.count}</span>}
          </span>
          <span className="row-icons">
            {t.hasAttachments && <Paperclip size={13} aria-hidden />}
            {t.snoozedUntil && t.snoozedUntil > Date.now() && (
              <span className="chip-snooze"><AlarmClock size={11} aria-hidden />{capitalize(whenLabel(t.snoozedUntil))}</span>
            )}
          </span>
          <span className="row-date">{shortDate(t.date)}</span>
        </div>
        <div className="row-line">
          <span className="row-sub">
            <span className="subj">
              <Highlight text={t.subject || "(no subject)"} />
            </span>
            {t.snippet && (
              <span className="snip">
                {" · "}
                <Highlight text={t.snippet} />
              </span>
            )}
          </span>
        </div>
      </div>
      )}
      <div className="row-actions" onClick={stop}>
        {viewFolder === "TRASH" ? (
          <button className="icon-btn sm" title="Restore" aria-label="Restore" onClick={() => void A.restore([t.threadId])}>
            <RotateCcw size={15} />
          </button>
        ) : (
          <button className="icon-btn sm" title="Delete (#)" aria-label="Delete" onClick={() => void A.trash([t.threadId])}>
            <Trash2 size={15} />
          </button>
        )}
        <button
          className="icon-btn sm"
          title={t.unread ? "Mark as read" : "Mark as unread"}
          aria-label={t.unread ? "Mark as read" : "Mark as unread"}
          onClick={() => void A.markRead(t.unread, [t.threadId])}
        >
          {t.unread ? <MailOpen size={15} /> : <Mail size={15} />}
        </button>
        {(viewFolder === "INBOX" || viewFolder === "SNOOZED") && (
          <button className="icon-btn sm" title="Snooze (B)" aria-label="Snooze" onClick={(e) => setSnoozeAnchor(e.currentTarget)}>
            <AlarmClock size={15} />
          </button>
        )}
      </div>
      {snoozeAnchor && (
        <TimePicker
          anchor={snoozeAnchor}
          kind="snooze"
          align="right"
          onClose={() => setSnoozeAnchor(null)}
          onPick={(ms) => {
            setSnoozeAnchor(null);
            void A.snooze(t.threadId, ms);
          }}
        />
      )}
    </div>
  );
}

function EmptyState() {
  const folder = useStore((s) => s.folder);
  const status = useStore((s) => s.status);
  const loading = useStore((s) => s.loadingList);
  if (loading) return <ListSkeleton />;
  if (status?.phase === "backfill" && folder === "INBOX")
    return (
      <div className="empty">
        <div>
          <EmptyArt kind="fetching" />
          <div className="big">Fetching your mail…</div>
          This first sync runs in the background.
          {status.total > 0 && (
            <div className="fetch-bar" role="progressbar" aria-valuenow={Math.round((status.backfilled / status.total) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.min(100, (status.backfilled / status.total) * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  const text: Record<string, string> = {
    INBOX: "You're all caught up",
    SNOOZED: "Nothing snoozed",
    SENT: "No sent mail",
    DRAFT: "No drafts",
    TRASH: "Trash is empty",
    SPAM: "No spam. Nice.",
  };
  const art: Record<string, EmptyKind> = {
    INBOX: "inbox",
    SNOOZED: "snoozed",
    SENT: "sent",
    DRAFT: "drafts",
    TRASH: "trash",
    SPAM: "spam",
  };
  return (
    <div className="empty">
      <div>
        <EmptyArt kind={art[folder] ?? "inbox"} />
        <div className="big">{text[folder] ?? "Nothing here"}</div>
        {folder === "INBOX" && `Enjoy the rest of your ${partOfDay()}.`}
      </div>
    </div>
  );
}

function ListMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align="right">
      <button
        className="menu-item"
        onClick={() => {
          onClose();
          void A.markAllRead();
        }}
      >
        <CheckCheck size={15} /> Mark all as read
      </button>
    </Popover>
  );
}

export function ThreadList() {
  const folder = useStore((s) => s.folder);
  const search = useStore((s) => s.search);
  // Search lives in this header: a button (or / anywhere) opens the field in place of the
  // folder's name, and it folds back once it's left empty.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const open = () => setSearchOpen(true);
    window.addEventListener("post:focus-search", open);
    return () => window.removeEventListener("post:focus-search", open);
  }, []);
  // Folding back: the field shrinks into the search button, then the folder's name fades in.
  const [unfolding, setUnfolding] = useState(false);
  const closing = useRef(false);
  const closeSearch = () => {
    if (closing.current) return;
    const done = () => {
      closing.current = false;
      setSearchOpen(false);
      setUnfolding(true);
      window.setTimeout(() => setUnfolding(false), 400);
    };
    const w = document.querySelector<HTMLElement>(".list-head .search-wrap");
    if (!w || reduceMotion()) return done();
    closing.current = true;
    w.animate(
      [
        { clipPath: "inset(0 0 0 0 round 8px)", opacity: 1 },
        { clipPath: "inset(0 0 0 calc(100% - 64px) round 8px)", opacity: 0 },
      ],
      { duration: 200, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    ).finished.then(done, done);
  };
  useEffect(() => {
    // Cleared from elsewhere (Esc in the list): fold back unless you're still typing in it.
    if (!search && !document.activeElement?.closest(".list-head")) closeSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const threads = useStore((s) => s.threads);
  const total = useStore((s) => s.total);
  const selectedId = useStore((s) => s.selectedId);
  const cursorId = useStore((s) => s.cursorId);
  const checked = useStore((s) => s.checked);
  const leaving = useStore((s) => s.leaving);
  const counts = useStore((s) => s.counts);
  const loadThreads = useStore((s) => s.loadThreads);
  const items = useStore((s) => s.visibleThreads)();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ t: ThreadSummary; p: { x: number; y: number } } | null>(null);
  const [listMenu, setListMenu] = useState<HTMLElement | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // "Back to top" appears once you're well down the list (about 20 conversations), not after a nudge.
  const [deep, setDeep] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  // Clearing the last email in the inbox (not just opening an empty folder) earns a small burst.
  const [cleared, setCleared] = useState(0);
  const lastCount = useRef<{ folder: string; n: number }>({ folder: "", n: 0 });
  const prev = useRef<{ key: string; ids: Set<string>; top: number }>({ key: "", ids: new Set(), top: 0 });

  // A label where the date group changes; that row gets room for it above.
  const now = new Date();
  const groups = items.map((t, i) => {
    const g = dateGroup(t.date, now);
    return i === 0 || g !== dateGroup(items[i - 1].date, now) ? g : null;
  });
  const groupKey = groups.map((g, i) => (g ? i : "")).join(",");

  // Measure the list's width to pick its layout (and the virtual list's row height).
  const paneRef = useRef<HTMLElement>(null);
  const [listSize, setListSize] = useState<ListSize>("medium");
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListSize(sizeFor(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Crossing into another layout: rows take their new places at once and the list fades back in,
  // rather than every row gliding to a new height.
  const shownSize = useRef(listSize);
  useLayoutEffect(() => {
    if (shownSize.current === listSize) return;
    shownSize.current = listSize;
    const pane = paneRef.current;
    if (!pane || reduceMotion()) return;
    pane.classList.add("relayout");
    scrollRef.current?.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: motionMs("fast"), easing: motionEase("ease") });
    requestAnimationFrame(() => requestAnimationFrame(() => pane.classList.remove("relayout")));
  }, [listSize]);
  const rowH = ROW_H[listSize];
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowH + (groups[i] ? GROUP : 0),
    overscan: 10,
    // Breathing room so the first row's highlight doesn't touch the header line.
    paddingStart: 6,
    paddingEnd: 6,
    scrollPaddingStart: 6,
    getItemKey: (i) => items[i].threadId,
  });

  // Row heights change when group labels move (new mail, deletions, a different folder).
  useEffect(() => {
    v.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, rowH]);

  // Highlight conversations that arrive while you're looking at the list.
  useEffect(() => {
    const key = `${folder}|${search?.query ?? ""}`;
    const ids = new Set(threads.map((t) => t.threadId));
    const p = prev.current;
    if (p.key === key && p.ids.size) {
      const arrived = threads.filter((t) => !p.ids.has(t.threadId) && t.date > p.top).map((t) => t.threadId);
      if (arrived.length && arrived.length < 20 && claimHighlight(true)) {
        setFresh(new Set(arrived));
        window.setTimeout(() => setFresh(new Set()), motionMs("highlight") + 100);
      }
    }
    prev.current = { key, ids, top: threads[0]?.date ?? 0 };
  }, [threads, folder, search?.query]);

  // Keep the keyboard cursor visible.
  useEffect(() => {
    const id = cursorId ?? selectedId;
    if (!id) return;
    const i = items.findIndex((t) => t.threadId === id);
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorId, selectedId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [folder, search?.query]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      setDeep(el.scrollTop > ROW * 20);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollTop(el.scrollTop));
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [items.length > 0]);

  // The date group you're scrolled into stays pinned at the top; the next one pushes it away.
  let stuck: string | null = null;
  let nextGroupAt = Infinity;
  for (const m of v.measurementsCache) {
    if (!groups[m.index]) continue;
    if (m.start <= scrollTop + 6) stuck = groups[m.index];
    else {
      nextGroupAt = m.start;
      break;
    }
  }
  const stuckPush = Math.min(0, nextGroupAt - scrollTop - GROUP);

  const loadingList = useStore((s) => s.loadingList);
  useEffect(() => {
    const was = lastCount.current;
    if (folder === "INBOX" && !search && !loadingList && was.folder === folder && was.n > 0 && items.length === 0)
      setCleared((c) => c + 1);
    lastCount.current = { folder, n: items.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, folder, loadingList]);

  // How many emails have scrolled out of sight above (for "Back to top").
  const above = v.measurementsCache.findIndex((m) => m.end > scrollTop + 6);

  // Infinite scroll
  const last = v.getVirtualItems().at(-1);
  useEffect(() => {
    if (!search && last && last.index >= threads.length - 15 && threads.length < total) {
      void loadThreads({ more: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.index, threads.length, total, search]);

  if (folder === "SCHEDULED" && !search && !searchOpen) return <ScheduledList />;

  const title = search ? "Results" : folderTitle(folder);
  const unread = search ? 0 : folder === "INBOX" || folder === "SPAM" || folder.startsWith("sec:") ? counts[folder] ?? 0 : 0;
  const sub = search
    ? (<><RollingCount value={items.length} />{search.remote === null ? "+" : ""} found</>)
    : checked.length
      ? `${checked.length} selected`
      : unread
        ? (<><RollingCount value={unread} /> unread</>)
        : "";
  const selIndex = items.findIndex((t) => t.threadId === selectedId);
  const selItem = selIndex >= 0 ? v.getVirtualItems().find((vi) => vi.index === selIndex) : undefined;

  return (
    <section className={cx("list-pane", `size-${listSize}`)} ref={paneRef} aria-label={title}>
      <div className={cx("list-head", (search || searchOpen) && "searching", unfolding && "unfolding")}>
        {search || searchOpen ? (
          // Searching: the field itself is the heading, with how many were found inside it.
          <SearchBox
            extra={
              search && (
                <span className="found-pill tnum" aria-live="polite">
                  {sub}
                </span>
              )
            }
            onDone={closeSearch}
          />
        ) : (
          <>
            {/* The folder's own icon, in the accent, beside its name. */}
            {ICONS[folder as MailFolder] && <span className="lh-folder" aria-hidden>{ICONS[folder as MailFolder]}</span>}
            <h2>{title}</h2>
            <span className={cx("sub tnum", !checked.length && unread > 0 && "pill")} aria-live="polite">
              {sub}
            </span>
          </>
        )}
        {!search && !searchOpen && (
          <button className="icon-btn sm" title="Search mail (/)" aria-label="Search mail" onClick={() => setSearchOpen(true)}>
            <Search size={16} />
            <KeyHint k="/" />
          </button>
        )}
        {!search && !searchOpen && folder !== "SENT" && folder !== "DRAFT" && !folder.startsWith("sec:") && (
          <button className="icon-btn sm" title="More" aria-label="List options" onClick={(e) => setListMenu(e.currentTarget)}>
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>
      {search && (
        <div className="search-banner" aria-live="polite">
          {search.loading ? (
            <>
              <Loader2 size={12} className="spin" /> Searching Gmail for older mail…
            </>
          ) : search.remoteError ? (
            <>Couldn't reach Gmail. Showing local results.</>
          ) : search.remote ? (
            <>Showing local and Gmail results</>
          ) : (
            <>
              Local results
              <button className="banner-btn" title="Also search older mail in Gmail (Enter)" onClick={() => void useStore.getState().runRemoteSearch()}>
                Search Gmail too
              </button>
            </>
          )}
        </div>
      )}
      {!search && (folder === "TRASH" || folder === "SPAM") && items.length > 0 && (
        // A gentle note on what happens to mail left here.
        <div className={cx("folder-note", folder === "SPAM" && "spam")}>
          {folder === "TRASH" ? <Trash2 size={14} /> : <OctagonAlert size={14} />}
          <span>
            {folder === "TRASH" ? "Conversations in Trash" : "Conversations in Spam"} are deleted for good after 30 days.
          </span>
        </div>
      )}
      <div
        className="list-scroll"
        ref={scrollRef}
        role="listbox"
        aria-label={`${title} conversations`}
        aria-multiselectable
        aria-activedescendant={cursorId ? `row-${cursorId}` : undefined}
        tabIndex={0}
      >
        {items.length === 0 ? (
          search ? (
            <div className="empty">
              <div>
                {!search.loading && <EmptyArt kind="search" />}
                <div className="big">{search.loading ? "Searching…" : "No matches"}</div>
                {!search.loading && "Try different words, or from:, subject:, has:attachment"}
              </div>
            </div>
          ) : (
            <EmptyState />
          )
        ) : (
          <>
          {stuck && scrollTop > 6 && (
            <div className="list-sticky" style={{ transform: `translateY(${stuckPush}px)` }} aria-hidden>
              {stuck}
            </div>
          )}
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {selItem && (
              <div
                className="sel-ind"
                // Same height as the rows in the list's current layout.
                style={{ transform: `translateY(${selItem.start + (groups[selIndex] ? GROUP : 0)}px)`, height: rowH }}
              />
            )}
            {v.getVirtualItems().map((vi) => {
              const t = items[vi.index];
              const group = groups[vi.index];
              return (
                <Fragment key={t.threadId}>
                {group && (
                  <div className="list-group" style={{ transform: `translateY(${vi.start}px)` }} aria-hidden>
                    {group}
                  </div>
                )}
                <Row
                  t={t}
                  top={vi.start + (group ? GROUP : 0)}
                  selected={t.threadId === selectedId}
                  cursor={t.threadId === cursorId && t.threadId !== selectedId}
                  checked={checked.includes(t.threadId)}
                  leaving={leaving.includes(t.threadId)}
                  fresh={fresh.has(t.threadId)}
                  onMenu={(tt, p) => setMenu({ t: tt, p })}
                  size={listSize}
                />
                </Fragment>
              );
            })}
          </div>
          {/* The bottom of the folder: a small stamp says there's nothing further down. */}
          {!search && items.length > 6 && threads.length >= total && (
            <div className="list-end" aria-hidden>
              <MailCheck size={14} />
              That's everything
            </div>
          )}
          </>
        )}
      </div>
      {deep && (
        <button
          className="to-top-pill"
          aria-label="Back to top"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            // From far down, jump most of the way, then glide the last stretch.
            if (el.scrollTop > ROW * 12) el.scrollTop = ROW * 12;
            el.scrollTo({ top: 0, behavior: scrollBehavior() });
          }}
        >
          <ArrowUpToLine size={14} />
          {above} above
        </button>
      )}
      <InboxZeroConfetti fire={cleared} />
      {menu && <ThreadMenu t={menu.t} point={menu.p} onClose={() => setMenu(null)} />}
      {listMenu && <ListMenu anchor={listMenu} onClose={() => setListMenu(null)} />}
    </section>
  );
}
