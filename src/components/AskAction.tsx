import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, errText, type CommandResult } from "../api";
import { useStore } from "../store";
import * as A from "../actions";
import { invitations, pendingInvites, RSVP_DOING, RSVP_DONE, RSVP_VERB, type PendingInvite } from "../invites";
import { shortDate, whenLabel } from "../util";
import { whenText } from "./Invite";

const S = () => useStore.getState();
const convos = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;

/** The button's words for an action on n conversations. */
function verb(r: CommandResult, n: number, until: number | null): string {
  switch (r.action) {
    case "archive":
      return `Archive ${n}`;
    case "delete":
      return `Delete ${n}`;
    case "read":
      return `Mark ${n} as read`;
    case "unread":
      return `Mark ${n} as unread`;
    case "star":
      return `Star ${n}`;
    case "unstar":
      return `Unstar ${n}`;
    case "pin":
      return `Pin ${n} to Home`;
    case "unpin":
      return `Unpin ${n}`;
    case "snooze":
      return until ? `Snooze ${n} until ${whenLabel(until)}` : `Snooze ${n}`;
    default:
      return "";
  }
}

/** Carry out a confirmed action on these conversations, with Undo where it can be undone. */
async function apply(r: CommandResult, ids: string[], until: number | null): Promise<string> {
  const undo = (text: string, run: () => Promise<unknown>) =>
    S().snack({ text, action: { label: "Undo", run: () => void run().then(() => S().loadThreads()) } });
  switch (r.action) {
    case "archive":
      await A.archive(ids);
      return `Archived ${convos(ids.length)}.`;
    case "delete":
      S().removeLocally(ids);
      await api.trash(ids);
      undo(`${convos(ids.length)} moved to Trash`, () => api.untrash(ids));
      return `Moved ${convos(ids.length)} to Trash.`;
    case "read":
    case "unread":
      await A.markRead(r.action === "read", ids);
      return `Marked ${convos(ids.length)} as ${r.action}.`;
    case "star":
    case "unstar": {
      const on = r.action === "star";
      await api.labelThreads(ids, on ? ["STARRED"] : [], on ? [] : ["STARRED"]);
      undo(`${on ? "Starred" : "Unstarred"} ${convos(ids.length)}`, () => api.labelThreads(ids, on ? [] : ["STARRED"], on ? ["STARRED"] : []));
      return `${on ? "Starred" : "Removed the star from"} ${convos(ids.length)}.`;
    }
    case "pin":
    case "unpin": {
      const on = r.action === "pin";
      for (const id of ids) await api.pinThread(id, on);
      window.dispatchEvent(new Event("post:home-refresh"));
      undo(`${on ? "Pinned" : "Unpinned"} ${convos(ids.length)}`, async () => {
        for (const id of ids) await api.pinThread(id, !on);
        window.dispatchEvent(new Event("post:home-refresh"));
      });
      return `${on ? "Pinned" : "Unpinned"} ${convos(ids.length)}.`;
    }
    case "snooze":
      if (!until) throw new Error("That time didn't make sense. Try saying when, like “until Monday morning”.");
      await A.snooze(ids, until);
      return `Snoozed ${convos(ids.length)} until ${whenLabel(until)}.`;
  }
  return "";
}

/**
 * What the assistant is about to do, waiting for a go-ahead: the conversations (or, for RSVPs,
 * the invitations in them) with a checkbox each, so anything picked by mistake can be left out.
 */
