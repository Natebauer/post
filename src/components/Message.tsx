/** One message in a conversation: its header, body and menu, plus the source viewer and sender card. */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Download,
  FileCode,
  Forward,
  MoreHorizontal,
  PenSquare,
  Pencil,
  Printer,
  Reply,
  ReplyAll,
  Search,
  X,
  Check,
  Copy,
  FileDown,
} from "lucide-react";
import { api, errText, type Message } from "../api";
import { useStore } from "../store";
import * as A from "../actions";
import { fromComposeData, newDraft, openCompose } from "../compose";
import { useDialogFocus, usePresence } from "../hooks";
import { cx, displayName, linkify, longDate, relativeAgo, shortDate } from "../util";
import { Avatar } from "./Avatar";
import { EmailFrame, TextSizeMenuRow } from "./EmailFrame";
import { Attachments } from "./Attachments";
import { Popover } from "./Popover";
import { Highlight } from "./Highlight";
import { InviteCard } from "./Invite";

/**
 * An email address followed by a small copy icon. Clicking the address or the icon copies it; the
 * icon turns into a check for a moment. With `iconOnly`, just the icon (when the address is
 * already shown nearby, as a sender's name).
 */
export function CopyAddress({ email, className, iconOnly }: { email: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    // Inside a message header, a click would otherwise also collapse the message.
    e.stopPropagation();
    navigator.clipboard
      .writeText(email)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
        useStore.getState().snack({ text: `Copied ${email}`, ms: 1800 });
      })
      .catch(() => useStore.getState().snack({ text: "Couldn't copy the address" }));
  };
  return (
    <span className={cx("copy-addr", copied && "copied", className)}>
      {!iconOnly && <span className="copy-text">{email}</span>}
      <button type="button" className="copy-icon" onClick={copy} title="Copy address" aria-label={`Copy ${email}`}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

export function PlainBody({ text }: { text: string }) {
  return (
    <div className="msg-text">
      {linkify(text).map((p, i) =>
        typeof p === "string" ? (
          <Highlight key={i} text={p} />
        ) : (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(p.url);
            }}
          >
            {p.url}
          </a>
        ),
      )}
    </div>
  );
}

