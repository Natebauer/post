import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, CalendarCheck, FileText, Inbox, Loader2, Mail, PenLine, Sparkles, X } from "lucide-react";
import { api, errText, type AskTurn, type CommandResult } from "../api";
import { useStore } from "../store";
import { scrollBehavior } from "../motionTokens";
import { useDialogFocus, usePresence } from "../hooks";
import { cx, shortDate } from "../util";
import * as A from "../actions";
import { sameAddr } from "../compose";
import { pendingInvites, type PendingInvite } from "../invites";
import { AskAction } from "./AskAction";
import { whenText } from "./Invite";

const QUESTIONS = ["When does my lease end?", "What's my flight confirmation number?", "How much was my last electric bill?"];
const COMMANDS = [
  "Accept all my calendar invitations from this week",
  "Archive the shipping notifications in my inbox",
  "Mark every newsletter as read",
  "Snooze the receipts until Saturday morning",
];

/** Answer text with its [n] citations turned into links to the emails they refer to. */
function Cited({ text, onOpen }: { text: string; onOpen: (n: number) => void }) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <p className="ask-answer">
      {parts.map((p, i) => {
        const m = p.match(/^\[([\d,\s]+)\]$/);
        if (!m) return <Fragment key={i}>{p}</Fragment>;
        return m[1].split(",").map((n) => (
          <button key={`${i}-${n}`} className="ask-cite" onClick={() => onOpen(Number(n.trim()))} title="Open this email">
            {n.trim()}
          </button>
        ));
      })}
    </p>
  );
}

/** Claude's plain-text reply with "- " lines as a list and "For you:" as a small heading. */
function Formatted({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>);
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-•*]\s+/.test(line)) {
      items.push(line.replace(/^[-•*]\s+/, ""));
      continue;
    }
    flush();
    if (/^[^.]{1,30}:$/.test(line)) blocks.push(<h5 key={blocks.length}>{line.slice(0, -1)}</h5>);
    else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="ask-answer ask-rich">{blocks}</div>;
}

/** Wording that changes with what the assistant is looking at. */
const PLACEHOLDER = {
  email: "Tell AI what to do with this email, or ask about it…",
  inbox: "Ask about your email, or tell AI what to do…",
};

/**
 * The AI assistant. It works on one of two things:
 *  - The open email: summarize it, draft a reply, answer its invitations, or answer questions about it.
 *  - Your whole inbox: answer questions from your mail with sources, or act on many conversations
 *    ("archive the shipping notices", "accept these invites").
 * With an email open, Claude decides from the request which one you mean, and asks when it can't tell.
 * Nothing that changes or sends mail happens without a confirming click (a reply opens in the
 * composer instead).
 */
