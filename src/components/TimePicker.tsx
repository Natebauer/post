import { useState } from "react";
import { Calendar, Clock, Coffee, Moon, Sun } from "lucide-react";
import { Popover } from "./Popover";
import { nextAt, nextWeekday } from "../util";

interface Preset {
  label: string;
  at: number;
  icon: JSX.Element;
}

function fmt(ms: number) {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function presets(kind: "snooze" | "schedule"): Preset[] {
  const now = new Date();
  const out: Preset[] = [];
  if (kind === "snooze" && now.getHours() < 17) out.push({ label: "Later today", at: nextAt(0, 18), icon: <Sun size={15} /> });
  if (kind === "schedule" && now.getHours() < 12) out.push({ label: "This afternoon", at: nextAt(0, 13), icon: <Sun size={15} /> });
  out.push({ label: "Tomorrow morning", at: nextAt(1, 8), icon: <Coffee size={15} /> });
  if (kind === "schedule") out.push({ label: "Tomorrow afternoon", at: nextAt(1, 13), icon: <Sun size={15} /> });
  if (kind === "snooze" && now.getDay() >= 1 && now.getDay() <= 4)
    out.push({ label: "This weekend", at: nextWeekday(6, 8), icon: <Moon size={15} /> });
  out.push({ label: "Next week", at: nextWeekday(1, 8), icon: <Calendar size={15} /> });
  return out;
}

function toLocalInput(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TimePicker({
  anchor,
  kind,
  onPick,
  onClose,
  align,
  placement,
}: {
  anchor: HTMLElement | null;
  kind: "snooze" | "schedule";
  onPick: (ms: number) => void;
  onClose: () => void;
  align?: "left" | "right";
  placement?: "below" | "above";
}) {
  const [custom, setCustom] = useState(toLocalInput(nextAt(1, 9)));
  const customMs = new Date(custom).getTime();
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} placement={placement}>
      <div className="menu-label">{kind === "snooze" ? "Snooze until…" : "Schedule send"}</div>
      {presets(kind).map((p) => (
        <button key={p.label} className="menu-item" onClick={() => onPick(p.at)}>
          {p.icon}
          {p.label}
          <span className="hint">{fmt(p.at)}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
        <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button
          className="btn primary"
          style={{ justifyContent: "center" }}
          disabled={!(customMs > Date.now())}
          onClick={() => onPick(customMs)}
        >
          <Clock size={14} />
          {kind === "snooze" ? "Snooze" : "Schedule"}
        </button>
      </div>
    </Popover>
  );
}
