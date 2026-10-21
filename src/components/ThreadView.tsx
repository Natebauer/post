import { Fragment, useEffect, useRef, useState } from "react";
import { READY_WAIT_MS } from "../motionTokens";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlarmClock,
  AlarmClockOff,
  Download,
  FileCode,
  Forward,
  Mail,
  MailOpen,
  MailX,
  MoreHorizontal,
  Pin,
  PinOff,
  Printer,
  Reply,
  ReplyAll,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
  FileDown,
  Archive,
  Bell,
  BellOff,
  ChevronLeft,
  FolderInput,
  Plus,
  Sparkles,
  Star,
  Users,
} from "lucide-react";
import { api, errText, type Message, type ThreadDetail } from "../api";
import { useStore } from "../store";
import * as A from "../actions";
import { cx, displayName, longDate, relativeAgo, whenLabel } from "../util";
import { Avatar } from "./Avatar";
import { TimePicker } from "./TimePicker";
import { Composer } from "./Composer";
import { Popover } from "./Popover";
import { TextSizeMenuRow } from "./EmailFrame";
import { Highlight } from "./Highlight";
import { ScheduledView } from "./Scheduled";
import { CopyAddress, MessageCard, SenderCard, SourceView } from "./Message";
import { Home, togglePin } from "./Home";
import { addSender, addToCategory, sectionKey } from "../senders";

/** Who a plain Reply goes to: the sender of the last message, or its recipient if that was you. */
function replyName(t: ThreadDetail, me: string) {
  const last = [...t.messages].reverse().find((m) => !m.isDraft);
  if (!last) return "";
  const who = last.from.email.toLowerCase() === me.toLowerCase() ? last.to[0] ?? last.from : last.from;
  return displayName(who).split(" ")[0] || who.email;
}

const UNSUB_TEXT = /unsubscribe|opt[\s-]?out|email preferences|manage (your )?(email |notification |subscription )?(preferences|settings|subscriptions)|stop receiving/i;
const UNSUB_HREF = /unsubscribe|opt[-_]?out|email[-_]?preferences|manage[-_]?subscriptions/i;

/** Find how to leave this mailing list: Gmail's List-Unsubscribe header, or a link in the email. */
function findUnsubscribe(messages: Message[]): { messageId: string; header: boolean; link: string | null } | null {
  for (const m of [...messages].reverse()) {
    if (m.isDraft) continue;
    if (m.canUnsubscribe) return { messageId: m.id, header: true, link: null };
    let link: string | null = null;
    if (m.html) {
      const doc = new DOMParser().parseFromString(m.html, "text/html");
      const anchors = [...doc.querySelectorAll("a[href]")].filter((a) => /^https?:/i.test(a.getAttribute("href") ?? ""));
      const byText = (re: RegExp) => anchors.find((a) => re.test((a.textContent ?? "").replace(/\s+/g, " ")));
      const a =
        byText(/unsubscribe/i) ?? byText(UNSUB_TEXT) ?? anchors.find((x) => UNSUB_HREF.test(x.getAttribute("href") ?? ""));
      link = a?.getAttribute("href") ?? null;
    } else {
      link = m.text.match(/https?:\/\/\S*(unsubscribe|opt[-_]?out)\S*/i)?.[0] ?? null;
    }
    if (link) return { messageId: m.id, header: false, link };
  }
  return null;
}