export function AskPanel() {
  const open = useStore((s) => s.askOpen);
  const aiOn = useStore((s) => !!s.settings?.aiEnabled);
  const me = useStore((s) => s.info?.email ?? "");
  const { mounted, closing } = usePresence(open);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CommandResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Focused on one email: a back-and-forth about it, and what to do with it.
  const focus = useStore((s) => s.askThread);
  // A request about the whole inbox, made with an email open (Claude decided, or you answered its question).
  const [inbox, setInbox] = useState(false);
  const scoped = inbox ? null : focus;
  // A request Claude couldn't place: this email or the whole inbox? Kept with the chat from before it.
  const [unsure, setUnsure] = useState<{ text: string; before: AskTurn[] } | null>(null);
  const [chat, setChat] = useState<AskTurn[]>([]);
  const [act, setAct] = useState<CommandResult | null>(null);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  // Esc closes it from anywhere in it, not only from the text box (which AI being off disables).
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Each request gets a number; an answer that arrives after you've moved on is dropped.
  const seq = useRef(0);
  const summarize = async () => {
    if (!focus) return;
    const mine = ++seq.current;
    setChat([]);
    setAct(null);
    setBusy(true);
    setErr(null);
    try {
      const answer = await api.askThread(focus.threadId, []);
      if (seq.current === mine) setChat([{ role: "assistant", text: answer }]);
    } catch (e) {
      if (seq.current === mine) setErr(errText(e));
    } finally {
      if (seq.current === mine) setBusy(false);
    }
  };

  // A newly focused email: clear the conversation, find its unanswered invitations, and summarize
  // it straight away only when that's what was asked for (an email dropped on the button).
  useEffect(() => {
    seq.current++;
    setBusy(false);
    setChat([]);
    setAct(null);
    setErr(null);
    setPending([]);
    setInbox(false);
    setUnsure(null);
    setRes(null);
    if (!open || !focus || !aiOn) return;
    let live = true;
    void api
      .getThread(focus.threadId, "INBOX")
      .then((t) => pendingInvites(t, me))
      .then((p) => live && setPending(p))
      .catch(() => {});
    if (focus.summarize) void summarize();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.threadId, open]);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: scrollBehavior() });
  }, [chat.length, busy, act]);

  if (!mounted) return null;
  const close = () => useStore.setState({ askOpen: false, askThread: null });

  /** Something typed while focused on an email: a reply, its invitations, a question, or something for the whole inbox. */
  const tell = async (text: string, opts: { thisEmailOnly?: boolean; before?: AskTurn[] } = {}) => {
    if (!focus) return;
    const mine = ++seq.current;
    const prior = opts.before ?? chat;
    const history = [...prior, { role: "user" as const, text }];
    setQ("");
    setChat(history);
    setUnsure(null);
    setAct(null);
    setBusy(true);
    setErr(null);
    try {
      const t = await api.getThread(focus.threadId, "INBOX");
      const invites = await pendingInvites(t, me);
      // Recent turns give follow-ups their context ("make it shorter", "and the second one?").
      const earlier = prior
        .slice(-4)
        .map((c) => `${c.role === "user" ? "User" : "You"}: ${c.text}`)
        .join("\n");
      const plan = await api.aiAssist(
        focus.threadId,
        earlier ? `Earlier in this chat:\n${earlier}\n\nNow: ${text}` : text,
        invites.map((p) => `- ${p.inv.summary}, ${whenText(p.inv)}`).join("\n"),
        !!opts.thisEmailOnly,
      );
      if (seq.current !== mine) return;
      if (plan.action === "inbox") {
        setChat(prior);
        setBusy(false);
        void askInbox(text);
        return;
      }
      if (plan.action === "clarify") {
        setUnsure({ text, before: prior });
        return;
      }
      if (plan.action === "reply") {
        // Answer the latest message from someone else, not your own last reply (or an RSVP).
        const to = [...t.messages].reverse().find((m) => !m.isDraft && !sameAddr(m.from, me));
        close();
        void A.respond(plan.replyAll ? "replyAll" : "reply", to?.id, focus.threadId, plan.text);
        return;
      }
      if (plan.action === "rsvp") {
        if (!invites.length) {
          setChat([...history, { role: "assistant", text: "There are no invitations in this email waiting for an answer." }]);
        } else {
          setAct(rsvpFor(focus, plan.response));
        }
        return;
      }
      setChat([...history, { role: "assistant", text: plan.text }]);
    } catch (e) {
      if (seq.current === mine) setErr(errText(e));
    } finally {
      if (seq.current === mine) setBusy(false);
    }
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    if (scoped) return void tell(text);
    await askInbox(text);
  };

  /** A question or command over all your mail. */
  const askInbox = async (text: string) => {
    setInbox(true);
    setUnsure(null);
    setQ(text);
    setAsked(text);
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await api.aiCommand(text));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const openThread = (threadId: string) => {
    const st = useStore.getState();
    if (st.folder !== "INBOX" || st.search) st.setFolder("INBOX");
    st.select(threadId);
    close();
  };
  const openN = (n: number) => {
    const s = res?.answer?.sources.find((x) => x.n === n);
    if (s) openThread(s.threadId);
  };

  return createPortal(
    <>
      <div className={cx("scrim", closing && "closing")} onClick={close} />
      <div ref={dialogRef} className={cx("modal ask", closing && "closing")} role="dialog" aria-modal="true" aria-label="AI assistant">
        <form
          className="ask-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <Sparkles size={17} className="ask-spark" />
          <input
            ref={input}
            value={q}
            placeholder={scoped ? PLACEHOLDER.email : PLACEHOLDER.inbox}
            disabled={!aiOn}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
          />
          {busy ? (
            <Loader2 size={16} className="spin faint" />
          ) : (
            <button type="submit" className="icon-btn sm" disabled={!q.trim() || !aiOn} aria-label="Go">
              <ArrowRight size={16} />
            </button>
          )}
          <button type="button" className="icon-btn sm" onClick={close} aria-label="Close" title="Close (Esc)">
            <X size={15} />
          </button>
        </form>

        <div className="ask-body" ref={body}>
          {!aiOn ? (
            <div className="ask-empty">
              <p>The AI assistant uses Claude. Turn on AI in Settings to use it.</p>
              <button className="btn primary" onClick={() => useStore.setState({ askOpen: false, settingsOpen: true })}>
                Open Settings
              </button>
            </div>
          ) : scoped ? (
            <>
              {chat.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="ask-q">
                    {t.text}
                  </div>
                ) : (
                  <Formatted key={i} text={t.text} />
                ),
              )}
              {busy && (
                <div className="ask-empty faint ask-thinking">
                  <Loader2 size={14} className="spin" /> {chat.length ? "Working on it…" : "Reading the email and its attachments…"}
                </div>
              )}
              {err && <div className="ask-empty error">{err}</div>}
              {act && <AskAction key={act.response} r={act} onOpen={openThread} />}
              {unsure && !busy && (
                <div className="ask-examples">
                  <p className="ask-answer">Do you mean this email, or your whole inbox?</p>
                  <div className="ask-chips">
                    <button className="ask-example" onClick={() => void tell(unsure.text, { thisEmailOnly: true, before: unsure.before })}>
                      <Mail size={13} /> This email
                    </button>
                    <button
                      className="ask-example"
                      onClick={() => {
                        setChat(unsure.before);
                        void askInbox(unsure.text);
                      }}
                    >
                      <Inbox size={13} /> Whole inbox
                    </button>
                  </div>
                </div>
              )}
              {!busy && !act && !unsure && (
                <div className="ask-examples">
                  {!chat.length && <div className="menu-label">With this email</div>}
                  <div className="ask-chips">
                    {!chat.length && (
                      <button className="ask-example" onClick={() => void summarize()}>
                        <FileText size={13} /> Summarize it
                      </button>
                    )}
                    <button className="ask-example" onClick={() => void tell("Write a reply to the latest message.")}>
                      <PenLine size={13} /> Draft a reply
                    </button>
                    {pending.length > 0 && (
                      <button className="ask-example" onClick={() => setAct(rsvpFor(scoped, "yes"))}>
                        <CalendarCheck size={13} /> Accept {pending.length > 1 ? `all ${pending.length} invitations` : "the invitation"}
                      </button>
                    )}
                    <button className="ask-example" onClick={() => openThread(scoped.threadId)}>
                      <Mail size={13} /> Open it
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : busy ? (
            <div className="ask-empty faint ask-thinking">
              <Loader2 size={14} className="spin" /> Working on “{asked}”…
            </div>
          ) : err ? (
            <div className="ask-empty error">{err}</div>
          ) : res && res.kind === "act" ? (
            <AskAction key={asked} r={res} onOpen={openThread} />
          ) : res && res.kind === "unsupported" ? (
            <p className="ask-answer">{res.summary}</p>
          ) : res?.answer ? (
            <>
              <Cited text={res.answer.answer} onOpen={openN} />
              {res.answer.sources.length > 0 && (
                <div className="ask-sources">
                  <div className="menu-label">From your email</div>
                  {res.answer.sources.map((s) => (
                    <button key={s.threadId} className="ask-source" onClick={() => openThread(s.threadId)}>
                      <span className="ask-n">{s.n}</span>
                      <span className="ask-src-text">
                        <b>{s.subject || "(no subject)"}</b>
                        <small>
                          {s.from} · {shortDate(s.date)}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="ask-examples">
              <div className="menu-label">Ask a question</div>
              {QUESTIONS.map((x) => (
                <button key={x} className="ask-example" onClick={() => void ask(x)}>
                  {x}
                </button>
              ))}
              <div className="menu-label">Or tell it what to do</div>
              {COMMANDS.map((x) => (
                <button key={x} className="ask-example" onClick={() => setQ(x)} title="Puts this in the box to edit first">
                  {x}
                </button>
              ))}
              <p className="faint ask-note">
                Post searches the mail on this computer. Claude answers from what it finds, or shows what it will
                change (archive, delete, mark read, star, pin, snooze, answer invitations) and waits for you to
                confirm. Each request costs about a cent.
              </p>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Answering one email's invitations, in the same form as an inbox-wide RSVP (see AskAction). */
function rsvpFor(focus: { threadId: string; subject: string }, response: "yes" | "maybe" | "no"): CommandResult {
  return {
    kind: "act",
    answer: null,
    action: "rsvp",
    response,
    until: "",
    summary: "",
    threads: [{ n: 1, threadId: focus.threadId, subject: focus.subject, from: "", date: 0 }],
  };
}
