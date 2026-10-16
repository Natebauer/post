import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { PinOff, Sparkles } from "lucide-react";
import { api, errText, type AiStatus, type Home as HomeData, type HomeItem } from "../api";
import { useStore } from "../store";
import { mark } from "../motion";
import { cx, shortDate } from "../util";
import { Avatar } from "./Avatar";
import { CalendarBody, CalendarHeader, settle } from "./Calendar";
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
