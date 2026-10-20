import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { Pin, PinOff, Sparkles } from "lucide-react";
import { api, errText, type AiStatus, type Home as HomeData, type HomeItem } from "../api";
import { useStore } from "../store";
import { mark } from "../motion";
import { cx, shortDate } from "../util";
import { Avatar, hueFor } from "./Avatar";
import { CalendarBody, CalendarHeader, settle } from "./Calendar";
import { motionEase, motionMs, reduceMotion } from "../motionTokens";
import { Empty, open } from "./HomeBits";
import { dragJustEnded, startPinDrag } from "../mailDrag";

/* ---------------- cache (survives leaving and returning to Home) ---------------- */

const cache: {
  home: HomeData | null;
  ai: AiStatus | null;
} = { home: null, ai: null };

/* ---------------- pinned cards gliding into their new places ---------------- */

/** Where each pinned card sat just before a pin change, so the ones that move can glide there. */
let flipFrom: { at: number; rects: Map<string, DOMRect> } | null = null;

const pinnedCards = () => document.querySelectorAll<HTMLElement>(".hcards > .hitem[data-thread]");

/** Reload Home after a pin change, remembering where the cards were first. */
function refreshHome() {
  if (!reduceMotion()) {
    const rects = new Map<string, DOMRect>();
    pinnedCards().forEach((el) => rects.set(el.dataset.thread!, el.getBoundingClientRect()));
    flipFrom = { at: performance.now(), rects };
  }
  window.dispatchEvent(new Event("post:home-refresh"));
}


/* ---------------- shared bits ---------------- */

function ItemRow({
  it,
  right,
  unread,
  className,
  card,
  onPointerDown,
}: {
  it: HomeItem;
  right?: ReactNode;
  unread?: boolean;
  className?: string;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** A small card: the sender's color down one edge and a line of the email under its subject. */
  card?: boolean;
}) {
  return (
    <button
      data-thread={it.threadId}
      className={cx("hitem", card && "hcard", unread && "unread", className)}
      style={card ? ({ "--h": hueFor((it.email || it.name).toLowerCase()) } as React.CSSProperties) : undefined}
      onClick={() => !dragJustEnded() && open(it.threadId)}
      onPointerDown={onPointerDown}
    >
      <Avatar email={it.email} name={it.name || it.email} size="sm" />
      <span className="htext">
        <span className="hl1">
          <b>{it.name || it.email || "Unknown"}</b>
          <span className="hdate">{shortDate(it.date)}</span>
        </span>
        <span className="hl2">{it.subject || "(no subject)"}</span>
        {card && it.snippet && <span className="hl3">{it.snippet}</span>}
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

/** Home is the calendar, then your pinned emails. Each shows just its content, with any controls floating in on hover. */
interface ModuleDef {
  id: string;
  title: string;
  action?: () => ReactNode;
  render: (d: HomeData | null) => ReactNode;
}

const MODULES: ModuleDef[] = [
  {
    id: "calendar",
    title: "Calendar",
    action: () => <CalendarHeader />,
    render: () => <CalendarBody />,
  },
  {
    id: "pinned",
    title: "Pinned",
    render: (d) =>
      !d ? null : d.pinned.length ? (
        <>
        {/* A quiet label over the pinned emails, with how many there are. */}
        <div className="hlabel">
          <Pin size={13} /> Pinned <span className="hlabel-n">{d.pinned.length}</span>
        </div>
        <div className="hcards">
        {d.pinned.map((it) => (
          <ItemRow
            key={it.threadId}
            it={it}
            card
            className={cx("pinned", useStore.getState().marks[`pin:${it.threadId}`] === "new" && "pin-new")}
            // Dragged back onto the inbox, it comes unpinned.
            onPointerDown={(e) => {
              if (!(e.target as HTMLElement).closest(".icon-btn")) startPinDrag(e, it.threadId, { email: it.email, name: it.name }, it.subject);
            }}
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
        ))}
        </div>
        </>
      ) : (
        <Empty>Nothing pinned. Drag an email here, or press P, to keep it here until it's done.</Empty>
      ),
  },
];

/* ---------------- home ---------------- */

export function Home() {
  const [data, setData] = useState<HomeData | null>(cache.home);
  const [err, setErr] = useState<string | null>(null);
  useStore((s) => s.marks);

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

  // After a pin change, the cards that stay slide over into their new places instead of jumping.
  useLayoutEffect(() => {
    const f = flipFrom;
    if (!f) return;
    flipFrom = null;
    if (performance.now() - f.at > 3000) return;
    pinnedCards().forEach((el) => {
      const was = f.rects.get(el.dataset.thread!);
      if (!was) return;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: motionMs("emphasis"),
        easing: motionEase("ease-move"),
      });
    });
  }, [data]);

  // Pinned emails sit quietly on Home; with none pinned they take no space.
  const shown = MODULES.filter((m) => m.id !== "pinned" || !!data?.pinned.length);

  return (
    <div className="home" role="region" aria-label="Home">
      {err && (
        <div className="home-bar">
          <span className="error">{err}</span>
        </div>
      )}
      <div className="home-rows">
        {shown.map((m) => (
          <div key={m.id} className="hrow" style={{ "--n": 1 } as React.CSSProperties}>
            <section data-module={m.id} className="hcard bare" aria-label={m.title}>
              {m.action && <div className="hfloat">{m.action()}</div>}
              <div className="hbody">{m.render(data)}</div>
            </section>
          </div>
        ))}
      </div>
      <div className="home-foot">
        <AiFooter />
      </div>
    </div>
  );
}

/** Toggle the pin on the open conversation (P key, toolbar). */
export async function togglePin(threadId: string): Promise<boolean> {
  const now = !(await api.isPinned(threadId));
  await setPin(threadId, now);
  return now;
}

/** Unpin from Home: the card fades and shrinks away, then the cards after it slide over into its place. */
export async function unpinAnimated(threadId: string, from: HTMLElement) {
  const card = from.closest<HTMLElement>(".hitem");
  if (card && !reduceMotion()) {
    const ms = Math.round(motionMs("med") * 1.4);
    await settle(
      card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.94)" }], {
        duration: ms,
        easing: motionEase("ease-in"),
        fill: "forwards",
      }).finished,
      ms + 60,
    );
  }
  await setPin(threadId, false);
}

/** Pin or unpin, with an Undo (also reachable with Ctrl+Z). */
export async function setPin(threadId: string, pinned: boolean) {
  await api.pinThread(threadId, pinned);
  if (pinned) mark(`pin:${threadId}`, "new");
  refreshHome();
  useStore.getState().snack({
    text: pinned ? "Pinned to home" : "Unpinned",
    action: {
      label: "Undo",
      run: () =>
        void api.pinThread(threadId, !pinned).then(() => {
          if (!pinned) mark(`pin:${threadId}`, "new");
          refreshHome();
        }),
    },
  });
}
