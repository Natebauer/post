import { useEffect, useState } from "react";
import type React from "react";
import { Check, HelpCircle, MapPin, X } from "lucide-react";
import { api, errText, type Message } from "../api";
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
      className="invite"
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
        {canRsvp && (
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
