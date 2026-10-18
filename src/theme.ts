import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./api";
import { applyMood, moodById, nextAutoChange } from "./moods";
import { reduceMotion } from "./motionTokens";

/** Post's teal, the app icon's color. */
export const DEFAULT_ACCENT = "#2a737b";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function resolvedTheme(s: Settings | null): "light" | "dark" {
  // Dark moods are dark whatever the Theme setting says.
  if (moodById(s?.mood).scheme === "dark") return "dark";
  if (s?.theme === "light" || s?.theme === "dark") return s.theme;
  return media.matches ? "dark" : "light";
}

let lastLook = "";
let autoTimer: number | undefined;

/** Apply theme, mood and accent to the document and the native window (title bar colors). */
export function applyTheme(s: Settings | null) {
  const t = resolvedTheme(s);
  const root = document.documentElement;
  // When the look changes, every color switches together (no hover colors trailing behind; see
  // 01-base.css). Other settings re-apply the theme too, and leave motion alone.
  const look = `${t}|${s?.mood ?? ""}|${moodById(s?.mood).id}|${s?.accent ?? ""}`;
  const changed = look !== lastLook && !!lastLook;
  if (look !== lastLook) {
    if (lastLook) {
      root.classList.add("theme-switching");
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    }
    lastLook = look;
  }
  // A new look cross-fades from the old one (a view transition), unless motion is reduced.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (changed && doc.startViewTransition && !reduceMotion()) doc.startViewTransition(() => paint(s, t));
  else paint(s, t);
}

function paint(s: Settings | null, t: "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = t;
  applyMood(root, s?.mood, t);
  const accent = s?.accent || moodById(s?.mood).accent || DEFAULT_ACCENT;
  // Auto changes mood through the day: re-apply when it next turns over.
  window.clearTimeout(autoTimer);
  if (s?.mood === "auto") autoTimer = window.setTimeout(() => applyTheme(s), nextAutoChange().getTime() - Date.now() + 1000);
  root.style.setProperty("--accent", accent);
  // Text on the accent (buttons, badges) is dark when the accent is light, so it stays readable.
  root.style.setProperty("--accent-ink", isLight(accent) ? "#1b1c1f" : "#ffffff");
  root.style.setProperty("--av-l", t === "dark" ? "30%" : "88%");
  root.style.setProperty("--av-t", t === "dark" ? "82%" : "32%");
  try {
    const forced = moodById(s?.mood).scheme === "dark";
    void getCurrentWindow().setTheme(forced ? "dark" : s?.theme === "system" || !s ? null : s.theme);
  } catch {
    /* not in tauri */
  }
}

/** Relative luminance above which white text stops being readable on a color. */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4;
}

export function onSystemThemeChange(cb: () => void) {
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
}

export const ACCENTS: { name: string; value: string }[] = [
  { name: "Post teal", value: DEFAULT_ACCENT },
  { name: "Periwinkle", value: "#5b74e8" },
  { name: "Slate", value: "#5f7387" },
  { name: "Sage", value: "#4f8a6e" },
  { name: "Plum", value: "#8a5aa8" },
  { name: "Rose", value: "#c25579" },
  { name: "Terracotta", value: "#c0663f" },
  { name: "Amber", value: "#b7852a" },
];