function BulkView({ ids }: { ids: string[] }) {
  const folder = useStore((s) => s.folder);
  const [snooze, setSnooze] = useState<HTMLElement | null>(null);
  return (
    <div className="bulk" role="region" aria-label="Selected conversations">
      <div>
        {/* How many, as a large accent numeral that pops as the count changes. */}
        <div className="bulk-count" key={ids.length} aria-hidden>
          {ids.length}
        </div>
        <div className="big">{ids.length} conversations selected</div>
        <div className="actions">
          <button className="btn outline" onClick={() => void A.markRead(true, ids)}>
            <MailOpen size={15} /> Mark read
          </button>
          <button className="btn outline" onClick={() => void A.markRead(false, ids)}>
            <Mail size={15} /> Mark unread
          </button>
          {(folder === "INBOX" || folder === "SNOOZED") && (
            <button className="btn outline" onClick={(e) => setSnooze(e.currentTarget)}>
              <AlarmClock size={15} /> Snooze
            </button>
          )}
          {folder !== "TRASH" && (
            <button className="btn outline" onClick={() => void A.spam(ids)}>
              <ShieldAlert size={15} /> {folder === "SPAM" ? "Not spam" : "Spam"}
            </button>
          )}
          {folder === "TRASH" ? (
            <button className="btn outline" onClick={() => void A.restore(ids)}>
              <RotateCcw size={15} /> Restore
            </button>
          ) : (
            <button className="btn outline danger" onClick={() => void A.trash(ids)}>
              <Trash2 size={15} /> Delete
            </button>
          )}
        </div>
        <p className="faint" style={{ marginTop: 16, fontSize: 12 }}>
          Ctrl+click to add or remove · Shift+click for a range · Esc to clear
        </p>
      </div>
      {snooze && (
        <TimePicker
          anchor={snooze}
          kind="snooze"
          onClose={() => setSnooze(null)}
          onPick={(ms) => {
            setSnooze(null);
            void A.snooze(ids, ms);
          }}
        />
      )}
    </div>
  );
}

/** The unsubscribe option for a thread, worked out once per loaded thread (it parses HTML). */
const unsubCache = new WeakMap<ThreadDetail, ReturnType<typeof findUnsubscribe>>();
function unsubscribeFor(t: ThreadDetail) {
  if (!unsubCache.has(t)) unsubCache.set(t, findUnsubscribe(t.messages));
  return unsubCache.get(t)!;
}

/** What a background refresh compares: the messages and their state. */
const threadSig = (t: ThreadDetail) =>
  `${t.snoozedUntil ?? ""}|${t.messages.map((m) => `${m.id}:${m.unread ? 1 : 0}:${m.labels.join(",")}`).join(";")}`;

/** "me, Ana" for the reading header's byline. */
function recipientsOf(m: Message, me: string) {
  return [...m.to, ...m.cc].map((a) => displayName(a, me)).join(", ") || "undisclosed recipients";
}

/** "Ana, me" for a thread header: each sender once, in the order they first wrote. */
function threadPeople(t: ThreadDetail, me: string) {
  return [...new Set(t.messages.map((m) => displayName(m.from, me)))].join(", ");
}

export function ThreadView() {
  const selectedId = useStore((s) => s.selectedId);
  const checked = useStore((s) => s.checked);
  if (checked.length > 1) return <BulkView ids={checked} />;
  if (selectedId?.startsWith("outbox:")) return <ScheduledView id={Number(selectedId.slice(7))} />;
  return <ThreadDetailView />;
}

