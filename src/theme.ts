import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./api";
import { applyMood, KEYS, moodById, nextAutoChange, paletteFor, setAutoSchedule, type CardStyle } from "./moods";
import { reduceMotion } from "./motionTokens";

/** Post's teal, the app icon's color. */
export const DEFAULT_ACCENT = "#2a737b";

const media = window.matchMedia("(prefers-color-scheme: dark)");

// Windows' own light or dark setting. Post pins the window's theme for a dark mood or a Light or
// Dark Theme setting (paint below), and while it's pinned the page reports the pinned theme as
// the system's. So the system's is remembered from when the window follows it, and only updated
// then; otherwise, after a dark mood, light moods (and their previews) would briefly read as dark.
let windowPinned = false;
let systemDark = media.matches;
media.addEventListener("change", () => {
  if (!windowPinned) systemDark = media.matches;
});

export function resolvedTheme(s: Settings | null): "light" | "dark" {
  // Dark moods are dark whatever the Theme setting says.
  if (moodById(s?.mood).scheme === "dark") return "dark";
  if (s?.theme === "light" || s?.theme === "dark") return s.theme;
  return systemDark ? "dark" : "light";
}

let lastLook = "";
let autoTimer: number | undefined;

/**
 * Apply theme, mood and accent to the document and the native window (title bar colors).
 * `slow`: the change happened on its own (Auto turning over), so it fades in gently over a few
 * seconds instead of the quick fade that answers a click.
 */
export function applyTheme(s: Settings | null, { slow = false }: { slow?: boolean } = {}) {
  setAutoSchedule(s?.autoDarkStart ?? 21 * 60, s?.autoDarkEnd ?? 5 * 60);
  const t = resolvedTheme(s);
  const root = document.documentElement;
  // When the look changes, every color switches together (no hover colors trailing behind; see
  // 01-base.css). Other settings re-apply the theme too, and leave motion alone.
  const look = `${t}|${s?.mood ?? ""}|${moodById(s?.mood).id}|${s?.accent ?? ""}|${s?.windowColor ?? ""}|${!!s?.cardTint}|${!!s?.cardClear}|${!!s?.cardFrost}`;
  // (A new dark time that changes Auto's mood right now changes `look` too, so it fades.)
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
  // The season's pattern behind the panes, when turned on.
  if (s?.seasonal) root.dataset.season = season();
  else delete root.dataset.season;
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
    const pin = forced ? "dark" : s?.theme === "system" || !s ? null : s.theme;
    // Unpinned, the window follows the system again, and any change after that is the system's.
    const win = getCurrentWindow();
    if (pin) windowPinned = true;
    void win
      .setTheme(pin)
      .then(() => {
        if (!pin) windowPinned = false;
      });
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
  const stops = windowStops(s?.windowColor);
  // A gradient's middle stands in for it wherever one flat color is needed (rings, contrast).
  const color = stops.length ? mixHex(stops) : "";
  let scheme = t;
  if (stops.length > 1) root.style.setProperty("--window-bg", `linear-gradient(150deg, ${stops.join(", ")})`);
  else root.style.removeProperty("--window-bg");
  if (color) {
    root.style.setProperty("--window-base", color);
    // The mood's tint would otherwise wash over the chosen color.
    root.style.setProperty("--chrome", "transparent");
    // Dark text reads better on it, or light text: whichever has more contrast.
    scheme = luminance(color) < 0.179 ? "dark" : "light";
  } else root.style.removeProperty("--window-base");
  root.dataset.wscheme = scheme;
  // With the mood's own background, the card styles work from the mood's backdrop instead.
  tintCard(s, t, color || moodBackdrop(s, t), scheme);

  let style = document.getElementById("post-window-scope") as HTMLStyleElement | null;
  if (scheme === t) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "post-window-scope";
    document.head.appendChild(style);
  }
  // Text color is inherited as a value, not a variable, so these areas set their own.
  style.textContent = `${ON_WINDOW} { ${schemeVars(s, scheme)} color: var(--text); }`;
}

