/**
 * The Home calendar: a week (yesterday through the next five days) or a whole month, read from
 * Google Calendar, with the morph between the two views and the hover controls.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { flushSync } from "react-dom";
import {
  ArrowUpRight,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  Loader2,
  MapPin,
  Video,
} from "lucide-react";
import { api, errText, type CalEvent, type CalendarResult } from "../api";
import { useStore } from "../store";
import { cx } from "../util";
import { motionEase, motionMs, reduceMotion } from "../motionTokens";
import { Empty } from "./HomeBits";

/** Survives leaving and returning to Home. */
const calCache: { cal: CalendarResult | null; at: number } = { cal: null, at: 0 };
const CAL_FRESH_MS = 5 * 60_000;

export const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** All-day events use plain dates ("2026-10-14"), which must be read as local, not UTC. */
function parseEventDate(s: string, allDay: boolean) {
  if (allDay) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(s);
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/* ---------------- calendar: 7-day week view ---------------- */

// One shared loader so the refresh button and the module stay in sync.
const calListeners = new Set<(c: CalendarResult) => void>();
function fetchCalendar(force: boolean) {
  if (!force && calCache.cal && Date.now() - calCache.at < CAL_FRESH_MS) return;
  void api
    .calendarUpcoming()
    .then((c) => {
      calCache.cal = c;
      calCache.at = Date.now();
      calListeners.forEach((f) => f(c));
    })
    .catch(() => {});
}

/**
 * The color an invite's date block should wear: the matching event's calendar color when the
 * event is already on your calendar, otherwise the color most of your events use.
 */
export function calendarColorFor(summary?: string, start?: Date | null): string | null {
  const events = calCache.cal?.events ?? [];
  const name = summary?.trim().toLowerCase();
  const match = events.find(
    (e) => (name && e.title.trim().toLowerCase() === name) || (start && new Date(e.start).getTime() === start.getTime()),
  );
  if (match?.color) return match.color;
  const counts = new Map<string, number>();
  for (const e of events) if (e.color) counts.set(e.color, (counts.get(e.color) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function useCalendar() {
  // Show what we already have immediately; refresh quietly when it's stale.
  const [cal, setCal] = useState<CalendarResult | null>(calCache.cal);
  useEffect(() => {
    calListeners.add(setCal);
    fetchCalendar(false);
    const t = window.setInterval(() => fetchCalendar(true), 10 * 60_000);
    const onFocus = () => fetchCalendar(false);
    window.addEventListener("focus", onFocus);
    return () => {
      calListeners.delete(setCal);
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return { cal, reload: () => fetchCalendar(true) };
}

export function CalendarBody() {
  const { cal, reload } = useCalendar();
  const month = useStore((s) => s.calMonth);
  const glide = useHeightGlide(month ? "month" : "week", cal?.status === "ok");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.signIn();
      reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  let body: ReactNode;
  if (!cal) body = <Empty>Loading your calendar…</Empty>;
  else if (cal.status === "needs_permission")
    body = (
      <div className="hsetup">
        <p>Post needs permission to read your Google Calendar. You'll sign in once more and approve calendar access.</p>
        <button className="btn primary" disabled={busy} onClick={() => void connect()}>
          {busy ? "Waiting for your browser…" : "Connect calendar"}
        </button>
      </div>
    );
  else if (cal.status === "api_disabled")
    body = (
      <div className="hsetup">
        <p>Turn on the Google Calendar API in your Cloud project, then come back and press Check again.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => cal.enableUrl && void openUrl(cal.enableUrl)}>
            <ExternalLink size={14} /> Enable Calendar API
          </button>
          <button className="btn outline" onClick={reload}>
            Check again
          </button>
        </div>
      </div>
    );
  else if (cal.status === "error") body = <Empty>Couldn't load your calendar: {cal.message}</Empty>;
  else
    body = (
      <div className="cal-swap" ref={glide}>
        <div key={month ? "month" : "week"} className="cal-view">
          {month ? <MonthView /> : <WeekView events={cal.events} />}
        </div>
      </div>
    );
  return (
    <>
      {body}
      {err && <p className="error" style={{ margin: "8px 0 0" }}>{err}</p>}
    </>
  );
}

/* ---------------- calendar: yesterday through the next five days ---------------- */

const MAX_PER_DAY = 4;

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());
/** The meeting to join: the event's video link, or a link used as its location. */
const meetingOf = (e: CalEvent) => e.meeting || (isUrl(e.location) ? e.location.trim() : "");
function meetingName(url: string) {
  if (/zoom\.us/i.test(url)) return "Zoom";
  if (/meet\.google/i.test(url)) return "Meet";
  if (/teams\.(microsoft|live)/i.test(url)) return "Teams";
  if (/webex/i.test(url)) return "Webex";
  return "meeting";
}
/** Clicking an event joins its meeting when it has one; otherwise it opens in Google Calendar. */
function openEvent(e: CalEvent) {
  const m = meetingOf(e);
  const target = m || e.link;
  if (target) void openUrl(target);
}
const GOOGLE_CALENDAR = "https://calendar.google.com/calendar/r";
/** "2:00 – 3:00 PM", or "11:30 AM – 12:15 PM" when it crosses noon. */
function timeRange(s: Date, e: Date) {
  const f = (d: Date, ampm: boolean) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).replace(ampm ? "" : /\s?[AP]M$/i, "");
  const sameHalf = s.getHours() < 12 === e.getHours() < 12;
  return `${f(s, !sameHalf)} – ${f(e, true)}`;
}

/** Calendars present this week, for the header legend. */
function calendarsIn(events: CalEvent[]) {
  const seen = new Map<string, string>();
  for (const e of events) if (e.calendar && !seen.has(e.calendar)) seen.set(e.calendar, e.color);
  return [...seen.entries()].map(([name, color]) => ({ name, color }));
}

function WeekView({ events }: { events: CalEvent[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = useNow();
  // Yesterday first (what you did), then today and the five days after it.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const TODAY = 1;
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events) {
    const s = parseEventDate(e.start, e.allDay);
    const en = parseEventDate(e.end, e.allDay);
    for (const d of days) {
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      if (s < next && en > d) byDay.set(dayKey(d), [...(byDay.get(dayKey(d)) ?? []), e]);
    }
  }

  return (
    <div className="cw" role="grid" aria-label="This week">
      {days.map((d, i) => {
        const all = byDay.get(dayKey(d)) ?? [];
        const allDay = all.filter((e) => e.allDay);
        const timed = all
          .filter((e) => !e.allDay)
          .sort((a, b) => +parseEventDate(a.start, false) - +parseEventDate(b.start, false));
        const weekend = d.getDay() === 0 || d.getDay() === 6;
        const expanded = open.has(dayKey(d));
        const shown = expanded ? timed : timed.slice(0, MAX_PER_DAY);
        const hiddenCount = timed.length - shown.length;
        // Where the "now" line goes in today's column: before the first event that hasn't started.
        const nowAt = i === TODAY ? shown.findIndex((e) => parseEventDate(e.start, false) > now) : -1;
        const label =
          i === 0 ? "Yesterday" : i === TODAY ? "Today" : i === 2 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" });
        return (
          <div key={i} className={cx("cw-day", i === TODAY && "today", i < TODAY && "before", weekend && "weekend")} role="gridcell">
            <div className="cw-head">
              <span className="cw-name">{label}</span>
              <span className="cw-num tnum">{d.getDate()}</span>

            </div>
            {allDay.length > 0 && (
              <div className="cw-allday">
                {allDay.map((e) => (
                  <button
                    key={e.id + i}
                    className="cw-pill"
                    style={e.color ? ({ "--cal": e.color } as React.CSSProperties) : undefined}
                    onClick={() => e.link && void openUrl(e.link)}
                    title={`${e.title} · all day\n${e.calendar}\nOpen in Google Calendar`}
                  >
                    {e.title}
                  </button>
                ))}
              </div>
            )}
            <div className="cw-list">
              {shown.map((e, k) => {
                const s = parseEventDate(e.start, false);
                const en = parseEventDate(e.end, false);
                const past = en <= now;
                const live = s <= now && now < en;
                const clash = timed.some(
                  (o) => o !== e && parseEventDate(o.start, false) < en && parseEventDate(o.end, false) > s,
                );
                return (
                  <Fragment key={e.id + i}>
                    {k === nowAt && <div className="cw-now" aria-label="Now" />}
                    <EventCard e={e} s={s} en={en} past={past} live={live} clash={clash} />
                  </Fragment>
                );
              })}
              {i === TODAY && nowAt === -1 && shown.length > 0 && <div className="cw-now" aria-label="Now" />}
              {hiddenCount > 0 && (
                <button
                  className="cw-more"
                  onClick={() => setOpen((o) => new Set(o).add(dayKey(d)))}
                >
                  +{hiddenCount} more
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One timed event in the week view. The card joins the meeting (or opens the event); the corner
    button always opens it in Google Calendar. */
function EventCard({ e, s, en, past, live, clash }: { e: CalEvent; s: Date; en: Date; past: boolean; live: boolean; clash: boolean }) {
  const meeting = meetingOf(e);
  const place = e.location && !isUrl(e.location) ? e.location : "";
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("cw-event", past && "past", live && "live")}
      style={e.color ? ({ "--cal": e.color } as React.CSSProperties) : undefined}
      onClick={() => openEvent(e)}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          openEvent(e);
        }
      }}
      title={`${e.title}\n${timeRange(s, en)}${place ? `\n${place}` : ""}\n${e.calendar}${clash ? "\nOverlaps another event" : ""}\n${
        meeting ? `Click to join ${meetingName(meeting)}` : "Click to open in Google Calendar"
      }`}
    >
      <span className="cw-time tnum">
        {timeRange(s, en)}
        {clash && <Layers size={11} className="cw-clash" aria-label="Overlaps another event" />}
      </span>
      <span className="cw-title">{e.title}</span>
      {meeting ? (
        <span className="cw-join">
          <Video size={12} /> Join {meetingName(meeting)}
        </span>
      ) : (
        place && (
          <span className="cw-loc">
            <MapPin size={11} /> {place}
          </span>
        )
      )}
      {e.link && (
        <button
          className="cw-go"
          title="Open in Google Calendar"
          aria-label="Open in Google Calendar"
          onClick={(ev) => {
            ev.stopPropagation();
            void openUrl(e.link);
          }}
        >
          <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}

/* ---------------- calendar: month view ---------------- */

const monthCache = new Map<string, CalEvent[]>();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined }).replace(/\s?([AP])M/i, (_, x) => x.toLowerCase());

function MonthView() {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  const key = ymd(gridStart);
  const [events, setEvents] = useState<CalEvent[] | null>(monthCache.get(key) ?? null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = useNow();

  useEffect(() => {
    let live = true;
    setEvents(monthCache.get(key) ?? null);
    void api
      .calendarUpcoming(key, 42)
      .then((r) => {
        if (!live || r.status !== "ok") return;
        monthCache.set(key, r.events);
        setEvents(r.events);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);

  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events ?? []) {
    const s = parseEventDate(e.start, e.allDay);
    const en = parseEventDate(e.end, e.allDay);
    for (const d of cells) {
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      if (s < next && en > d) byDay.set(dayKey(d), [...(byDay.get(dayKey(d)) ?? []), e]);
    }
  }
  // Which way the last move went, so the new month slides in from that side.
  const [dir, setDir] = useState(0);
  const step = (n: number) => {
    setDir(n);
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  };
  const todayKey = dayKey(now);

  return (
    <div className="cm">
      <div className="cm-nav">
        <button className="icon-btn sm" onClick={() => step(-1)} aria-label="Previous month">
          <ChevronLeft size={16} />
        </button>
        <h4>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h4>
        <button className="icon-btn sm" onClick={() => step(1)} aria-label="Next month">
          <ChevronRight size={16} />
        </button>
        <button
          className="btn ghost cm-today"
          onClick={() => {
            const d = new Date();
            setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          Today
        </button>
        {!events && <Loader2 size={14} className="spin faint" />}
      </div>
      <div
        key={month.getTime()}
        className={cx("cm-grid", dir > 0 && "from-right", dir < 0 && "from-left")}
        role="grid"
        aria-label={month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
      >
        {cells.slice(0, 7).map((d) => (
          <div key={`h${d.getDay()}`} className="cm-dow">
            {d.toLocaleDateString(undefined, { weekday: "short" })}
          </div>
        ))}
        {cells.map((d, idx) => {
          const k = dayKey(d);
          const evs = (byDay.get(k) ?? []).sort(
            (a, b) => Number(b.allDay) - Number(a.allDay) || +parseEventDate(a.start, a.allDay) - +parseEventDate(b.start, b.allDay),
          );
          const expanded = open.has(k);
          const shown = expanded ? evs : evs.slice(0, 3);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div
              key={k}
              role="gridcell"
              data-row={Math.floor(idx / 7)}
              className={cx("cm-cell", d.getMonth() !== month.getMonth() && "other", weekend && "weekend", k === todayKey && "today")}
            >
              <span className="cm-num tnum">{d.getDate()}</span>
              {shown.map((e) => {
                const s = parseEventDate(e.start, e.allDay);
                const past = parseEventDate(e.end, e.allDay) <= now;
                const meeting = meetingOf(e);
                return (
                  <button
                    key={e.id + k}
                    className={cx("cm-ev", e.allDay && "allday", past && "past")}
                    style={e.color ? ({ "--cal": e.color } as React.CSSProperties) : undefined}
                    onClick={() => openEvent(e)}
                    title={`${e.title}${e.allDay ? " · all day" : ` · ${shortTime(s)}`}\n${e.calendar}\n${
                      meeting ? `Click to join ${meetingName(meeting)}` : "Click to open in Google Calendar"
                    }`}
                  >
                    {!e.allDay && <span className="cm-t tnum">{shortTime(s)}</span>}
                    <span className="cm-title">{e.title}</span>
                    {meeting && <Video size={11} className="cm-video" />}
                  </button>
                );
              })}
              {evs.length > shown.length && (
                <button className="cm-more" onClick={() => setOpen((o) => new Set(o).add(k))}>
                  +{evs.length - shown.length} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Re-render once a minute (for "now", past events and "updated … ago"). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/* ---------------- week ⇄ month transition ---------------- */

let switchedAt = 0;
export { reduceMotion };

/** Wait for an animation, but never longer than it should take (hidden windows can pause them). */
export const settle = (p: Promise<unknown> | undefined, ms: number) =>
  Promise.race([p ?? Promise.resolve(), new Promise((r) => window.setTimeout(r, ms))]);

/** Week ⇄ month: the view on screen fades out, the other fades in while the height glides. */
async function toggleCalendarView() {
  const toMonth = !useStore.getState().calMonth;
  switchedAt = Date.now();
  const swap = document.querySelector<HTMLElement>(".cal-swap");
  if (!swap || reduceMotion()) {
    useStore.setState({ calMonth: toMonth });
    return;
  }
  swap.style.pointerEvents = "none";
  const out = swap.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: motionMs("fast-out"),
    easing: motionEase("ease-in"),
    fill: "forwards",
  });
  await settle(out.finished, motionMs("fast-out") + 60);
  switchedAt = Date.now();
  flushSync(() => useStore.setState({ calMonth: toMonth }));
  out.cancel();
  swap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs("fast"), easing: motionEase("ease") });
  swap.style.pointerEvents = "";
}

/** Animate the calendar's height when the view changes (including a month that loads a moment later). */
function useHeightGlide(view: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const animating = useRef(false);
  const glide = (el: HTMLElement) => {
    // Mid-glide, the height is the animation's; check again once it lands.
    if (animating.current) return;
    const h = el.offsetHeight;
    if (h !== last.current && last.current > 0 && Date.now() - switchedAt < 1200 && !reduceMotion()) {
      animating.current = true;
      const a = el.animate([{ height: `${last.current}px` }, { height: `${h}px` }], {
        duration: motionMs("slow"),
        easing: motionEase("ease-move"),
      });
      a.onfinish = a.oncancel = () => {
        animating.current = false;
        glide(el);
      };
    }
    last.current = h;
  };
  // Right after the view switches, before it paints.
  useLayoutEffect(() => {
    if (ref.current) glide(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // Later size changes (a month's events arriving). Attached once the calendar has loaded.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    last.current = el.offsetHeight;
    const ro = new ResizeObserver(() => glide(el));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return ref;
}

/** Which calendars are shown, tucked behind a small button until someone asks. */
function CalendarKey({ cals }: { cals: ReturnType<typeof calendarsIn> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span className="cw-keywrap" ref={ref}>
      <button
        className={cx("icon-btn sm", open && "on")}
        onClick={() => setOpen((o) => !o)}
        title="Calendars shown"
        aria-label="Calendars shown"
        aria-expanded={open}
      >
        <Layers size={14} />
      </button>
      {open && (
        <span className="cw-keys" role="list">
          {cals.map((c) => (
            <span key={c.name} role="listitem" className="cw-key" style={c.color ? ({ "--cal": c.color } as React.CSSProperties) : undefined}>
              {c.name}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Calendar controls (shown on hover): calendars shown, the week/month switch and Google Calendar. */
export function CalendarHeader() {
  const { cal } = useCalendar();
  const month = useStore((s) => s.calMonth);
  const cals = cal?.status === "ok" ? calendarsIn(cal.events) : [];
  return (
    <>
      {cals.length > 1 && <CalendarKey cals={cals} />}

      <button
        className={cx("btn ghost cw-toggle", month && "on")}
        onClick={() => void toggleCalendarView()}
        title={month ? "Back to this week" : "Show the whole month"}
      >
        {month ? <CalendarDays size={14} /> : <CalendarRange size={14} />} {month ? "Week" : "Month"}
      </button>
      <button
        className="icon-btn sm"
        onClick={() => void openUrl(GOOGLE_CALENDAR)}
        title="Open Google Calendar in your browser"
        aria-label="Open Google Calendar in your browser"
      >
        <ExternalLink size={14} />
      </button>
    </>
  );
}
