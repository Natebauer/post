import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, Clock, CloudOff, Copy, Minus, PanelLeft, Search, Square, X } from "lucide-react";
import { api, type Contact, type SyncStatus } from "../api";
import { useStore } from "../store";
import { toggleSidebar } from "../actions";
import { cx } from "../util";
import { Avatar } from "./Avatar";

export function WindowControls() {
  const win = getCurrentWindow();
  const [max, setMax] = useState(false);
  useEffect(() => {
    void win.isMaximized().then(setMax);
    const un = win.onResized(() => void win.isMaximized().then(setMax));
    return () => void un.then((f) => f());
  }, [win]);
  return (
    <div className="winctl">
      <button onClick={() => void win.minimize()} aria-label="Minimize" title="Minimize">
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button onClick={() => void win.toggleMaximize()} aria-label={max ? "Restore" : "Maximize"} title={max ? "Restore" : "Maximize"}>
        {max ? <Copy size={12} strokeWidth={1.5} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      <button className="close" onClick={() => void win.close()} aria-label="Close" title="Close">
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function etaText(s: SyncStatus): string | null {
  if (s.phase !== "backfill" || !s.total || s.rate < 1) return null;
  const mins = Math.max(0, s.total - s.backfilled) / s.rate;
  if (mins < 1) return "less than a minute left";
  if (mins < 60) return `about ${Math.round(mins)} min left`;
  const h = mins / 60;
  return `about ${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)} h left`;
}

/** A small static progress ring (no spinning) for long background work. */
export function SyncRing({ size = 16 }: { size?: number }) {
  const status = useStore((s) => s.status);
  if (!status || status.phase !== "backfill" || !status.total) return null;
  const pct = Math.min(1, status.backfilled / status.total);
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="bar" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
    </svg>
  );
}

export function syncLabel(s: SyncStatus) {
  const pct = Math.min(100, Math.round((s.backfilled / Math.max(1, s.total)) * 100));
  return `Building your local index: ${s.backfilled.toLocaleString()} of ~${s.total.toLocaleString()} (${pct}%)${
    etaText(s) ? `, ${etaText(s)}` : ""
  }`;
}

function SyncIndicator() {
  const status = useStore((s) => s.status);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  if (!status) return null;
  if (status.error) {
    const offline = /error sending request|dns|connect|timed out/i.test(status.error);
    return (
      <button
        className="sync-pill"
        title={`${status.error}\n\nClick to retry now.`}
        onClick={() => void api.syncNow()}
        style={offline ? undefined : { color: "var(--danger)" }}
      >
        {offline ? <CloudOff size={14} /> : <AlertCircle size={14} />} {offline ? "Offline" : "Sync problem"}
      </button>
    );
  }
  // While the sidebar is open its footer shows progress; otherwise a quiet ring here.
  if (sidebarOpen || status.phase !== "backfill") return null;
  return (
    <button
      className="sync-pill"
      title={syncLabel(status)}
      aria-label={syncLabel(status)}
      onClick={() => useStore.setState({ settingsOpen: true })}
    >
      <SyncRing />
    </button>
  );
}

function SearchBox() {
  const search = useStore((s) => s.search);
  const recent = useStore((s) => s.recentSearches);
  const setSearch = useStore((s) => s.setSearch);
  const runRemote = useStore((s) => s.runRemoteSearch);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [people, setPeople] = useState<Contact[]>([]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const remoteTimer = useRef<number>();
  const localTimer = useRef<number>();

  useEffect(() => {
    if (!search) setQ("");
    else if (search.query !== q) setQ(search.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.query]);

  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("post:focus-search", focus);
    return () => window.removeEventListener("post:focus-search", focus);
  }, []);

  // People suggestions for the last typed word (skip operators).
  useEffect(() => {
    const word = q.trim().split(/\s+/).pop() ?? "";
    if (word.length < 2 || word.includes(":")) {
      setPeople([]);
      return;
    }
    const t = window.setTimeout(() => {
      api.suggestContacts(word).then((r) => setPeople(r.slice(0, 4))).catch(() => {});
    }, 120);
    return () => window.clearTimeout(t);
  }, [q]);

  const run = (v: string) => {
    window.clearTimeout(localTimer.current);
    window.clearTimeout(remoteTimer.current);
    setQ(v);
    setSearch(v);
    void runRemote();
    setFocused(false);
    input.current?.blur();
  };

  const onChange = (v: string) => {
    setQ(v);
    setActive(-1);
    window.clearTimeout(localTimer.current);
    window.clearTimeout(remoteTimer.current);
    if (!v.trim()) {
      setSearch(null);
      return;
    }
    localTimer.current = window.setTimeout(() => setSearch(v), 120);
    remoteTimer.current = window.setTimeout(() => void runRemote(), 900);
  };

  const items: { kind: "recent" | "person"; label: string; value: string; c?: Contact }[] = q.trim()
    ? people.map((c) => {
        const words = q.trim().split(/\s+/);
        words[words.length - 1] = `from:${c.email}`;
        return { kind: "person" as const, label: c.name || c.email, value: words.join(" "), c };
      })
    : recent.map((r) => ({ kind: "recent" as const, label: r, value: r }));
  const showPop = focused && items.length > 0;

  return (
    <div className="search-wrap">
      <label className="search">
        <Search size={15} />
        <input
          ref={input}
          value={q}
          placeholder="Search mail"
          spellCheck={false}
          aria-label="Search mail"
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(active >= 0 && items[active] ? items[active].value : q);
            else if (e.key === "Escape") {
              onChange("");
              input.current?.blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (showPop) setActive((a) => Math.min(items.length - 1, a + 1));
              else {
                input.current?.blur();
                useStore.getState().move(0, false);
              }
            } else if (e.key === "ArrowUp" && showPop) {
              e.preventDefault();
              setActive((a) => Math.max(-1, a - 1));
            }
          }}
        />
        {q ? (
          <button className="icon-btn sm" onClick={() => onChange("")} aria-label="Clear search" title="Clear search">
            <X size={14} />
          </button>
        ) : (
          <span className="kbd">/</span>
        )}
      </label>
      {showPop && (
        <div className="search-pop" role="listbox" aria-label="Search suggestions">
          <div className="menu-label">{q.trim() ? "People" : "Recent searches"}</div>
          {items.map((it, i) => (
            <button
              key={it.value}
              role="option"
              aria-selected={i === active}
              className={cx("menu-item", it.kind === "person" && "person", i === active && "active")}
              onMouseDown={(e) => {
                e.preventDefault();
                run(it.value);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {it.c ? (
                <>
                  <Avatar email={it.c.email} name={it.label} size="sm" />
                  <span className="who">
                    <span>Mail from {it.label}</span>
                    {it.c.name && <small>{it.c.email}</small>}
                  </span>
                </>
              ) : (
                <>
                  <Clock size={14} className="faint" />
                  {it.label}
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TitleBar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <button
        className="icon-btn"
        onClick={toggleSidebar}
        title={sidebarOpen ? "Collapse sidebar to icons (Ctrl+B)" : "Expand sidebar (Ctrl+B)"}
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={sidebarOpen}
      >
        <PanelLeft size={17} />
      </button>
      <div className="drag" data-tauri-drag-region />
      <SearchBox />
      <div className="drag" data-tauri-drag-region />
      <SyncIndicator />
      <WindowControls />
    </header>
  );
}
