import { useEffect, useState } from "react";
import type React from "react";
import { CalendarPlus, Check, HelpCircle, MapPin, Sparkles, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errText, type EventIdea, type Message } from "../api";
import { useStore } from "../store";
import { cx } from "../util";
import { calendarColorFor } from "./Calendar";

export interface Invite {
  uid: string;
  summary: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  location: string;
  organizer: string;
  method: string;
}

function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const line of ics.split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function unescape(v: string) {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseDate(line: string): { d: Date | null; allDay: boolean } {
  const v = line.slice(line.lastIndexOf(":") + 1).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { d: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { d: new Date(+y, +mo - 1, +d), allDay: true };
  // UTC when suffixed with Z; otherwise treat as local time (TZID is usually the user's zone).
  const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { d: date, allDay: false };
}

export function parseInvite(ics: string): Invite | null {
  const lines = unfold(ics);
  const method = lines.find((l) => l.startsWith("METHOD:"))?.slice(7).trim() ?? "";
  const start = lines.findIndex((l) => l.trim() === "BEGIN:VEVENT");
  if (start < 0) return null;
  const ev = lines.slice(start + 1, lines.findIndex((l, i) => i > start && l.trim() === "END:VEVENT"));
  const get = (k: string) => ev.find((l) => l.split(/[:;]/)[0].toUpperCase() === k);
  const val = (k: string) => {
    const l = get(k);
    return l ? unescape(l.slice(l.indexOf(":") + 1)) : "";
  };
  const s = get("DTSTART") ? parseDate(get("DTSTART")!) : { d: null, allDay: false };
  const e = get("DTEND") ? parseDate(get("DTEND")!) : { d: null, allDay: false };
  const org = get("ORGANIZER") ?? "";
  const cn = org.match(/CN="?([^";:]+)"?/i)?.[1];
  const orgMail = org.slice(org.toLowerCase().lastIndexOf("mailto:") + 7);
  return {
    uid: val("UID"),
    summary: val("SUMMARY") || "(untitled event)",
    start: s.d,
    end: e.d,
    allDay: s.allDay,
    location: val("LOCATION"),
    organizer: cn || orgMail,
    method,
  };
}

export function whenText(inv: Invite) {
  if (!inv.start) return "";
  const day = inv.start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (inv.allDay) return `${day} · All day`;
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${t(inv.start)}${inv.end ? ` – ${t(inv.end)}` : ""}`;
}

export function InviteCard({ m }: { m: Message }) {
  const icsAtt = m.attachments.find((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename));
  const [ics, setIcs] = useState<string | null>(m.ics);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!m.ics && icsAtt) void fetch(icsAtt.url).then((r) => r.text()).then(setIcs).catch(() => {});
    void api.rsvpStatus([m.id]).then((r) => setAnswer(r[m.id] ?? null)).catch(() => {});
  }, [m.id, m.ics, icsAtt]);

  if (!ics) return null;
  const inv = parseInvite(ics);
  if (!inv) return null;
  const canRsvp = inv.method.toUpperCase() === "REQUEST" && !m.isDraft;
  // Over already: no point asking whether you're going.
  const ends = inv.end ?? inv.start;
  const over = !!ends && ends.getTime() < Date.now();

  const respond = async (r: "yes" | "maybe" | "no") => {
    setBusy(true);
    try {
      await api.rsvp(m.id, ics, r);
      setAnswer(r);
      useStore.getState().snack({ text: `RSVP sent: ${r === "yes" ? "Going" : r === "maybe" ? "Maybe" : "Not going"}` });
    } catch (e) {
      useStore.getState().snack({ text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cx("invite", over && "past")}
      role="group"
      aria-label={`Invitation: ${inv.summary}`}
      style={{ "--cal": calendarColorFor(inv.summary, inv.start) ?? undefined } as React.CSSProperties}
    >
      <div className="cal" aria-hidden>
        <div className="m">{inv.start?.toLocaleDateString(undefined, { month: "short" }) ?? ""}</div>
        <div className="d">{inv.start?.getDate() ?? "?"}</div>
      </div>
      <div>
        <h4>{inv.summary}</h4>
        <div className="when">{whenText(inv)}</div>
        {inv.location && (
          <div className="when" style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
            <MapPin size={12} /> {inv.location}
          </div>
        )}
        {inv.organizer && <div className="when faint">Organized by {inv.organizer}</div>}
        {canRsvp && over && (
          <div className="rsvp faint">
            This has already happened{answer ? ` · you said ${answer === "yes" ? "yes" : answer === "maybe" ? "maybe" : "no"}` : ""}
          </div>
        )}
        {canRsvp && !over && (
          <div className="rsvp">
            <span className="faint" style={{ fontSize: 12, marginRight: 4 }}>
              Going?
            </span>
            <button className={cx("btn outline", answer === "yes" && "on")} disabled={busy} onClick={() => void respond("yes")}>
              <Check size={14} /> Yes
            </button>
            <button className={cx("btn outline", answer === "maybe" && "on")} disabled={busy} onClick={() => void respond("maybe")}>
              <HelpCircle size={14} /> Maybe
            </button>
            <button className={cx("btn outline", answer === "no" && "on")} disabled={busy} onClick={() => void respond("no")}>
              <X size={14} /> No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- an event an email mentions (no invite attached) ---------- */

const EVENT_SEEN_KEY = "post.eventSeen";
/** Suggestions you've added (with the event's link) or waved away, by message (newest last, a
 *  few hundred kept). An entry of just "added" is from before Post added events itself. */
function eventSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(EVENT_SEEN_KEY) || "{}");
  } catch {
    return {};
  }
}
function markEvent(id: string, how: string) {
  try {
    const all = eventSeen();
    delete all[id];
    all[id] = how;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - 300))) delete all[old];
    localStorage.setItem(EVENT_SEEN_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the choice lasts until the email closes */
  }
}

/** "2026-11-03T10:00:00-08:00" (an instant), "2026-11-03T10:00:00" (local time) or "2026-11-03" (a day). */
function eventDate(s: string): Date | null {
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = day ? new Date(+day[1], +day[2] - 1, +day[3]) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const gcalStamp = (d: Date, allDay: boolean) =>
  allDay
    ? `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
    : d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** When an event ends: as the email says, else an hour on (or the next day, for an all-day one). */
const endOf = (inv: Invite) =>
  inv.end ?? (inv.allDay ? new Date(inv.start!.getFullYear(), inv.start!.getMonth(), inv.start!.getDate() + 1) : new Date(inv.start!.getTime() + 3_600_000));
const eventNotes = (link: string, subject: string) => [link, `From the email “${subject}”`].filter(Boolean).join("\n\n");

/** Google Calendar's "new event" page, filled in, for you to look over and save (when Post can't add it itself). */
function gcalLink(inv: Invite, link: string, subject: string) {
  const start = inv.start!;
  const end = endOf(inv);
  const details = eventNotes(link, subject);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: inv.summary,
    dates: `${gcalStamp(start, inv.allDay)}/${gcalStamp(end, inv.allDay)}`,
    details,
    location: inv.location || link,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/**
 * An email that confirms an appointment, booking or webinar but has no calendar invite: Post asks
 * Claude whether it names one (once per email, and only when it mentions a date and a time), and
 * offers to add it to your calendar.
 */
export function EventSuggestion({ m, me }: { m: Message; me: string }) {
  const aiOn = useStore((s) => s.settings?.aiEnabled ?? false);
  const [idea, setIdea] = useState<EventIdea | null>(null);
  const [seen, setSeen] = useState(() => eventSeen()[m.id] ?? null);
  const [adding, setAdding] = useState(false);
  // Post can't add events yet (no permission, or Google said no): how to go on.
  const [blocked, setBlocked] = useState<"permission" | "error" | null>(null);
  // Recent mail only: an old email's event is over, and isn't worth asking about.
  const eligible =
    aiOn && !m.ics && !m.isDraft && m.from.email.toLowerCase() !== me.toLowerCase() && Date.now() - m.date < 45 * 86_400_000 &&
    !m.attachments.some((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename));

  useEffect(() => {
    if (!eligible || seen === "dismissed") return;
    let live = true;
    const text = m.text.trim() || new DOMParser().parseFromString(m.html ?? "", "text/html").body.textContent || "";
    api
      .findEvent(m.id, m.subject, m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email, m.date, text.replace(/\s+/g, " "))
      .then((r) => live && setIdea(r))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, eligible]);

  if (!idea || seen === "dismissed") return null;
  const start = eventDate(idea.start);
  if (!start) return null;
  const inv: Invite = {
    uid: "",
    summary: idea.title,
    start,
    end: idea.end ? eventDate(idea.end) : null,
    allDay: idea.allDay,
    location: idea.location,
    organizer: "",
    method: "",
  };
  // Already over: nothing to add.
  if ((inv.end ?? start).getTime() < Date.now() - (idea.allDay ? 86_400_000 : 0)) return null;

  // Straight onto your Google Calendar; the first time, Google asks you to allow it.
  const add = async () => {
    setAdding(true);
    setBlocked(null);
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const at = (d: Date) => (inv.allDay ? day(d) : d.toISOString());
    try {
      const r = await api.addCalendarEvent(inv.summary, at(start), at(endOf(inv)), inv.allDay, inv.location || idea.link, eventNotes(idea.link, m.subject));
      if (r.status === "ok") {
        markEvent(m.id, `added:${r.link}`);
        setSeen(`added:${r.link}`);
        useStore.getState().snack({ text: "Added to your calendar" });
      } else {
        setBlocked(r.status === "needs_permission" ? "permission" : "error");
        if (r.status === "error") useStore.getState().snack({ text: r.message });
      }
    } catch (e) {
      setBlocked("error");
      useStore.getState().snack({ text: errText(e) });
    } finally {
      setAdding(false);
    }
  };
  const allow = async () => {
    setAdding(true);
    try {
      await api.signIn();
      await add();
    } catch (e) {
      setAdding(false);
      useStore.getState().snack({ text: errText(e) });
    }
  };
  const openInGoogle = () => void openUrl(gcalLink(inv, idea.link, m.subject));
  const added = seen?.startsWith("added") ? seen.slice(6) || null : null;
  const dismiss = () => {
    markEvent(m.id, "dismissed");
    setSeen("dismissed");
  };

  return (
    <div
      className="invite event-idea"
      role="group"
      aria-label={`Event in this email: ${inv.summary}`}
      style={{ "--cal": calendarColorFor(inv.summary, inv.start) ?? undefined } as React.CSSProperties}
    >
      <div className="cal" aria-hidden>
        <div className="m">{start.toLocaleDateString(undefined, { month: "short" })}</div>
        <div className="d">{start.getDate()}</div>
      </div>
      <div>
        <div className="event-idea-kicker">
          <Sparkles size={12} aria-hidden /> Looks like an event
        </div>
        <h4>{inv.summary}</h4>
        <div className="when">{whenText(inv)}</div>
        {inv.location && (
          <div className="when" style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
            <MapPin size={12} /> {inv.location}
          </div>
        )}
        <div className="rsvp">
          {seen?.startsWith("added") ? (
            <span className="faint event-idea-done">
              <Check size={14} /> {added === null ? "Opened in Google Calendar to save" : "Added to your calendar"}
              {added && (
                <button className="link-btn" onClick={() => void openUrl(added)}>
                  Open
                </button>
              )}
            </span>
          ) : blocked === "permission" ? (
            <>
              <span className="faint event-idea-note">Post needs your OK to add events to Google Calendar. You'll approve it once in your browser.</span>
              <button className="btn primary" disabled={adding} onClick={() => void allow()}>
                <CalendarPlus size={14} /> {adding ? "Waiting for your browser…" : "Allow and add"}
              </button>
            </>
          ) : (
            <>
              <button className="btn outline" disabled={adding} onClick={() => void add()}>
                <CalendarPlus size={14} /> {adding ? "Adding…" : "Add to calendar"}
              </button>
              {blocked === "error" && (
                <button className="link-btn" onClick={openInGoogle}>
                  Open in Google Calendar instead
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <button className="icon-btn sm event-idea-x" title="Not an event" aria-label="Dismiss this suggestion" onClick={dismiss}>
        <X size={14} />
      </button>
    </div>
  );
}
