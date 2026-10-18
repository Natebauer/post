import { useEffect, useRef, useState } from "react";

/**
 * Post's own tooltips in place of the browser's: a small dark label that appears after a short
 * pause, with any shortcut from the title ("Reply (R)", "Bold (Ctrl+B)") drawn as key caps.
 *
 * It works from the existing `title` attributes, so nothing else needs to change. While the
 * pointer is over an element its title moves to data-tip (so the browser's own tooltip stays
 * away) and comes back when the pointer leaves.
 */
interface Tip {
  text: string;
  keys: string[];
  x: number;
  y: number;
  below: boolean;
}

const DELAY = 450;
/** Words that can appear in a shortcut besides single keys. */
const KEY_WORDS = /^(Ctrl|Shift|Alt|Esc|Enter|Space|Tab|Delete|Backspace|Up|Down|Left|Right|F\d{1,2})$/;

/** Splits "Bold (Ctrl+B)" into the label and its keys. Parentheses that aren't a shortcut stay. */
function split(title: string): { text: string; keys: string[] } {
  const first = title.split("\n")[0];
  const m = /\s*\(([^()]{1,24})\)\s*$/.exec(first);
  if (!m) return { text: first, keys: [] };
  const keys = m[1].split(/\+| /).filter(Boolean);
  if (!keys.every((k) => k.length <= 2 || KEY_WORDS.test(k))) return { text: first, keys: [] };
  return { text: first.slice(0, m.index), keys };
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number>();
  const owner = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const restore = () => {
      const el = owner.current;
      if (el && el.dataset.tip !== undefined) {
        el.setAttribute("title", el.dataset.tip);
        delete el.dataset.tip;
      }
      owner.current = null;
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setTip(null);
      restore();
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-tip]");
      if (el === owner.current) return;
      hide();
      if (!el || !el.getAttribute("title")) return;
      // An empty-looking button keeps its title as its accessible name.
      if (!el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", el.title);
      owner.current = el;
      el.dataset.tip = el.title;
      el.removeAttribute("title");
      timer.current = window.setTimeout(() => {
        if (owner.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.bottom + 40 < window.innerHeight;
        setTip({ ...split(el.dataset.tip ?? ""), x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      }, DELAY);
    };
    document.addEventListener("mouseover", over);
    window.addEventListener("mousedown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("mouseover", over);
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Keep the label inside the window.
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return setShift(0);
    const r = el.getBoundingClientRect();
    setShift(r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0);
  }, [tip]);

  if (!tip || (!tip.text && !tip.keys.length)) return null;
  return (
    <div
      ref={ref}
      className={tip.below ? "tooltip below" : "tooltip above"}
      role="tooltip"
      style={{ left: tip.x + shift, top: tip.y }}
    >
      {tip.text && <span>{tip.text}</span>}
      {tip.keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </div>
  );
}
