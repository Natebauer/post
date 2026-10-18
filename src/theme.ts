import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./api";
import { applyMood, KEYS, moodById, nextAutoChange, paletteFor } from "./moods";
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

/**
 * Apply theme, mood and accent to the document and the native window (title bar colors).
 * `slow`: the change happened on its own (Auto turning over), so it fades in gently over a few
 * seconds instead of the quick fade that answers a click.
 */
export function applyTheme(s: Settings | null, { slow = false }: { slow?: boolean } = {}) {
  const t = resolvedTheme(s);
  const root = document.documentElement;
  // When the look changes, every color switches together (no hover colors trailing behind; see
  // 01-base.css). Other settings re-apply the theme too, and leave motion alone.
  const look = `${t}|${s?.mood ?? ""}|${moodById(s?.mood).id}|${s?.accent ?? ""}|${s?.windowColor ?? ""}`;
  const changed = look !== lastLook && !!lastLook;
  if (look !== lastLook) {
    if (lastLook) {
      root.classList.add("theme-switching");
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    }
    lastLook = look;
  }
  // A new look cross-fades from the old one (a view transition), unless motion is reduced.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (changed && doc.startViewTransition && !reduceMotion()) {
    if (slow) root.classList.add("look-slow");
    const vt = doc.startViewTransition(() => paint(s, t));
    vt.finished.finally(() => root.classList.remove("look-slow"));
  } else paint(s, t);
}

function paint(s: Settings | null, t: "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = t;
  applyMood(root, s?.mood, t);
  paintWindow(s, t);
  const accent = s?.accent || moodById(s?.mood).accent || DEFAULT_ACCENT;
  // Auto changes mood through the day: re-apply when it next turns over.
  window.clearTimeout(autoTimer);
  if (s?.mood === "auto")
    autoTimer = window.setTimeout(() => applyTheme(s, { slow: true }), nextAutoChange().getTime() - Date.now() + 1000);
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

/** The parts of Post drawn straight on the window background rather than on a card. */
const ON_WINDOW = ":root[data-wscheme] :is(.titlebar, .sidebar, .read-pane.bare, .setup)";

/**
 * A custom window background (Settings, Appearance). Whatever sits directly on it (the title bar,
 * the sidebar, Home) takes light or dark colors to suit that background, even when the rest of
 * Post is in the other theme: a dark background gets light text in light mode, and a pale one
 * gets dark text in dark mode. The cards (inbox, email) keep the theme.
 */
function paintWindow(s: Settings | null, t: "light" | "dark") {
  const root = document.documentElement;
  const color = /^#[0-9a-f]{6}$/i.test(s?.windowColor ?? "") ? s!.windowColor : "";
  let scheme = t;
  if (color) {
    root.style.setProperty("--window-base", color);
    // The mood's tint would otherwise wash over the chosen color.
    root.style.setProperty("--chrome", "transparent");
    // Dark text reads better on it, or light text: whichever has more contrast.
    scheme = luminance(color) < 0.179 ? "dark" : "light";
  } else root.style.removeProperty("--window-base");
  root.dataset.wscheme = scheme;

  let style = document.getElementById("post-window-scope") as HTMLStyleElement | null;
  if (scheme === t) {
    style?.remove();
    return;
  }
  const p = paletteFor(s?.mood, scheme);
  const vars = KEYS.filter((k) => k !== "chrome")
    .map((k) => `--${k}: ${p[k]};`)
    .join(" ");
  const avC = moodById(s?.mood).id === "mono" ? "0" : scheme === "dark" ? "0.04" : "0.045";
  const extra =
    scheme === "dark"
      ? `--accent-text: color-mix(in srgb, var(--accent) 68%, white); --av-bg-l: 33%; --av-ink-l: 86%; --av-c: ${avC}; color-scheme: dark;`
      : `--accent-text: color-mix(in srgb, var(--accent) 82%, black); --av-bg-l: 91%; --av-ink-l: 42%; --av-c: ${avC}; color-scheme: light;`;
  if (!style) {
    style = document.createElement("style");
    style.id = "post-window-scope";
    document.head.appendChild(style);
  }
  // Text color is inherited as a value, not a variable, so these areas set their own.
  style.textContent = `${ON_WINDOW} { ${vars} ${extra} color: var(--text); }`;
}

/** Relative luminance of a #rrggbb color (0 black to 1 white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Relative luminance above which white text stops being readable on a color. */
function isLight(hex: string): boolean {
  return /^#?[0-9a-f]{6}$/i.test(hex.trim()) && luminance(hex) > 0.4;
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

/** Window backgrounds offered in Settings: pale ones, then dark ones ("" is the mood's own). */
export const WINDOW_COLORS: { name: string; value: string }[] = [
  { name: "Linen", value: "#ece4d6" },
  { name: "Sage", value: "#d9e2d6" },
  { name: "Sky", value: "#d6e1ec" },
  { name: "Lilac", value: "#e2dcee" },
  { name: "Blush", value: "#eedcdf" },
  { name: "Slate", value: "#46525e" },
  { name: "Pine", value: "#27372f" },
  { name: "Charcoal", value: "#232427" },
  { name: "Midnight", value: "#18203a" },
];
