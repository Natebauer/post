import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Check,
  Clock3,
  ExternalLink,
  EyeOff,
  FileText,
  GripVertical,
  LayoutGrid,
  MailQuestion,
  Package,
  Pencil,
  Pin,
  PinOff,
  Plane,
  Plus,
  RotateCcw,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  api,
  errText,
  type AiStatus,
  type Home as HomeData,
  type HomeItem,
  type HomeModuleCfg,
  type ThreadSummary,
} from "../api";
import { useStore } from "../store";
import { goFolder } from "../actions";
import { findSection, sectionFolder } from "../senders";
import { leave, mark } from "../motion";
import { cx, formatBytes, shortDate } from "../util";
import { Avatar } from "./Avatar";
import { parseInvite } from "./Invite";
import { Thumb } from "./Thumb";
import { CalendarBody, CalendarHeader, settle, time } from "./Calendar";
import { motionEase, motionMs, reduceMotion } from "../motionTokens";
import { Empty, open } from "./HomeBits";

/* ---------------- cache (survives leaving and returning to Home) ---------------- */

const cache: {
  home: HomeData | null;
  ai: AiStatus | null;
} = { home: null, ai: null };


/* ---------------- shared bits ---------------- */

function ItemRow({ it, right, unread, className }: { it: HomeItem; right?: ReactNode; unread?: boolean; className?: string }) {
  return (
    <button className={cx("hitem", unread && "unread", className)} onClick={() => open(it.threadId)}>
      <Avatar email={it.email} name={it.name || it.email} size="sm" />
      <span className="htext">
        <span className="hl1">
          <b>{it.name || it.email || "Unknown"}</b>
          <span className="hdate">{shortDate(it.date)}</span>
        </span>
        <span className="hl2">{it.subject || "(no subject)"}</span>
      </span>
      {right}
    </button>
  );
}

/* ---------------- AI ---------------- */

