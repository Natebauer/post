import { useEffect, useId, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, CloudOff, Copy, Minus, PanelLeft, Square, X } from "lucide-react";
import { api, type SyncStatus } from "../api";
import { useStore } from "../store";
import { toggleSidebar } from "../actions";
import { cx } from "../util";

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
        className={cx("sync-pill", "sync-issue", offline ? "offline" : "problem")}
        title={`${status.error}\n\nClick to retry now.`}
        onClick={() => void api.syncNow()}
      >
        {offline ? <CloudOff size={14} /> : <AlertCircle size={14} />} {offline ? "Offline" : "Sync problem"}
        <span className="sync-retry">Retry</span>
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
      <SyncIndicator />
      <WindowControls />
    </header>
  );
}

/** The app icon's stamp, in the current accent color so it follows the mood. */
export function StampMark({ size = 18 }: { size?: number }) {
  const id = `stamp-perf-${useId().replace(/:/g, "")}`;
  const holes = [2, 6.5, 11, 15.5, 20];
  return (
    <svg className="stamp" width={size} height={size} viewBox="0 0 22 22" data-tauri-drag-region aria-hidden>
      <mask id={id}>
        <rect width="22" height="22" fill="#fff" />
        {holes.map((p) => (
          <g key={p} fill="#000">
            <circle cx={p} cy="1" r="1.15" />
            <circle cx={p} cy="21" r="1.15" />
            <circle cx="1" cy={p} r="1.15" />
            <circle cx="21" cy={p} r="1.15" />
          </g>
        ))}
      </mask>
      <rect x="1" y="1" width="20" height="20" fill="var(--accent)" mask={`url(#${id})`} />
      <path fill="var(--accent-ink)" d="M9.3 16.3H6.9V6.9h3.9q1.1 0 1.9.3.8.3 1.3 1 .5.7.5 2 0 1.1-.5 1.9-.5.8-1.4 1.1-.9.4-1.9.4H9.3Zm0-7.2v2.4h1.4q.7 0 1.1-.3.4-.3.4-1 0-.5-.3-.8-.4-.3-1.2-.3Z" />
    </svg>
  );
}