function ThreadDetailView() {
  const selectedId = useStore((s) => s.selectedId);
  const folder = useStore((s) => s.folder);
  const thread = useStore((s) => s.thread);
  const compose = useStore((s) => s.compose);
  const settings = useStore((s) => s.settings);
  const me = useStore((s) => s.info?.email ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement | null>(null);
  const [pinned, setPinned] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The header's … menu, and "Show original" opened from it.
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [menuPage, setMenuPage] = useState<"main" | "sections">("main");
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(false);
    if (selectedId) void api.isMuted(selectedId).then(setMuted).catch(() => {});
  }, [selectedId]);
  const [sourceOf, setSourceOf] = useState<Message | null>(null);
  const seq = useRef(0);
  // Moving between emails: the email in front stays fully visible while the next one loads out of
  // sight ("incoming"); once that has drawn, it replaces the front at once. Each keeps its own DOM
  // throughout, so nothing reloads or jumps.
  const [front, setFront] = useState<ThreadDetail | null>(null);
  const [incoming, setIncoming] = useState<ThreadDetail | null>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thread) {
      setFront(null);
      setIncoming(null);
      return;
    }
    if (!front || front.threadId === thread.threadId) {
      setFront(thread);
      setIncoming(null);
      return;
    }
    setIncoming(thread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);
  useEffect(() => {
    if (!incoming) return;
    const started = performance.now();
    let raf = 0;
    const ready = () => {
      const el = incomingRef.current;
      return !!el && !el.querySelector(".frame-wrap:not(.ready)");
    };
    const swap = () => {
      if (!ready() && performance.now() - started < READY_WAIT_MS) return void (raf = requestAnimationFrame(swap));
      setFront(incoming);
      setIncoming(null);
      scrollRef.current?.scrollTo({ top: 0 });
    };
    raf = requestAnimationFrame(swap);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  useEffect(() => {
    if (!selectedId) return;
    void api.isPinned(selectedId).then(setPinned).catch(() => {});
    const un = listen("home-changed", () => void api.isPinned(selectedId).then(setPinned).catch(() => {}));
    return () => void un.then((f) => f());
  }, [selectedId]);

  const viewFolder = (() => {
    const t = useStore.getState().visibleThreads().find((x) => x.threadId === selectedId);
    const f = t?.folder || folder;
    return f === "SNOOZED" ? "INBOX" : f;
  })();

  const load = async (id: string, keepState: boolean) => {
    const my = ++seq.current;
    if (!keepState) setError(null);
    try {
      const t: ThreadDetail = await api.getThread(id, viewFolder);
      if (my !== seq.current) return;
      // A background refresh that found nothing new leaves the open email alone (no re-render).
      const was = useStore.getState().thread;
      if (keepState && was && was.threadId === t.threadId && threadSig(was) === threadSig(t)) return;
      // Decide which messages are open before the thread renders, so they appear
      // already open rather than opening (and animating) a frame later.
      if (!keepState) {
        const ex = new Set<string>();
        t.messages.forEach((m, i) => {
          if (m.unread || m.isDraft || i === t.messages.length - 1) ex.add(m.id);
        });
        flushSync(() => setExpanded((prev) => new Set([...prev, ...ex])));
      }
      useStore.setState({ thread: t });
      if (!keepState) {
        scrollRef.current?.scrollTo({ top: 0 });
      } else {
        setExpanded((prev) => {
          const next = new Set(prev);
          const last = t.messages[t.messages.length - 1];
          if (last) next.add(last.id);
          return next;
        });
      }
      if (t.messages.some((m) => m.unread)) void A.markRead(true, [id]);
    } catch (e) {
      if (my === seq.current) setError(errText(e));
    } finally {
      if (my === seq.current) setSlow(false);
    }
  };

  useEffect(() => {
    if (!selectedId) {
      useStore.setState({ thread: null });
      return;
    }
    setSlow(false);
    // Keep showing the email that's on screen; only if the next one is slow does it dim (or, with
    // nothing on screen yet, show a skeleton).
    const slowTimer = window.setTimeout(() => setSlow(true), 400);
    const timer = window.setTimeout(() => void load(selectedId, false), 30);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    let timer: number | undefined;
    const un = listen("threads-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const id = useStore.getState().selectedId;
        const t = useStore.getState().thread;
        if (id && t && t.threadId === id) void load(id, true);
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFolder]);

  if (!selectedId) return <Home />;

  const shown = front;
  // The header and its buttons follow the email on screen (`shown`), so they don't blink while the
  // next email loads; `current` is only set once the on-screen email is the selected one.
  const current = front && front.threadId === selectedId ? front : null;
  const stale = !!front && !current && slow && !incoming;
  const single = shown?.messages.length === 1;
  const last = shown?.messages[shown.messages.length - 1];
  // The face of the conversation: the latest sender who isn't you (your own replies, like an
  // RSVP, shouldn't put your avatar on someone else's thread).
  const lead = shown ? [...shown.messages].reverse().find((m) => m.from.email.toLowerCase() !== me.toLowerCase()) ?? last : undefined;
  const inInbox = !!shown?.messages.some((m) => m.labels.includes("INBOX"));
  const starred = !!shown?.messages.some((m) => m.labels.includes("STARRED"));
  const sections = settings?.senderViews ?? [];
  const closeMenu = () => {
    setMoreAnchor(null);
    setMenuPage("main");
  };
  const unsub = shown ? unsubscribeFor(shown) : null;
  const messagesOf = (t: ThreadDetail) => {
    const one = t.messages.length === 1;
    // A long conversation folds its middle (the first email and the latest two stay) behind a pill
    // with the folded senders' faces, until it's opened or one of them is.
    const n = t.messages.length;
    const middle = n >= 5 && unfolded !== t.threadId ? t.messages.slice(1, n - 2) : [];
    const fold = middle.length >= 2 && !middle.some((m) => expanded.has(m.id)) ? middle : [];
    const folded = new Set(fold.map((m) => m.id));
    return t.messages.map((m, i) =>
      folded.has(m.id) ? (
        i === 1 ? (
          <button key="fold" type="button" className="msg-fold" onClick={() => setUnfolded(t.threadId)}>
            <span className="msg-fold-faces" aria-hidden>
              {[...new Map(fold.map((f) => [f.from.email, f.from])).values()].slice(0, 3).map((a) => (
                <Avatar key={a.email} email={a.email} name={a.name || a.email} size="xs" />
              ))}
            </span>
            {fold.length} more
          </button>
        ) : null
      ) : (
      <Fragment key={m.id}>
      {/* Where the conversation crosses into another day, a quiet marker on its timeline. */}
      {i > 0 && new Date(t.messages[i - 1].date).toDateString() !== new Date(m.date).toDateString() && (
        <div className="msg-day" role="separator">
          <span>{dayName(m.date)}</span>
        </div>
      )}
      <MessageCard
        m={m}
        me={me}
        headless={one}
        expanded={expanded.has(m.id)}
        toggle={() =>
          !one &&
          setExpanded((prev) => {
            const n = new Set(prev);
            if (n.has(m.id)) n.delete(m.id);
            else n.add(m.id);
            return n;
          })
        }
      />
      </Fragment>
      ),
    );
  };
  const inlineCompose =
    compose && (settings?.composeMode ?? "inline") === "inline" && compose.threadId === selectedId && compose.kind !== "new";

  return (
    <>
      <div className="read-head">
        <div className="read-head-inner">
          <button className="icon-btn rh-close" title="Close (U)" aria-label="Close conversation" onClick={() => useStore.getState().select(null)}>
            <X size={17} />
          </button>
          {lead && <Avatar key={lead.from.email} email={lead.from.email} name={lead.from.name || lead.from.email} size="lg" />}
          <div className="rh-title">
            {shown && (
              <div className="rh-subject">
                <h1 className="thread-subject" title={shown.subject}>
                  <Highlight text={shown.subject || "(no subject)"} />
                </h1>
                {selectedId && <StarToggle key={selectedId} threadId={selectedId} starred={starred} />}
              </div>
            )}
            {shown && last && (
              <div className="rh-by">
                {single ? (
                  <>
                    <span className="rh-name">
                      <SenderCard m={last}>{last.from.name || last.from.email}</SenderCard>
                    </span>
                    {!last.from.name && <CopyAddress email={last.from.email} iconOnly />}
                    <span> · to {recipientsOf(last, me)}</span>
                  </>
                ) : (
                  <>
                    <span>{shown.messages.length} messages · </span>
                    <span className="rh-name">{threadPeople(shown, me)}</span>
                  </>
                )}
                <span title={new Date(last.date).toString()}>
                  {" "}
                  · {longDate(last.date)} <span className="faint">{relativeAgo(last.date)}</span>
                </span>
                {/* The address last: when the line runs out of room, it's what fades, not the date. */}
                {single && last.from.name && (
                  <span>
                    {" · "}
                    <CopyAddress email={last.from.email} />
                  </span>
                )}
                {shown.snoozedUntil && (
                  <span className="rh-snoozed">
                    {" "}
                    · <AlarmClock size={12} /> Snoozed until {whenLabel(shown.snoozedUntil)}
                  </span>
                )}
              </div>
            )}
          </div>
          {unsub && (
            // Mailing lists: leaving is one quiet pill away, not only in the More menu.
            <button
              type="button"
              className="unsub-pill"
              title="Stop getting these emails"
              onClick={() => {
                if (unsub.header) void A.unsubscribe(unsub.messageId);
                else if (unsub.link) {
                  void openUrl(unsub.link);
                  useStore.getState().snack({ text: "Opened the unsubscribe page in your browser" });
                }
              }}
            >
              <MailX size={13} /> Unsubscribe
            </button>
          )}
          <div className="rh-actions" role="toolbar" aria-label="Conversation actions">
            {shown && shown.messages.some((m) => !m.isDraft) && (
              <>
                <button className="icon-btn labeled tb-reply" title="Reply (R)" aria-label="Reply" onClick={() => void A.respond("reply")}>
                  <Reply size={16} />
                  <span className="tb-label">Reply</span>
                </button>
                {shown.messages.some((m) => m.to.length + m.cc.length > 1) && (
                  <button className="icon-btn" title="Reply all (A)" aria-label="Reply all" onClick={() => void A.respond("replyAll")}>
                    <ReplyAll size={16} />
                  </button>
                )}
                <button className="icon-btn labeled" title="Forward (F)" aria-label="Forward" onClick={() => void A.respond("forward")}>
                  <Forward size={16} />
                  <span className="tb-label">Forward</span>
                </button>
                <span className="tb-sep" />
              </>
            )}
            <button
              className={cx("icon-btn labeled", pinned && "on")}
              title={pinned ? "Unpin from home (P)" : "Pin to home (P)"}
              aria-label={pinned ? "Unpin from home" : "Pin to home"}
              aria-pressed={pinned}
              onClick={() => void togglePin(selectedId).then(setPinned)}
            >
              {pinned ? <PinOff size={16} /> : <Pin size={16} />}
              <span className="tb-label">{pinned ? "Unpin" : "Pin"}</span>
            </button>
            {viewFolder === "SPAM" && (
              <button className="icon-btn labeled" title="Not spam" aria-label="Not spam" onClick={() => void A.spam()}>
                <ShieldAlert size={16} />
                <span className="tb-label">Not spam</span>
              </button>
            )}
            {viewFolder === "TRASH" ? (
              <button className="icon-btn labeled" title="Restore" aria-label="Restore" onClick={() => void A.restore()}>
                <RotateCcw size={16} />
                <span className="tb-label">Restore</span>
              </button>
            ) : (
              <button className="icon-btn labeled" title="Delete (#)" aria-label="Delete" onClick={() => void A.trash()}>
                <Trash2 size={16} />
                <span className="tb-label">Delete</span>
              </button>
            )}
            <button
              id="read-more"
              className={cx("icon-btn", moreAnchor && "on")}
              title="More"
              aria-label="More actions"
              aria-haspopup="menu"
              onClick={(e) => (moreAnchor ? closeMenu() : setMoreAnchor(e.currentTarget))}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>
      </div>
      {moreAnchor && (
        <Popover anchor={moreAnchor} onClose={closeMenu} align="right">
          {menuPage === "sections" ? (
            <>
              <button className="menu-item" onClick={() => setMenuPage("main")}>
                <ChevronLeft size={15} /> Add to section
              </button>
              <div className="menu-sep" />
              {sections.map((v) => (
                <button
                  key={sectionKey(v)}
                  className="menu-item"
                  onClick={() => {
                    closeMenu();
                    if (!last) return;
                    if (v.kind === "ai") void addToCategory(v, selectedId);
                    else
                      useStore.setState({
                        groupDrop: { key: sectionKey(v), threadId: selectedId, email: last.from.email, name: last.from.name, subject: shown?.subject ?? "" },
                      });
                  }}
                >
                  {v.kind === "ai" ? <Sparkles size={15} /> : <Users size={15} />} {v.name}
                </button>
              ))}
              {sections.length > 0 && <div className="menu-sep" />}
              {last && (
                <button className="menu-item" onClick={() => { closeMenu(); void addSender(last.from.email, last.from.name); }}>
                  <Plus size={15} /> New section for {last.from.name || last.from.email}
                </button>
              )}
            </>
          ) : (
            <>
          {inInbox && (
            <button className="menu-item" onClick={() => { closeMenu(); void A.archive([selectedId]); }}>
              <Archive size={15} /> Archive
            </button>
          )}
          <button className="menu-item" onClick={() => { closeMenu(); void A.star(selectedId, !starred); }}>
            <Star size={15} /> {starred ? "Remove star" : "Star"}
          </button>
          <button className="menu-item" onClick={() => setMenuPage("sections")}>
            <FolderInput size={15} /> Add to section…
          </button>
          <button
            className="menu-item"
            onClick={() => {
              closeMenu();
              const next = !muted;
              setMuted(next);
              void A.mute(selectedId, next).then((ok) => !ok && setMuted(!next));
            }}
          >
            {muted ? <Bell size={15} /> : <BellOff size={15} />} {muted ? "Unmute" : "Mute conversation"}
          </button>
          <div className="menu-sep" />
          {viewFolder === "INBOX" &&
            (shown?.snoozedUntil ? (
              <button className="menu-item" onClick={() => { setMoreAnchor(null); void A.unsnooze(selectedId); }}>
                <AlarmClockOff size={15} /> Unsnooze
              </button>
            ) : (
              <button
                className="menu-item"
                onClick={() => {
                  const at = moreAnchor;
                  setMoreAnchor(null);
                  setSnoozeAnchor(at);
                }}
              >
                <AlarmClock size={15} /> Snooze…
              </button>
            ))}
          <button className="menu-item" onClick={() => { setMoreAnchor(null); void A.markRead(false); }}>
            <Mail size={15} /> Mark as unread
          </button>
          {unsub && (
            <button
              className="menu-item"
              onClick={() => {
                setMoreAnchor(null);
                if (unsub.header) void A.unsubscribe(unsub.messageId);
                else if (unsub.link) {
                  void openUrl(unsub.link);
                  useStore.getState().snack({ text: "Opened the unsubscribe page in your browser" });
                }
              }}
            >
              <MailX size={15} /> Unsubscribe
            </button>
          )}
          {viewFolder !== "TRASH" && viewFolder !== "SPAM" && (
            <button className="menu-item" onClick={() => { setMoreAnchor(null); void A.spam(); }}>
              <ShieldAlert size={15} /> Report spam
            </button>
          )}
          {single && last && (
            <>
              <div className="menu-sep" />
              {last.html && (
                <>
                  <TextSizeMenuRow messageId={last.id} />
                  <div className="menu-sep" />
                </>
              )}
              <button className="menu-item" onClick={() => { setMoreAnchor(null); A.printMessage(last); }}>
                <Printer size={15} /> Print
              </button>
              <button className="menu-item" onClick={() => { setMoreAnchor(null); setSourceOf(last); }}>
                <FileCode size={15} /> Show original
              </button>
              <button className="menu-item" onClick={() => { setMoreAnchor(null); void A.saveOriginal(last); }}>
                <FileDown size={15} /> Save as .eml
              </button>
              {last.attachments.some((x) => !x.inline) && (
                <button className="menu-item" onClick={() => { setMoreAnchor(null); void A.downloadAll(last); }}>
                  <Download size={15} /> Download all attachments
                </button>
              )}
            </>
          )}
            </>
          )}
        </Popover>
      )}
      {sourceOf && <SourceView m={sourceOf} onClose={() => setSourceOf(null)} />}
      <div className="read-scroll" ref={scrollRef}>
        {!shown && !error && slow && (
          <div className="read-inner" aria-busy>
            <div className="skeleton" style={{ height: 26, width: "60%", marginBottom: 22 }} />
            <div className="skeleton" style={{ height: 14, width: "40%", marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 140 }} />
          </div>
        )}
        {!current && error && <div className="error">{error}</div>}
        {/* One list, in a fixed order (in front, loading), so each email keeps its own DOM as its
            role changes and nothing reloads. */}
        {[
          ...(shown ? [{ t: shown, role: "front" as const }] : []),
          ...(incoming ? [{ t: incoming, role: "in" as const }] : []),
        ].map(({ t, role }) => (
          <div
            key={t.threadId}
            ref={role === "in" ? incomingRef : undefined}
            className={cx(
              "read-inner",
              role === "in" && "layer-in",
              role === "front" && stale && "stale",
              t.messages.length === 1 && "single",
            )}
            aria-hidden={role === "front" ? undefined : true}
          >
            {messagesOf(t)}
            {role === "front" &&
              (inlineCompose ? (
                <Composer key={compose.key} draft={compose} mode="inline" />
              ) : (
                shown &&
                shown.messages.some((m) => !m.isDraft) && (
                  <div className="reply-bar">
                    <span className="reply-me">
                      <Avatar email={me} name={me} size="sm" />
                    </span>
                    <button className="reply-box" onClick={() => void A.respond("reply")}>
                      <Reply size={15} /> Reply to {replyName(shown, me)}…
                    </button>
                    {shown.messages.some((m) => m.to.length + m.cc.length > 1) && (
                      <button className="btn outline" onClick={() => void A.respond("replyAll")}>
                        <ReplyAll size={15} /> Reply all
                      </button>
                    )}
                    <button className="btn outline" onClick={() => void A.respond("forward")}>
                      <Forward size={15} /> Forward
                    </button>
                  </div>
                )
              ))}
          </div>
        ))}
      </div>
      {snoozeAnchor && (
        <TimePicker
          anchor={snoozeAnchor}
          kind="snooze"
          align="right"
          onClose={() => setSnoozeAnchor(null)}
          onPick={(ms) => {
            setSnoozeAnchor(null);
            void A.snooze(selectedId, ms);
          }}
        />
      )}
    </>
  );
}

/**
 * The conversation's star, beside its subject. Starring it pops the star in amber with a little
 * burst of sparks; unstarring just lets it go quiet.
 */
function StarToggle({ threadId, starred }: { threadId: string; starred: boolean }) {
  const [on, setOn] = useState(starred);
  const [burst, setBurst] = useState(0);
  useEffect(() => setOn(starred), [starred]);
  return (
    <button
      type="button"
      className={cx("rh-star", on && "on")}
      aria-pressed={on}
      title={on ? "Remove star" : "Star"}
      aria-label={on ? "Remove star" : "Star"}
      onClick={() => {
        const next = !on;
        setOn(next);
        if (next) setBurst((b) => b + 1);
        void A.star(threadId, next);
      }}
    >
      <Star size={17} fill={on ? "currentColor" : "none"} key={on ? `on${burst}` : "off"} />
      {burst > 0 && on && (
        <span className="star-burst" key={burst} aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ "--a": `${i * 45 + 22}deg` } as React.CSSProperties} />
          ))}
        </span>
      )}
    </button>
  );
}

/** "Today", "Yesterday", a weekday within the last week, else a short date. */
function dayName(ms: number): string {
  const d = new Date(ms);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === start.getFullYear() ? undefined : "numeric" });
}