export function AskAction({ r, onOpen }: { r: CommandResult; onOpen: (threadId: string) => void }) {
  const me = useStore((s) => s.info?.email ?? "");
  const [on, setOn] = useState<Set<string>>(() => new Set(r.threads.map((t) => t.threadId)));
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rsvp = r.action === "rsvp";
  const response = r.response === "no" || r.response === "maybe" ? r.response : "yes";
  const until = r.until ? new Date(r.until).getTime() : null;
  const badTime = r.action === "snooze" && (!until || Number.isNaN(until) || until < Date.now());

  // For RSVPs, the unanswered invitations across the chosen conversations.
  useEffect(() => {
    if (!rsvp) return;
    let live = true;
    void (async () => {
      const all: PendingInvite[] = [];
      for (const t of r.threads) {
        try {
          all.push(...(await pendingInvites(await api.getThread(t.threadId, "INBOX"), me)));
        } catch {
          /* a conversation that can't be read is skipped */
        }
      }
      // The same event can turn up in more than one conversation: answer it once (latest copy).
      const byEvent = new Map<string, PendingInvite>();
      for (const p of all) byEvent.set(p.inv.uid || p.m.id, p);
      const list = [...byEvent.values()].sort((a, b) => (a.inv.start?.getTime() ?? 0) - (b.inv.start?.getTime() ?? 0));
      if (!live) return;
      setInvites(list);
      setOn(new Set(list.map((p) => p.m.id)));
    })();
    return () => {
      live = false;
    };
  }, [r, rsvp, me]);

  const toggle = (id: string) =>
    setOn((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const go = async () => {
    setErr(null);
    try {
      if (rsvp) {
        const list = (invites ?? []).filter((p) => on.has(p.m.id));
        let failed = 0;
        for (let i = 0; i < list.length; i++) {
          setBusy(`${RSVP_DOING[response]} ${i + 1} of ${list.length}…`);
          await api.rsvp(list[i].m.id, list[i].ics, response).catch(() => failed++);
        }
        const ok = list.length - failed;
        setDone(`${RSVP_DONE[response]} ${invitations(ok)}.${failed ? ` ${invitations(failed)} couldn't be sent; try again in a moment.` : ""}`);
      } else {
        setBusy("Working on it…");
        const ids = r.threads.map((t) => t.threadId).filter((id) => on.has(id));
        setDone(await apply(r, ids, until));
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!r.threads.length) return <p className="ask-answer">{r.summary}</p>;

  const count = on.size;
  const label = rsvp ? `${RSVP_VERB[response]} ${invitations(count)}` : verb(r, count, until);

  return (
    <div className="ask-act">
      {rsvp ? (
        invites &&
        invites.length > 0 && (
          <p className="ask-answer">
            {invites.length === 1 ? "1 invitation" : `${invites.length} invitations`} you haven't answered, from{" "}
            {convos(new Set(invites.map((p) => p.m.threadId)).size)}.
          </p>
        )
      ) : (
        r.summary && <p className="ask-answer">{r.summary}</p>
      )}
      {rsvp && !invites && (
        <div className="ask-empty faint ask-thinking">
          <Loader2 size={14} className="spin" /> Finding the invitations you haven't answered…
        </div>
      )}
      {rsvp && invites && !invites.length && <p className="ask-answer">Every invitation in these conversations is already answered (or over).</p>}
      <div className="ask-sources">
        {rsvp
          ? invites?.map((p) => (
              <label key={p.m.id} className="ask-pick">
                <input type="checkbox" checked={on.has(p.m.id)} onChange={() => toggle(p.m.id)} disabled={!!busy || !!done} />
                <span className="ask-src-text">
                  <b>{p.inv.summary}</b>
                  <small>{whenText(p.inv)}</small>
                </span>
              </label>
            ))
          : r.threads.map((t) => (
              <div key={t.threadId} className="ask-pick">
                {r.action !== "show" && (
                  <input
                    type="checkbox"
                    checked={on.has(t.threadId)}
                    onChange={() => toggle(t.threadId)}
                    disabled={!!busy || !!done}
                    aria-label={`Include ${t.subject || "(no subject)"}`}
                  />
                )}
                <button className="ask-src-text" onClick={() => onOpen(t.threadId)} title="Open this email">
                  <b>{t.subject || "(no subject)"}</b>
                  <small>
                    {t.from} · {shortDate(t.date)}
                  </small>
                </button>
              </div>
            ))}
      </div>
      {r.action !== "show" && (
        <div className="ask-act-bar">
          {done ? (
            <span className="ask-done">{done}</span>
          ) : busy ? (
            <span className="faint ask-thinking">
              <Loader2 size={14} className="spin" /> {busy}
            </span>
          ) : (
            <>
              {err && <span className="error">{err}</span>}
              {badTime && <span className="error">That time is in the past or unclear. Try saying when again.</span>}
              <button className="btn primary" disabled={!count || badTime || (rsvp && !invites)} onClick={() => void go()}>
                {label}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