/** Post's own Claude spending this month, as a quiet line at the bottom of home. */
function AiFooter() {
  const [s, setS] = useState<AiStatus | null>(cache.ai);
  useEffect(() => {
    const load = () =>
      void api
        .aiStatus()
        .then((v) => {
          cache.ai = v;
          setS(v);
        })
        .catch(() => {});
    load();
    const un = listen("home-changed", load);
    const unSettings = listen("settings-changed", load);
    return () => {
      void un.then((f) => f());
      void unSettings.then((f) => f());
    };
  }, []);
  const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
  if (!s) return null;
  const openAi = () => useStore.setState({ settingsOpen: true });
  if (!s.hasKey || !s.enabled)
    return (
      <button className="home-ai" onClick={openAi} title="Open AI settings">
        <Sparkles size={13} /> {s.hasKey ? "AI is off" : "AI not set up"}
      </button>
    );
  const pct = Math.min(100, (s.monthSpend / Math.max(0.01, s.cap)) * 100);
  return (
    <button className="home-ai tnum" onClick={openAi} title={`${s.monthCalls} request${s.monthCalls === 1 ? "" : "s"} to ${s.model} this month`}>
      <Sparkles size={13} /> AI this month
      <span
        className={cx("home-ai-bar", s.capped && "capped")}
        role="progressbar"
        aria-label="Monthly AI budget used"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${Math.max(pct, s.monthSpend > 0 ? 2 : 0)}%` }} />
      </span>
      {money(s.monthSpend)} of {money(s.cap)}
      {s.capped ? " · cap reached, paused until next month" : ` · ${s.monthCalls} request${s.monthCalls === 1 ? "" : "s"}`}
    </button>
  );
}
/* ---------------- modules ---------------- */

interface ModuleDef {
  id: string;
  title: string;
  icon: ReactNode;
  wide: boolean;
  /** No header outside Customize: just the content, with any controls floating in on hover. */
  bare?: boolean;
  count?: (d: HomeData) => number;
  action?: (d: HomeData | null) => ReactNode;
  render: (d: HomeData | null, reload: () => void) => ReactNode;
}

function upcomingInvites(d: HomeData) {
  const now = Date.now();
  return d.invites
    .map((i) => ({ i, inv: parseInvite(i.ics) }))
    .filter((x): x is { i: (typeof d.invites)[number]; inv: NonNullable<ReturnType<typeof parseInvite>> } =>
      !!x.inv?.start && x.inv.start.getTime() > now - 3_600_000,
    )
    .sort((a, b) => a.inv.start!.getTime() - b.inv.start!.getTime())
    .filter((x, idx, arr) => arr.findIndex((y) => y.inv.summary === x.inv.summary && +y.inv.start! === +x.inv.start!) === idx)
    .slice(0, 4);
}

const MODULES: ModuleDef[] = [
  {
    id: "calendar",
    title: "Calendar",
    icon: <CalendarDays size={16} />,
    wide: true,
    bare: true,
    action: () => <CalendarHeader />,
    render: () => <CalendarBody />,
  },
  {
    id: "waiting",
    title: "Waiting on you",
    icon: <MailQuestion size={16} />,
    wide: false,
    count: (d) => d.waiting.length,
    action: (d) =>
      d?.waitingAi && (
        <span className="hchip" title="Filtered by Claude">
          AI
        </span>
      ),
    render: (d) =>
      !d ? null : d.waiting.length ? (
        d.waiting.map((it) => <ItemRow key={it.messageId} it={it} />)
      ) : (
        <Empty>You're all caught up. Personal emails that need a reply show up here.</Empty>
      ),
  },
  {
    id: "pinned",
    title: "Pinned",
    icon: <Pin size={16} />,
    wide: false,
    bare: true,
    count: (d) => d.pinned.length,
    render: (d) =>
      !d ? null : d.pinned.length ? (
        d.pinned.map((it) => (
          <ItemRow
            key={it.threadId}
            it={it}
            className={cx("pinned", useStore.getState().marks[`pin:${it.threadId}`] === "new" && "pin-new")}
            right={
              <span
                role="button"
                tabIndex={0}
                className="icon-btn sm"
                title="Done (unpin)"
                aria-label="Mark done and unpin"
                onClick={(e) => {
                  e.stopPropagation();
                  void unpinAnimated(it.threadId, e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    void unpinAnimated(it.threadId, e.currentTarget);
                  }
                }}
              >
                <PinOff size={14} />
              </span>
            }
          />
        ))
      ) : (
        <Empty>Nothing pinned. Drag an email here, or press P, to keep it here until it's done.</Empty>
      ),
  },
  {
    id: "noReply",
    title: "No reply yet",
    icon: <Clock3 size={16} />,
    wide: false,
    count: (d) => d.noReply.length,
    render: (d) =>
      !d ? null : d.noReply.length ? (
        d.noReply.map((it) => <ItemRow key={it.messageId} it={it} />)
      ) : (
        <Empty>Emails you sent that go 3 days without an answer show up here.</Empty>
      ),
  },
  {
    id: "packages",
    title: "Packages",
    icon: <Package size={16} />,
    wide: false,
    count: (d) => d.packages.length,
    render: (d) =>
      !d ? null : d.packages.length ? (
        d.packages.map((it) => (
          <ItemRow
            key={it.threadId}
            it={it}
            right={
              <span className={cx("hstatus", it.tag === "Delivered" && "ok", it.tag === "Out for delivery" && "hot")}>{it.tag}</span>
            }
          />
        ))
      ) : (
        <Empty>No shipments in the last three weeks.</Empty>
      ),
  },
  {
    id: "trips",
    title: "Events & trips",
    icon: <Plane size={16} />,
    wide: false,
    count: (d) => d.trips.length + upcomingInvites(d).length,
    render: (d) => {
      if (!d) return null;
      const invites = upcomingInvites(d);
      if (!invites.length && !d.trips.length)
        return <Empty>Invites, flights, bookings and event registrations show up here.</Empty>;
      return (
        <>
          {invites.map(({ i, inv }) => (
            <button key={i.messageId} className="hitem" onClick={() => open(i.threadId)}>
              <span className="hcal-badge" aria-hidden>
                <b>{inv.start!.toLocaleDateString(undefined, { month: "short" })}</b>
                {inv.start!.getDate()}
              </span>
              <span className="htext">
                <span className="hl1">
                  <b>{inv.summary}</b>
                </span>
                <span className="hl2">
                  {inv.allDay ? "All day" : time(inv.start!)}
                  {inv.location ? ` · ${inv.location}` : ""}
                </span>
              </span>
            </button>
          ))}
          {d.trips.map((it) => (
            <ItemRow key={it.threadId} it={it} />
          ))}
        </>
      );
    },
  },
  {
    id: "attachments",
    title: "Recent attachments",
    icon: <FileText size={16} />,
    wide: false,
    count: (d) => d.attachments.length,
    render: (d) =>
      !d ? null : d.attachments.length ? (
        <div className="hatts">
          {d.attachments.map((a) => (
            <button
              key={`${a.messageId}/${a.partId}`}
              className="hatt"
              onClick={() => open(a.threadId)}
              title={`${a.filename} from ${a.from}`}
            >
              <span className="hatt-thumb">
                <Thumb a={a} fallback={<FileText size={18} />} />
              </span>
              <span className="hatt-name">{a.filename}</span>
              <span className="faint">
                {a.from} · {formatBytes(a.size)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty>Files people send you show up here.</Empty>
      ),
  },
];

/* ---------------- sidebar sections placed on Home ---------------- */

const SECTION_ROWS = 6;
const sectionCache = new Map<string, { threads: ThreadSummary[]; total: number }>();

function toItem(t: ThreadSummary): HomeItem {
  const p = t.participants.find((x) => x.email === t.avatarEmail) ?? t.participants[0];
  return {
    threadId: t.threadId,
    messageId: "",
    name: p?.name ?? "",
    email: p?.email ?? t.avatarEmail,
    subject: t.subject,
    snippet: t.snippet,
    date: t.date,
    tag: null,
  };
}

/** The latest emails in a sidebar section; follows new mail and changes to the section's rules. */
function SectionBody({ sectionKey }: { sectionKey: string }) {
  const section = useStore((s) => s.settings?.senderViews.find((v) => (v.id || v.email.toLowerCase()) === sectionKey));
  const signature = JSON.stringify(section ?? null);
  const [list, setList] = useState(sectionCache.get(sectionKey) ?? null);

  useEffect(() => {
    if (!section) return;
    let live = true;
    const load = () =>
      void api
        .listThreads(sectionFolder(section), 0, SECTION_ROWS)
        .then((r) => {
          if (!live) return;
          const v = { threads: r.threads, total: r.total };
          sectionCache.set(sectionKey, v);
          setList(v);
        })
        .catch(() => {});
    load();
    let timer: number | undefined;
    const un = listen("threads-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 800);
    });
    return () => {
      live = false;
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (!section || !list) return null;
  if (!list.threads.length)
    return <Empty>{section.kind === "ai" ? "Nothing sorted into this yet." : "No emails here right now."}</Empty>;
  return (
    <>
      {list.threads.map((t) => (
        <ItemRow key={t.threadId} it={toItem(t)} unread={t.unread} />
      ))}
      {list.total > list.threads.length && (
        <button className="hmore" onClick={() => goFolder(sectionFolder(section))}>
          Show all {list.total.toLocaleString()}
        </button>
      )}
    </>
  );
}

/** A built-in module, or a sidebar section placed on Home ("sec:<key>"). */
function moduleFor(id: string): ModuleDef | null {
  const builtIn = MODULES.find((m) => m.id === id);
  if (builtIn) return builtIn;
  if (!id.startsWith("sec:")) return null;
  const v = findSection(id.slice(4));
  if (!v) return null;
  return {
    id,
    title: v.name,
    icon:
      v.kind === "ai" ? (
        <Sparkles size={16} />
      ) : v.kind === "group" ? (
        <Users size={16} />
      ) : (
        <Avatar email={v.email} name={v.name} size="xs" />
      ),
    wide: false,
    count: () => useStore.getState().counts[id] ?? 0,
    action: () => (
      <>
        <button
          className="icon-btn sm"
          title="Edit"
          aria-label={`Edit ${v.name}`}
          onClick={() => useStore.setState({ sectionEdit: id.slice(4) })}
        >
          <Pencil size={14} />
        </button>
        <button className="icon-btn sm" title={`Open ${v.name}`} aria-label={`Open ${v.name}`} onClick={() => goFolder(sectionFolder(v))}>
          <ExternalLink size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="Remove from Home"
          aria-label={`Remove ${v.name} from Home`}
          onClick={() => void removeFromHome(id)}
        >
          <X size={14} />
        </button>
      </>
    ),
    render: () => <SectionBody sectionKey={id.slice(4)} />,
  };
}

/** Put a sidebar section on Home, right under the first row. */
export async function addSectionToHome(key: string) {
  const st = useStore.getState();
  const id = `sec:${key}`;
  const v = findSection(key);
  if (!v) return;
  const before = st.settings?.homeLayout ?? [];
  const { rows, hidden } = resolveLayout(before);
  if (rows.flat().includes(id)) {
    st.snack({ text: `${v.name} is already on Home`, ms: 2000 });
    return;
  }
  const next = [...rows];
  next.splice(Math.min(1, next.length), 0, [id]);
  // Marked first, so the card's first appearance is its entrance.
  mark(`home:${id}`, "new");
  await st.saveSettings({ homeLayout: toConfig(next, hidden.filter((h) => h !== id)) });
  st.snack({
    text: `Added ${v.name} to Home`,
    action: { label: "Undo", run: () => void useStore.getState().saveSettings({ homeLayout: before }) },
  });
}

/** Take a section's module off Home (the section itself stays in the sidebar). */
async function removeFromHome(id: string) {
  const st = useStore.getState();
  const before = st.settings?.homeLayout ?? [];
  const { rows, hidden } = resolveLayout(before);
  await leave([`home:${id}`]);
  const next = rows.map((r) => r.filter((x) => x !== id)).filter((r) => r.length);
  await st.saveSettings({ homeLayout: toConfig(next, hidden.filter((h) => h !== id)) });
  const name = findSection(id.slice(4))?.name ?? "Section";
  st.snack({
    text: `Removed ${name} from Home`,
    action: {
      label: "Undo",
      run: () => {
        mark(`home:${id}`, "new");
        void useStore.getState().saveSettings({ homeLayout: before });
      },
    },
  });
}

/* ---------------- layout: rows of up to 4 modules ---------------- */

const MAX_PER_ROW = 4;
type Rows = string[][];
type Zone = "left" | "right" | "above" | "below";

/** Default: the calendar on its own row, then the rest two to a row. */
function defaultRows(): Rows {
  const rows: Rows = [["calendar"]];
  const rest = MODULES.filter((m) => m.id !== "calendar").map((m) => m.id);
  for (let i = 0; i < rest.length; i += 2) rows.push(rest.slice(i, i + 2));
  return rows;
}

/** Saved layout as rows + hidden ids; modules added since it was saved get their own row. */
function resolveLayout(saved: HomeModuleCfg[] | undefined): { rows: Rows; hidden: string[] } {
  const known = (id: string) => !!moduleFor(id);
  if (!saved?.length) return { rows: defaultRows(), hidden: [] };
  const hidden = saved.filter((c) => c.hidden && known(c.id)).map((c) => c.id);
  const shown = saved.filter((c) => !c.hidden && known(c.id));
  let rows: Rows;
  if (shown.some((c) => c.row != null)) {
    const byRow = new Map<number, string[]>();
    for (const c of shown) byRow.set(c.row ?? 9999, [...(byRow.get(c.row ?? 9999) ?? []), c.id]);
    rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids.slice(0, MAX_PER_ROW));
  } else {
    // Older saved layouts: wide modules alone, others paired.
    rows = [];
    let pending: string[] = [];
    for (const c of shown) {
      if (c.wide) {
        if (pending.length) rows.push(pending);
        pending = [];
        rows.push([c.id]);
      } else {
        pending.push(c.id);
        if (pending.length === 2) {
          rows.push(pending);
          pending = [];
        }
      }
    }
    if (pending.length) rows.push(pending);
  }
  const placed = new Set([...rows.flat(), ...hidden]);
  for (const m of MODULES) if (!placed.has(m.id)) rows.push([m.id]);
  return { rows, hidden };
}

function toConfig(rows: Rows, hidden: string[]): HomeModuleCfg[] {
  return [
    ...rows.flatMap((ids, r) => ids.map((id) => ({ id, row: r, wide: ids.length === 1, hidden: false }))),
    ...hidden.map((id) => ({ id, row: null, wide: false, hidden: true })),
  ];
}

/** Move `id` next to `target` (same row) or into a new row above/below it. */
function moveModule(rows: Rows, id: string, target: string, zone: Zone): Rows {
  if (id === target) return rows;
  let next = rows.map((r) => r.filter((x) => x !== id)).filter((r) => r.length);
  const rowIdx = next.findIndex((r) => r.includes(target));
  if (rowIdx < 0) return rows;
  const row = next[rowIdx];
  if ((zone === "left" || zone === "right") && row.length < MAX_PER_ROW) {
    const col = row.indexOf(target) + (zone === "right" ? 1 : 0);
    next = next.map((r, i) => (i === rowIdx ? [...r.slice(0, col), id, ...r.slice(col)] : r));
  } else {
    const at = zone === "above" ? rowIdx : rowIdx + 1;
    next = [...next.slice(0, at), [id], ...next.slice(at)];
  }
  return next;
}

function zoneFor(rect: DOMRect, x: number, y: number): Zone {
  const edge = Math.min(rect.width * 0.25, 140);
  if (x < rect.left + edge) return "left";
  if (x > rect.right - edge) return "right";
  return y < rect.top + rect.height / 2 ? "above" : "below";
}

/* ---------------- home ---------------- */

/**
 * When modules are added, removed or rearranged, the others slide from where they were to
 * where they now are (rather than jumping). Positions are measured within Home's scroll area.
 */
function useSlideOnLayoutChange(layoutKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<{ key: string; pos: Map<string, { x: number; y: number }> }>({ key: layoutKey, pos: new Map() });

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const pos = new Map<string, { x: number; y: number }>();
    const changed = last.current.key !== layoutKey;
    const still = reduceMotion();
    root.querySelectorAll<HTMLElement>("[data-module]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const p = { x: r.left - box.left, y: r.top - box.top + root.scrollTop };
      pos.set(el.dataset.module!, p);
      const before = last.current.pos.get(el.dataset.module!);
      if (!changed || still || !before) return;
      const dx = before.x - p.x;
      const dy = before.y - p.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: motionMs("slow"),
        easing: motionEase("ease-move"),
      });
    });
    last.current = { key: layoutKey, pos };
  });

  return ref;
}

export function Home() {
  const [data, setData] = useState<HomeData | null>(cache.home);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const saved = useStore((s) => s.settings?.homeLayout);
  // Section modules follow renames, removals and unread counts.
  useStore((s) => s.settings?.senderViews);
  useStore((s) => s.counts);
  const marks = useStore((s) => s.marks);
  const [layout, setLayout] = useState(() => resolveLayout(saved));
  const [drag, setDrag] = useState<{ id: string; target: string | null; zone: Zone | null } | null>(null);

  useEffect(() => {
    if (!drag) setLayout(resolveLayout(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const load = useCallback(() => {
    api
      .homeSummary()
      .then((d) => {
        cache.home = d;
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(errText(e)));
  }, []);

  useEffect(() => {
    load();
    let timer: number | undefined;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 1200);
    };
    const subs = [listen("threads-changed", debounced), listen("home-changed", debounced)];
    const t = window.setInterval(load, 60_000);
    // Immediate refresh after a change made right here (e.g. an email dropped in to pin it).
    window.addEventListener("post:home-refresh", load);
    return () => {
      window.removeEventListener("post:home-refresh", load);
      window.clearTimeout(timer);
      window.clearInterval(t);
      subs.forEach((p) => void p.then((f) => f()));
    };
  }, [load]);

  const save = (rows: Rows, hidden: string[]) => {
    setLayout({ rows, hidden });
    void useStore.getState().saveSettings({ homeLayout: toConfig(rows, hidden) });
  };
  const hide = (id: string) =>
    void leave([`home:${id}`]).then(() =>
      save(
        layout.rows.map((r) => r.filter((x) => x !== id)).filter((r) => r.length),
        [...layout.hidden, id],
      ),
    );
  const unhide = (id: string) => save([...layout.rows, [id]], layout.hidden.filter((x) => x !== id));

  // Pointer-based drag (HTML5 drag events don't reach the page in Post's window).
  const startDrag = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    let state: { target: string | null; zone: Zone | null } = { target: null, zone: null };
    setDrag({ id, ...state });
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-module]");
      const target = el?.dataset.module ?? null;
      state =
        el && target && target !== id
          ? { target, zone: zoneFor(el.getBoundingClientRect(), ev.clientX, ev.clientY) }
          : { target: null, zone: null };
      setDrag({ id, ...state });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (state.target && state.zone) save(moveModule(layout.rows, id, state.target, state.zone), layout.hidden);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Keyboard: Left/Right within the row, Up/Down into a row of its own above/below.
  const moveByKey = (id: string, key: string) => {
    const rowIdx = layout.rows.findIndex((r) => r.includes(id));
    const row = layout.rows[rowIdx];
    const col = row.indexOf(id);
    if (key === "ArrowLeft" && col > 0) save(moveModule(layout.rows, id, row[col - 1], "left"), layout.hidden);
    else if (key === "ArrowRight" && col < row.length - 1) save(moveModule(layout.rows, id, row[col + 1], "right"), layout.hidden);
    else if (key === "ArrowUp" && rowIdx > 0) save(moveModule(layout.rows, id, layout.rows[rowIdx - 1][0], "above"), layout.hidden);
    else if (key === "ArrowDown" && rowIdx < layout.rows.length - 1)
      save(moveModule(layout.rows, id, layout.rows[rowIdx + 1][0], "below"), layout.hidden);
  };

  // Sections removed from the sidebar drop off Home too.
  // Pinned emails sit quietly on Home; with none pinned it takes no space (Customize still shows it).
  const quiet = (id: string) => !editing && id === "pinned" && !data?.pinned.length;
  const shownRows = layout.rows.map((r) => r.filter((id) => moduleFor(id) && !quiet(id))).filter((r) => r.length);
  const shownHidden = layout.hidden.filter((id) => moduleFor(id));
  const slideRef = useSlideOnLayoutChange(shownRows.map((r) => r.join(",")).join("|"));

  return (
    <div ref={slideRef} className={cx("home", editing && "editing", drag && "dragging-any")} role="region" aria-label="Home">
      {(editing || err) && (
      <div className="home-bar">
        {err && <span className="error">{err}</span>}
        <span className="sp" />
        {editing && (
          <>
            <button className="btn ghost" onClick={() => save(defaultRows(), [])} title="Restore the default layout">
              <RotateCcw size={14} /> Reset
            </button>
            <button className="btn primary" onClick={() => setEditing(false)}>
              <Check size={14} /> Done
            </button>
          </>
        )}
      </div>
      )}
      {editing && (
        <p className="home-hint">
          Drag a section by its handle. Drop it on another section's left or right edge to put them side by side (up to
          four), or on its top or bottom half to give it its own row.
        </p>
      )}
      <div className="home-rows">
        {shownRows.map((row) => (
          <div key={row.join("|")} className="hrow" style={{ "--n": row.length } as React.CSSProperties}>
            {row.map((id) => {
              const m = moduleFor(id)!;
              const count = data && m.count ? m.count(data) : 0;
              const isTarget = drag?.target === id && !!drag.zone;
              const sideBlocked = isTarget && (drag!.zone === "left" || drag!.zone === "right") && row.length >= MAX_PER_ROW;
              return (
                <section
                  key={id}
                  data-module={id}
                  className={cx(
                    "hcard",
                    m.bare && !editing && "bare",
                    marks[`home:${id}`] && `hcard-${marks[`home:${id}`]}`,
                    drag?.id === id && "dragging",
                    isTarget && `drop-${sideBlocked ? "below" : drag!.zone}`,
                  )}
                  aria-label={m.title}
                >
                  {m.bare && !editing ? (
                    m.action && <div className="hfloat">{m.action(data)}</div>
                  ) : (
                  <header>
                    {editing && (
                      <span
                        className="hgrip"
                        role="button"
                        tabIndex={0}
                        aria-label={`Move ${m.title} (arrow keys)`}
                        title="Drag to move"
                        onPointerDown={(e) => startDrag(id, e)}
                        onKeyDown={(e) => {
                          if (e.key.startsWith("Arrow")) {
                            e.preventDefault();
                            moveByKey(id, e.key);
                          }
                        }}
                      >
                        <GripVertical size={15} />
                      </span>
                    )}
                    {m.icon}
                    <h3>{m.title}</h3>
                    {!!count && <span className="hcount">{count}</span>}
                    <span className="sp" />
                    {editing ? (
                      <button className="icon-btn sm" title="Hide" aria-label={`Hide ${m.title}`} onClick={() => hide(id)}>
                        <EyeOff size={14} />
                      </button>
                    ) : (
                      m.action?.(data)
                    )}
                  </header>
                  )}
                  <div className="hbody">{m.render(data, load)}</div>
                </section>
              );
            })}
          </div>
        ))}
      </div>
      {editing && shownHidden.length > 0 && (
        <div className="home-hidden">
          <span className="faint">Hidden:</span>
          {shownHidden.map((id) => {
            const m = moduleFor(id)!;
            return (
              <button key={id} className="btn outline" onClick={() => unhide(id)}>
                <Plus size={14} /> {m.title}
              </button>
            );
          })}
        </div>
      )}
      {!editing && shownRows.length === 0 && <Empty>All sections are hidden. Use Customize to bring some back.</Empty>}
      {!editing && (
        <div className="home-foot">
          <AiFooter />
          <button className="btn ghost home-customize" onClick={() => setEditing(true)} title="Arrange the sections on this screen">
            <LayoutGrid size={14} /> Customize home
          </button>
        </div>
      )}
    </div>
  );
}

/** Toggle the pin on the open conversation (P key, toolbar). */
export async function togglePin(threadId: string): Promise<boolean> {
  const now = !(await api.isPinned(threadId));
  await setPin(threadId, now);
  return now;
}

/** Unpin from Home: the row fades and closes up (so what's below glides up), then goes. */
async function unpinAnimated(threadId: string, from: HTMLElement) {
  const row = from.closest<HTMLElement>(".hitem");
  if (row && !reduceMotion()) {
    const cs = getComputedStyle(row);
    const h = row.offsetHeight;
    await settle(
      row.animate(
        [
          { opacity: 1, height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop },
          { opacity: 0, offset: 0.4 },
          { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px" },
        ],
        { duration: motionMs("emphasis"), easing: motionEase("ease-move"), fill: "forwards" },
      ).finished,
      motionMs("emphasis") + 60,
    );
  }
  await setPin(threadId, false);
}

/** Pin or unpin, with an Undo (also reachable with Ctrl+Z). */
export async function setPin(threadId: string, pinned: boolean) {
  await api.pinThread(threadId, pinned);
  if (pinned) mark(`pin:${threadId}`, "new");
  window.dispatchEvent(new Event("post:home-refresh"));
  useStore.getState().snack({
    text: pinned ? "Pinned to home" : "Unpinned",
    action: {
      label: "Undo",
      run: () =>
        void api.pinThread(threadId, !pinned).then(() => {
          if (!pinned) mark(`pin:${threadId}`, "new");
          window.dispatchEvent(new Event("post:home-refresh"));
        }),
    },
  });
}