async function editDraft(m: Message) {
  try {
    await openCompose(fromComposeData(await api.loadDraft(m.id)));
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
}

/** Discard a saved draft. Gmail deletes drafts for good, so this waits a moment for Undo. */
async function discardDraft(m: Message) {
  try {
    const c = await api.loadDraft(m.id);
    if (!c.draftId) return;
    let undone = false;
    const timer = window.setTimeout(() => {
      if (!undone) void api.deleteDraft(c.draftId!).catch((e) => useStore.getState().snack({ text: errText(e) }));
    }, 8500);
    useStore.getState().snack({
      text: "Draft discarded",
      action: {
        label: "Undo",
        run: () => {
          undone = true;
          window.clearTimeout(timer);
        },
      },
    });
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
}

/** Raw message source viewer. */
export function SourceView({ m, onClose }: { m: Message; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const { mounted, closing } = usePresence(open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  useEffect(() => {
    api.getRaw(m.id).then(setSrc).catch((e) => setSrc(`Couldn't load: ${errText(e)}`));
  }, [m.id]);
  useEffect(() => {
    if (!mounted) onClose();
  }, [mounted, onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  return createPortal(
    <>
      <div className={cx("scrim", closing && "closing")} onClick={() => setOpen(false)} />
      <div ref={dialogRef} className={cx("modal quicklook", closing && "closing")} role="dialog" aria-modal="true" aria-label="Original message">
        <div className="ql-head">
          <strong style={{ flex: 1 }}>Original message</strong>
          <button className="btn ghost" onClick={() => src && void navigator.clipboard.writeText(src)}>
            <Copy size={15} /> Copy
          </button>
          <button className="btn ghost" onClick={() => void A.saveOriginal(m)}>
            <FileDown size={15} /> Save as .eml
          </button>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="ql-body" style={{ placeItems: "stretch" }}>
          <pre className="source">{src ?? "Loading…"}</pre>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Sender details on hover. */
export function SenderCard({ m, children }: { m: Message; children: React.ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number>();
  const ref = useRef<HTMLButtonElement>(null);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(ref.current), 450);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(null), 250);
  };
  const name = m.from.name || m.from.email;
  return (
    <>
      <button
        ref={ref}
        className="who-btn"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(ref.current);
        }}
        aria-label={`${name}, sender details`}
      >
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="hovercard" onMouseEnter={show} onMouseLeave={hide}>
          <div className="top">
            <Avatar email={m.from.email} name={name} size="lg" />
            <div style={{ minWidth: 0 }}>
              <div className="nm">{name}</div>
              <div className="em">{m.from.email}</div>
            </div>
          </div>
          <div className="acts">
            <button
              className="btn outline"
              onClick={() => {
                setAnchor(null);
                void openCompose(newDraft(useStore.getState().settings, { to: [m.from] }));
              }}
            >
              <PenSquare size={14} /> Email
            </button>
            <button
              className="btn outline"
              onClick={() => {
                setAnchor(null);
                A.searchFrom(m.from.email);
              }}
            >
              <Search size={14} /> Mail from
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                void navigator.clipboard.writeText(m.from.email);
                useStore.getState().snack({ text: "Address copied", ms: 1500 });
              }}
            >
              <Copy size={14} /> Copy
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}

function MessageMenu({
  m,
  anchor,
  onClose,
  onSource,
}: {
  m: Message;
  anchor: HTMLElement;
  onClose: () => void;
  onSource: () => void;
}) {
  const go = (f: () => void) => () => {
    onClose();
    f();
  };
  const hasAtts = m.attachments.some((a) => !a.inline);
  return (
    <Popover anchor={anchor} onClose={onClose} align="right">
      <button className="menu-item" onClick={go(() => void A.respond("replyAll", m.id))}>
        <ReplyAll size={15} /> Reply all
      </button>
      <button className="menu-item" onClick={go(() => void A.respond("forward", m.id))}>
        <Forward size={15} /> Forward
      </button>
      <div className="menu-sep" />
      {m.html && (
        <>
          <TextSizeMenuRow messageId={m.id} />
          <div className="menu-sep" />
        </>
      )}
      <button className="menu-item" onClick={go(() => A.printMessage(m))}>
        <Printer size={15} /> Print
      </button>
      <button className="menu-item" onClick={go(onSource)}>
        <FileCode size={15} /> Show original
      </button>
      <button className="menu-item" onClick={go(() => void A.saveOriginal(m))}>
        <FileDown size={15} /> Save as .eml
      </button>
      {hasAtts && (
        <button className="menu-item" onClick={go(() => void A.downloadAll(m))}>
          <Download size={15} /> Download all attachments
        </button>
      )}
    </Popover>
  );
}

export function MessageCard({
  m,
  expanded,
  toggle,
  me,
  headless,
}: {
  m: Message;
  expanded: boolean;
  toggle: () => void;
  me: string;
  /** A single email's sender is shown in the reading header, so the card skips its own. */
  headless?: boolean;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [source, setSource] = useState(false);
  const { mounted, closing } = usePresence(expanded);
  // Animate opening only when the user expands it, not on the thread's first render.
  const prevExpanded = useRef(expanded);
  const [anim, setAnim] = useState(false);
  useEffect(() => {
    if (prevExpanded.current !== expanded) setAnim(true);
    prevExpanded.current = expanded;
  }, [expanded]);
  const recipients = [...m.to, ...m.cc].map((a) => displayName(a, me));
  const query = useStore((s) => s.search?.query);

  if (!mounted) {
    return (
      <article className="msg collapsed" aria-label={`Message from ${displayName(m.from, me)}, collapsed`}>
        <div
          className="msg-head"
          onClick={toggle}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <Avatar email={m.from.email} name={m.from.name || m.from.email} size="sm" />
          <div className="msg-who" style={{ display: "flex", gap: 10, minWidth: 0, alignItems: "baseline" }}>
            <span className="msg-name" style={{ flex: "none", maxWidth: "40%" }}>
              {m.isDraft && <span className="draft-tag">Draft</span>}
              {displayName(m.from, me)}
            </span>
            <span className="msg-meta" style={{ flex: 1 }}>
              {m.snippet}
            </span>
          </div>
          <span className="msg-date">{shortDate(m.date)}</span>
        </div>
      </article>
    );
  }
  const head = (
    <div
      className="msg-head"
      // Dragging to select header text shouldn't fold the message away.
      onClick={() => window.getSelection()?.isCollapsed !== false && toggle()}
      role="button"
      tabIndex={0}
      aria-expanded
      onKeyDown={(e) => {
        // Only the header itself: Enter on the sender, Reply or "…" keeps its own meaning.
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <Avatar email={m.from.email} name={m.from.name || m.from.email} size="lg" />
      <div className="msg-who">
        <div className="msg-line">
          <span className="msg-name">
            {m.isDraft && <span className="draft-tag">Draft</span>}
            <SenderCard m={m}>{m.from.name || m.from.email}</SenderCard>
          </span>
          <span className="msg-date" title={new Date(m.date).toString()}>
            {longDate(m.date)} <span className="faint">{relativeAgo(m.date)}</span>
          </span>
        </div>
        <div className="msg-meta" title={[...m.to, ...m.cc].map((a) => a.email).join(", ")}>
          {m.from.name && <CopyAddress email={m.from.email} className="addr" />}
          to {recipients.length ? recipients.join(", ") : "undisclosed recipients"}
          {m.bcc.length > 0 && `, bcc ${m.bcc.map((a) => displayName(a, me)).join(", ")}`}
        </div>
      </div>
      {!m.isDraft && (
        <div className="msg-tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn sm msg-reply" title="Reply" aria-label="Reply" onClick={() => void A.respond("reply", m.id)}>
            <Reply size={15} />
          </button>
          <button className="icon-btn sm" title="More" aria-label="More actions" onClick={(e) => setMenu(e.currentTarget)}>
            <MoreHorizontal size={15} />
          </button>
        </div>
      )}
    </div>
  );
  return (
    <article className="msg" aria-label={`Message from ${displayName(m.from, me)}`}>
      {!headless && head}
      <div className={cx("msg-collapse", anim && "anim", closing && "closing")}>
        <div>
          <div className="msg-body">
            <InviteCard m={m} />
            {m.html ? (
              <EmailFrame html={m.html} attachments={m.attachments} highlight={query} sender={m.from.email} messageId={m.id} />
            ) : (
              <PlainBody text={m.text} />
            )}
            <Attachments messageId={m.id} attachments={m.attachments} />
            {m.isDraft && (
              <div className="reply-bar" style={{ marginLeft: 0 }}>
                <button className="btn outline" onClick={() => void editDraft(m)}>
                  <Pencil size={14} /> Edit draft
                </button>
                <button className="btn ghost danger" onClick={() => void discardDraft(m)}>
                  Discard
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {menu && <MessageMenu m={m} anchor={menu} onClose={() => setMenu(null)} onSource={() => setSource(true)} />}
      {source && <SourceView m={m} onClose={() => setSource(false)} />}
    </article>
  );
}
