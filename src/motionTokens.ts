/**
 * Motion timings and curves live once, as tokens in the stylesheet (01-base.css). Code that
 * times something against a CSS animation, or animates from script, reads them from there so the
 * two can't drift apart.
 */

const FALLBACK_MS: Record<string, number> = {
  "pane-in": 170,
  "pane-out": 170,
  fast: 120,
  med: 170,
  slow: 220,
  "fast-out": 90,
  "med-out": 130,
  "slow-out": 170,
  emphasis: 420,
  highlight: 900,
};

const msCache = new Map<string, number>();
const token = (name: string) =>
  typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/** A duration token in milliseconds, e.g. motionMs("med-out"). */
export function motionMs(name: keyof typeof FALLBACK_MS | string): number {
  let v = msCache.get(name);
  if (v === undefined) {
    const raw = token(name);
    const n = parseFloat(raw);
    v = Number.isFinite(n) ? (raw.endsWith("ms") ? n : n * 1000) : (FALLBACK_MS[name] ?? 0);
    msCache.set(name, v);
  }
  return v;
}

/** A curve token for the Web Animations API: "ease" (entering), "ease-in" (leaving), "ease-move". */
export function motionEase(name: "ease" | "ease-in" | "ease-move"): string {
  return token(name) || "ease";
}

/**
 * Longest an email waits to finish drawing before it's shown anyway (opening, or switching from
 * another). Long enough to skip half-loaded flashes, short enough not to feel like a pause.
 */
export const READY_WAIT_MS = 200;

export const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** "smooth" unless the person has asked for less motion. */
export const scrollBehavior = (): ScrollBehavior => (reduceMotion() ? "auto" : "smooth");
