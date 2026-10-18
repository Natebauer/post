import { useState } from "react";
import type React from "react";
import { Calendar, Clock, Coffee, Moon, Sun } from "lucide-react";
import { Popover } from "./Popover";
import { nextAt, nextWeekday } from "../util";

interface Preset {
  label: string;
  at: number;
  icon: JSX.Element;
}

/** The day (Today, Tomorrow or a weekday and date) and the time, shown apart. */
function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  const day =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return { day, time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) };
}

/** A soft color for each kind of moment: morning coffee, afternoon sun, the weekend, next week. */
const TONE: Record<string, string> = {
  "Later today": "#d9822b",
  "This afternoon": "#d9822b",
  "Tomorrow morning": "#a0703c",
  "Tomorrow afternoon": "#d9822b",
  "This weekend": "#6a5acd",
  "Next week": "var(--accent)",
};

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
        <button key={p.label} className="menu-item tp-item" onClick={() => onPick(p.at)} style={{ "--t": TONE[p.label] ?? "var(--accent)" } as React.CSSProperties}>
          <span className="tp-ic">{p.icon}</span>
          {p.label}
          <span className="tp-when">
            <b>{when(p.at).day}</b> {when(p.at).time}
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="tp-custom-label">Pick a date and time</div>
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
