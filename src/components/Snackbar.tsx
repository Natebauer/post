import { useLayoutEffect, useRef } from "react";
import type React from "react";
import {
  AlarmClock,
  AlertCircle,
  Archive,
  Check,
  Copy,
  Download,
  Inbox,
  MailOpen,
  OctagonAlert,
  Pin,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "../store";
import { motionEase, motionMs, reduceMotion } from "../motionTokens";

export function Snackbar() {
  const snacks = useStore((s) => s.snacks);
  const drop = useStore((s) => s.dropSnack);
  // When one arrives or leaves, the others glide to their new places instead of jumping.
  const ref = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const now = new Map<string, number>();
    ref.current?.querySelectorAll<HTMLElement>("[data-snack]").forEach((el) => {
      const top = el.getBoundingClientRect().top;
      now.set(el.dataset.snack!, top);
      const before = tops.current.get(el.dataset.snack!);
      if (before !== undefined && Math.abs(before - top) > 0.5 && !reduceMotion())
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
          duration: motionMs("slow"),
          easing: motionEase("ease-move"),
          composite: "add",
        });
    });
    tops.current = now;
  }, [snacks]);
  return (
    <div className="snacks" role="status" aria-live="polite" ref={ref}>
      {snacks.map((s) => (
        <div key={s.id} data-snack={s.id} className={s.leaving ? "snack leaving" : "snack"}>
          {s.icon === "sending" ? <SendRing ms={s.ms ?? 3000} /> : <SnackIcon text={s.text} />}
          <span>{s.text}</span>
          {s.action && (
            <button
              className="act"
              onClick={() => {
                drop(s.id);
                s.action!.run();
              }}
            >
              {s.action.label}
            </button>
          )}
          <button className="icon-btn sm x" onClick={() => drop(s.id)} aria-label="Dismiss" style={s.action ? undefined : { marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Runs down while the send can still be undone, then a check draws itself just before the
    snackbar goes. */
function SendRing({ ms }: { ms: number }) {
  return (
    <svg className="send-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden style={{ "--dur": `${ms - 500}ms` } as React.CSSProperties}>
      <circle className="track" cx="10" cy="10" r="8" />
      <circle className="run" cx="10" cy="10" r="8" pathLength={100} />
      <path className="tick" d="m6.5 10.2 2.4 2.4 4.6-5" pathLength={100} />
    </svg>
  );
}

// What happened, as a small icon at the front of the toast: read from its words, so every toast
// gets one without each caller choosing.
const ICONS: [RegExp, ReactNode][] = [
  [/couldn't|failed|not saved|too late|didn't|can run programs/i, <AlertCircle size={15} />],
  [/trash|discard|deleted/i, <Trash2 size={15} />],
  [/unstarred|star/i, <Star size={15} />],
  [/pin/i, <Pin size={15} />],
  [/snooz/i, <AlarmClock size={15} />],
  [/archiv/i, <Archive size={15} />],
  [/spam/i, <OctagonAlert size={15} />],
  [/back to inbox/i, <Inbox size={15} />],
  [/marked as (read|unread)/i, <MailOpen size={15} />],
  [/copied/i, <Copy size={15} />],
  [/saved .*\.|attachment/i, <Download size={15} />],
  [/undone|nothing to undo/i, <RotateCcw size={15} />],
  [/saved|sent|added|connected|removed|rsvp/i, <Check size={15} />],
];

function SnackIcon({ text }: { text: string }) {
  const hit = ICONS.find(([re]) => re.test(text));
  if (!hit) return null;
  const bad = hit[0] === ICONS[0][0];
  return <span className={bad ? "snack-ic bad" : "snack-ic"}>{hit[1]}</span>;
}
