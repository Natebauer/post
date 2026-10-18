import { useEffect, useLayoutEffect, useState } from "react";
import type React from "react";
import { exitMs } from "./store";

/** Keep something mounted briefly after `open` turns false so it can animate out. */
export function usePresence(open: boolean, ms = exitMs()): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** Words worth highlighting from a search query (drops operators like from:, has:). */
export function searchTerms(q: string | undefined | null): string[] {
  if (!q) return [];
  const out: string[] = [];
  for (const raw of q.match(/"[^"]+"|\S+/g) ?? []) {
    const t = raw.replace(/^"|"$/g, "");
    const m = t.match(/^(from|to|cc|subject):(.+)$/i);
    if (m) {
      if (m[1].toLowerCase() === "subject") out.push(m[2]);
      continue;
    }
    if (/^\w+:/.test(t) || t.length < 2) continue;
    out.push(t);
  }
  return out;
}

export function highlightRegex(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${esc.join("|")})`, "gi");
}

/**
 * Keep keyboard focus inside a dialog while it's open (Tab and Shift+Tab wrap around), and give
 * focus back to whatever had it before when the dialog closes.
 */
export function useDialogFocus(ref: React.RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[autofocus], input, textarea, button, [tabindex]:not([tabindex='-1'])");
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(
        ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex='-1'])"),
      ).filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/**
 * Where a highlight should sit to cover the element matching `selector` inside `ref`, for a
 * highlight that glides from one item to the next instead of jumping. Measured again whenever
 * `deps` change or the container resizes; the first placement doesn't animate.
 */
export function useGlide(ref: React.RefObject<HTMLElement>, selector: string, deps: unknown[]): React.CSSProperties | null {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) return setBox(null);
      setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const t = window.setTimeout(() => setMoving(true), 80);
    return () => window.clearTimeout(t);
  }, []);
  if (!box) return null;
  return {
    transform: `translate(${box.x}px, ${box.y}px)`,
    width: box.w,
    height: box.h,
    transition: moving ? undefined : "none",
  };
}