/** The mood's colors for one scheme, as CSS variables, for an area that differs from the rest. */
function schemeVars(s: Settings | null, scheme: "light" | "dark"): string {
  const p = paletteFor(s?.mood, scheme);
  const vars = KEYS.filter((k) => k !== "chrome")
    .map((k) => `--${k}: ${p[k]};`)
    .join(" ");
  const avC = moodById(s?.mood).id === "mono" ? "0" : scheme === "dark" ? "0.04" : "0.045";
  const extra =
    scheme === "dark"
      ? `--accent-text: color-mix(in srgb, var(--accent) 68%, white); --av-bg-l: 33%; --av-ink-l: 86%; --av-c: ${avC}; color-scheme: dark;`
      : `--accent-text: color-mix(in srgb, var(--accent) 82%, black); --av-bg-l: 91%; --av-ink-l: 42%; --av-c: ${avC}; color-scheme: light;`;
  return `${vars} ${extra}`;
}

/**
 * "Tint the inbox card": the card's surfaces take on a little of the window background, so a
 * colored or gradient window doesn't leave the card stark white. The surfaces stay solid, so the
 * text keeps its contrast. A pale background on a light card (or a dark one on a dark card) mixes
 * in more, since it's close to the card already; the opposite mixes in just a whisper.
 */
function tintCard(s: Settings | null, t: "light" | "dark", color: string, scheme: "light" | "dark") {
  let style = document.getElementById("post-card-tint") as HTMLStyleElement | null;
  if (!color || !(s?.cardTint || s?.cardClear || s?.cardFrost)) {
    style?.remove();
    return;
  }
  if (s.cardClear || s.cardFrost) {
    // "Clear": the card is mostly see-through, a faint veil of its surface over the background.
    // "Frost": a thin white veil instead, so the card just brightens what's behind it (a whisper
    // on a deep background, more on a pale one, where a little white wouldn't show). Either way
    // it takes the background's own light or dark colors, so its text reads on it.
    const p = paletteFor(s.mood, scheme);
    const frost = !s.cardClear;
    const white = scheme === "dark" ? 6 : 35;
    const veil = (k: "surface" | "surface-2" | "surface-3" | "tint-base", pct: number) =>
      frost
        ? `--${k}: color-mix(in srgb, #fff ${Math.round(white * (pct / 14))}%, transparent);`
        : `--${k}: color-mix(in srgb, ${p[k]} ${pct}%, transparent);`;
    if (!style) {
      style = document.createElement("style");
      style.id = "post-card-tint";
      document.head.appendChild(style);
    }
    style.textContent =
      `:is(.list-pane, .bgp-card) { ${scheme === t ? "" : schemeVars(s, scheme)} ` +
      `${veil("surface", 14)} ${veil("surface-2", 22)} ${veil("surface-3", 30)} ${veil("tint-base", 18)} ` +
      // The open email's row: a see-through wash of the accent (the usual one is mixed with white).
      `--selected-bg: color-mix(in srgb, var(--accent) ${scheme === "dark" ? 30 : 16}%, transparent); color: var(--text); }`;
    return;
  }
  const p = paletteFor(s?.mood, t);
  const pct = scheme === t ? 40 : 9;
  const mix = (k: "surface" | "surface-2" | "surface-3" | "elevated" | "tint-base") =>
    `--${k}: color-mix(in srgb, ${color} ${pct}%, ${p[k]});`;
  if (!style) {
    style = document.createElement("style");
    style.id = "post-card-tint";
    document.head.appendChild(style);
  }
  style.textContent = `:is(.list-pane, .bgp-card) { ${mix("surface")} ${mix("surface-2")} ${mix("surface-3")} ${mix("elevated")} ${mix("tint-base")} }`;
}

/** A window background setting's colors: one for a flat color, two or three for a gradient
    ("#d3e6ee>#d8eee0"). Anything else is the mood's own background (no colors). */
export function windowStops(v: string | undefined | null): string[] {
  const stops = (v ?? "").split(">").map((x) => x.trim().toLowerCase());
  return stops.length <= 3 && stops.every((x) => /^#[0-9a-f]{6}$/.test(x)) ? stops : [];
}

/** The mood's own window color as one #rrggbb: its tint laid over the base (01-base.css). */
function moodBackdrop(s: Settings | null, t: "light" | "dark"): string {
  const base = t === "dark" ? [0x20, 0x20, 0x23] : [0xe4, 0xe4, 0xe1];
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(paletteFor(s?.mood, t).chrome);
  if (!m) return "#" + base.map((v) => v.toString(16).padStart(2, "0")).join("");
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return "#" + base.map((v, i) => Math.round(Number(m[i + 1]) * a + v * (1 - a)).toString(16).padStart(2, "0")).join("");
}

/** The inbox card style a Settings holds (its three switches, as one choice). */
export function cardOf(s: Settings | null): CardStyle {
  return s?.cardClear ? "clear" : s?.cardFrost ? "frost" : s?.cardTint ? "tinted" : "white";
}

/** The Settings fields for an inbox card style. */
export function cardPatch(c: CardStyle): Pick<Settings, "cardTint" | "cardFrost" | "cardClear"> {
  return { cardTint: c === "tinted", cardFrost: c === "frost", cardClear: c === "clear" };
}

/** The even mix of some #rrggbb colors. */
export function mixHex(hexes: string[]): string {
  const ch = (i: number) =>
    Math.round(hexes.reduce((n, h) => n + parseInt(h.slice(1 + i * 2, 3 + i * 2), 16), 0) / hexes.length);
  return "#" + [0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}

/** A flat background blended into a soft gradient: it drifts toward a neighboring hue, a touch
    more colorful, at the same lightness, so text that reads on one end reads on the other. */
export function blendWindow(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const s2 = Math.min(1, Math.max(sat * 1.6, 0.34));
  // Warm colors lean toward rose, cool ones toward violet.
  const h2 = ((h * 60 + (h * 60 < 90 || h * 60 > 300 ? -50 : 55)) % 360 + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s2;
  const x = c * (1 - Math.abs(((h2 / 60) % 2) - 1));
  const m = l - c / 2;
  const [r2, g2, b2] =
    h2 < 60 ? [c, x, 0] : h2 < 120 ? [x, c, 0] : h2 < 180 ? [0, c, x] : h2 < 240 ? [0, x, c] : h2 < 300 ? [x, 0, c] : [c, 0, x];
  const to = "#" + [r2, g2, b2].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
  return `${hex.toLowerCase()}>${to}`;
}

/** Relative luminance of a #rrggbb color (0 black to 1 white). */
export function luminance(hex: string): number {
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

/** Gradient window backgrounds offered in Settings: soft pale ones, then deep ones. Each end
    keeps about the same lightness, so the text on it reads the same all the way across. */
export const WINDOW_GRADIENTS: { name: string; value: string; deep?: boolean }[] = [
  { name: "Dawn", value: "#f2dfd3>#e2daf0" },
  { name: "Lagoon", value: "#d2e4ee>#d6ede0" },
  { name: "Meadow", value: "#e5e9d0>#d3e5dc" },
  { name: "Orchid", value: "#e4daf1>#f0dbe3" },
  { name: "Sorbet", value: "#f3e4c8>#f0d6d9" },
  { name: "Dusk", value: "#373350>#56394b", deep: true },
  { name: "Aurora", value: "#1c3a3a>#1f2a4a", deep: true },
  { name: "Ember", value: "#2e2127>#47291f", deep: true },
  { name: "Deep sea", value: "#13233a>#1c3b42", deep: true },
];

/** The season now (northern hemisphere): spring from March, summer June, autumn September, winter December. */
function season(d = new Date()): "spring" | "summer" | "autumn" | "winter" {
  const m = d.getMonth();
  return m >= 2 && m < 5 ? "spring" : m >= 5 && m < 8 ? "summer" : m >= 8 && m < 11 ? "autumn" : "winter";
}
