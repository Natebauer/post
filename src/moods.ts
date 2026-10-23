/**
 * Moods: whole-app looks chosen in Settings → Appearance. Each sets the window tint, surfaces, text,
 * borders and avatar colors for light and dark, plus a matching accent (picking a mood sets the
 * accent; it can still be changed afterwards) and optionally a heading typeface.
 *
 * Classic has no overrides: it is the palette in styles/01-base.css. Dark moods (scheme: "dark") are made for
 * dark mode only and keep the app dark whatever the Theme setting is; White (scheme: "light") is its
 * mirror, light only, and keeps the app light.
 */

/** The color variables a mood sets (names match the CSS variables, without the leading "--"). */
export interface MoodPalette {
  chrome: string; // window background tint (over a fixed base color)
  surface: string;
  "surface-2": string;
  "surface-3": string;
  elevated: string;
  text: string;
  "text-2": string;
  "text-3": string;
  border: string;
  "border-strong": string;
  hover: string;
  press: string;
  "avatar-bg": string;
  "avatar-ink": string;
  "tint-base": string;
}

export interface Mood {
  id: string;
  name: string;
  blurb: string;
  accent: string;
  /** Heading typeface (conversation subjects, list and module titles). */
  display?: string;
  /** Body face for plain-text emails; defaults to the UI face. */
  read?: string;
  /** "dark": a dark-only mood. It stays dark whatever the Theme setting says. "light": the same, light only. */
  scheme?: "dark" | "light";
  light?: MoodPalette;
  dark?: MoodPalette;
}

const tint = (rgb: string, a: [number, number, number, number]) => ({
  border: `rgba(${rgb}, ${a[0]})`,
  "border-strong": `rgba(${rgb}, ${a[1]})`,
  hover: `rgba(${rgb}, ${a[2]})`,
  press: `rgba(${rgb}, ${a[3]})`,
});
const LIGHT_A: [number, number, number, number] = [0.1, 0.17, 0.045, 0.085];
const DARK_A: [number, number, number, number] = [0.08, 0.14, 0.05, 0.09];

/** How the inbox card sits on the window (Settings, Appearance). */
export type CardStyle = "white" | "tinted" | "frost" | "clear";

/** A mood's suggested background ("" = its own backdrop, else as in Settings.windowColor) and card. */
export interface MoodLook {
  bg: string;
  card: CardStyle;
}

/** Each mood's suggested look, for light and for dark (dark-only moods only have dark). Picking a
    mood applies the one for the theme Post is in right then. Moods not listed keep their own
    backdrop and a white card. */
const LOOKS: Record<string, { light?: MoodLook; dark?: MoodLook }> = {
  paper: { light: { bg: "#ece4d6", card: "tinted" } },
  slate: { light: { bg: "#d6e1ec", card: "white" } },
  forest: { light: { bg: "#e5e9d0>#d3e5dc", card: "tinted" }, dark: { bg: "#27372f", card: "tinted" } },
  sand: { light: { bg: "#f3e4c8>#f0d6d9", card: "tinted" }, dark: { bg: "#2e2127>#47291f", card: "frost" } },
  dusk: { light: { bg: "#e4daf1>#f0dbe3", card: "frost" }, dark: { bg: "#373350>#56394b", card: "frost" } },
  rose: { light: { bg: "#eedcdf", card: "tinted" } },
  midnight: { light: { bg: "#d2e4ee>#d6ede0", card: "white" }, dark: { bg: "#13233a>#1c3b42", card: "clear" } },
  graphite: { dark: { bg: "#232427", card: "frost" } },
  abyss: { dark: { bg: "#13233a>#1c3b42", card: "clear" } },
  ember: { dark: { bg: "#2e2127>#47291f", card: "frost" } },
  aurora: { dark: { bg: "#1c3a3a>#1f2a4a", card: "clear" } },
};

const PLAIN: MoodLook = { bg: "", card: "white" };

/** The look a mood suggests in a theme (a dark-only mood always uses its dark one). */
export function lookFor(id: string | undefined, theme: "light" | "dark"): MoodLook {
  const l = LOOKS[id ?? ""];
  if (!l) return PLAIN;
  return (moodById(id).scheme === "dark" || theme === "dark" ? l.dark : l.light) ?? PLAIN;
}

/** Every look a mood suggests (light and dark), to tell whether the current one is its own. */
export function looksOf(id: string | undefined): MoodLook[] {
  const l = LOOKS[id ?? ""];
  return l ? [l.light ?? PLAIN, l.dark ?? PLAIN] : [PLAIN];
}

export const MOODS: Mood[] = [
  { id: "classic", name: "Classic", blurb: "Post's original: neutral and calm, with Post teal.", accent: "#2a737b" },
  // Follows the time of day (autoMoodId); its colors and accent are whichever mood is current.
  { id: "auto", name: "Auto", blurb: "Follows the day: cool in the morning, Classic by day, warm in the evening and dark at night, at the times you choose.", accent: "" },
  // As white as it gets: the window, sidebar and cards all white, set apart by hairlines. Light only.
  {
    id: "white",
    name: "White",
    blurb: "As white as it gets: white window, sidebar and cards, with Post teal. Always light.",
    accent: "#2a737b",
    scheme: "light",
    light: {
      chrome: "rgba(255, 255, 255, 1)", surface: "#ffffff", "surface-2": "#fafafa", "surface-3": "#f2f2f2", elevated: "#ffffff",
      text: "#141414", "text-2": "#4d4d4d", "text-3": "#757575", ...tint("0, 0, 0", [0.08, 0.14, 0.04, 0.075]),
      "avatar-bg": "#f1f1f1", "avatar-ink": "#555555", "tint-base": "#ffffff",
    },
  },
  {
    id: "paper",
    name: "Paper",
    blurb: "Warm off-white paper with ink-blue accents.",
    accent: "#33598a",
    light: {
      chrome: "rgba(244, 239, 228, 0.72)", surface: "#fffdf8", "surface-2": "#f7f2e8", "surface-3": "#ece5d7", elevated: "#fffdf8",
      text: "#2a2621", "text-2": "#5e564b", "text-3": "#766c5f", ...tint("60, 45, 20", [0.1, 0.18, 0.05, 0.09]),
      "avatar-bg": "#ece4d4", "avatar-ink": "#6b5f4c", "tint-base": "#f6f0e4",
    },
    dark: {
      chrome: "rgba(30, 27, 23, 0.6)", surface: "#24211d", "surface-2": "#2b2722", "surface-3": "#35302a", elevated: "#2e2a24",
      text: "#efe8dc", "text-2": "#c3b9a8", "text-3": "#9a8f7d", ...tint("255, 240, 210", DARK_A),
      "avatar-bg": "#3a342c", "avatar-ink": "#cbbfa9", "tint-base": "#26231f",
    },
  },
  {
    id: "slate",
    name: "Slate",
    blurb: "Cool blue-gray, crisp and focused.",
    accent: "#4f6b8a",
    light: {
      chrome: "rgba(226, 232, 240, 0.7)", surface: "#ffffff", "surface-2": "#f3f6f9", "surface-3": "#e6ebf1", elevated: "#ffffff",
      text: "#18202b", "text-2": "#4b5868", "text-3": "#627085", ...tint("20, 40, 70", [0.09, 0.16, 0.045, 0.08]),
      "avatar-bg": "#e2e8ef", "avatar-ink": "#4b5868", "tint-base": "#f2f5f8",
    },
    dark: {
      chrome: "rgba(22, 27, 34, 0.6)", surface: "#1a2028", "surface-2": "#202733", "surface-3": "#2a3240", elevated: "#232b37",
      text: "#e6ecf3", "text-2": "#a9b4c2", "text-3": "#8592a3", ...tint("200, 220, 255", DARK_A),
      "avatar-bg": "#2c3542", "avatar-ink": "#b4c0cf", "tint-base": "#1d232c",
    },
  },
  {
    id: "forest",
    name: "Forest",
    blurb: "Soft sage greens with a deep green accent. Quiet and grounded.",
    accent: "#2f7a55",
    light: {
      chrome: "rgba(228, 236, 228, 0.7)", surface: "#fdfefc", "surface-2": "#f2f6f1", "surface-3": "#e3ebe2", elevated: "#ffffff",
      text: "#1c241e", "text-2": "#4d5c51", "text-3": "#627267", ...tint("30, 60, 35", LIGHT_A),
      "avatar-bg": "#e1eadf", "avatar-ink": "#4d5c51", "tint-base": "#f1f5ef",
    },
    dark: {
      chrome: "rgba(20, 27, 22, 0.6)", surface: "#1a211c", "surface-2": "#202922", "surface-3": "#29342c", elevated: "#232c25",
      text: "#e5eee6", "text-2": "#a9b8ab", "text-3": "#869789", ...tint("210, 255, 220", [0.07, 0.13, 0.05, 0.085]),
      "avatar-bg": "#2b372e", "avatar-ink": "#b3c4b5", "tint-base": "#1c231e",
    },
  },
  {
    id: "sand",
    name: "Sand",
    blurb: "Warm beige and amber, like late-afternoon light.",
    accent: "#b0742a",
    light: {
      chrome: "rgba(240, 232, 218, 0.72)", surface: "#fffcf6", "surface-2": "#f8f1e5", "surface-3": "#efe5d3", elevated: "#fffcf6",
      text: "#2b241b", "text-2": "#625545", "text-3": "#796a58", ...tint("80, 55, 20", [0.11, 0.19, 0.05, 0.09]),
      "avatar-bg": "#efe3cf", "avatar-ink": "#6b5a43", "tint-base": "#f8f0e3",
    },
    dark: {
      chrome: "rgba(32, 27, 21, 0.6)", surface: "#262019", "surface-2": "#2d261e", "surface-3": "#382f25", elevated: "#30291f",
      text: "#f1e8da", "text-2": "#c8b9a2", "text-3": "#a08f77", ...tint("255, 230, 190", DARK_A),
      "avatar-bg": "#3d3328", "avatar-ink": "#d0c0a6", "tint-base": "#282219",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    blurb: "Lavender and violet, soft by day and moody at night.",
    accent: "#7a5cc7",
    light: {
      chrome: "rgba(234, 229, 242, 0.72)", surface: "#fdfcff", "surface-2": "#f4f1f9", "surface-3": "#e9e4f2", elevated: "#ffffff",
      text: "#221d2b", "text-2": "#574e66", "text-3": "#716884", ...tint("50, 30, 80", LIGHT_A),
      "avatar-bg": "#e8e2f1", "avatar-ink": "#5c5270", "tint-base": "#f3f0f8",
    },
    dark: {
      chrome: "rgba(27, 23, 34, 0.62)", surface: "#1f1b27", "surface-2": "#26212f", "surface-3": "#302a3b", elevated: "#2a2434",
      text: "#ece7f4", "text-2": "#b8afc8", "text-3": "#958ba7", ...tint("220, 200, 255", DARK_A),
      "avatar-bg": "#352e42", "avatar-ink": "#c3b8d6", "tint-base": "#211d29",
    },
  },
  {
    id: "rose",
    name: "Rose",
    blurb: "Blush pinks with a raspberry accent. Warm and gentle.",
    accent: "#c0507a",
    light: {
      chrome: "rgba(244, 231, 234, 0.72)", surface: "#fffcfc", "surface-2": "#faf2f3", "surface-3": "#f1e3e6", elevated: "#ffffff",
      text: "#2b1e22", "text-2": "#644d54", "text-3": "#80666e", ...tint("90, 30, 45", LIGHT_A),
      "avatar-bg": "#f2e2e6", "avatar-ink": "#6b525a", "tint-base": "#f9f0f2",
    },
    dark: {
      chrome: "rgba(33, 23, 26, 0.62)", surface: "#251b1f", "surface-2": "#2c2125", "surface-3": "#372a2f", elevated: "#2f2428",
      text: "#f3e6ea", "text-2": "#c6aeb6", "text-3": "#a08891", ...tint("255, 200, 215", DARK_A),
      "avatar-bg": "#3d2d33", "avatar-ink": "#d0b6bf", "tint-base": "#271d21",
    },
  },
  {
    id: "mono",
    name: "Mono",
    blurb: "Pure grayscale with typewriter headings. High contrast, no color.",
    accent: "#4a4f57",
    display: `"Cascadia Code", "Cascadia Mono", Consolas, monospace`,
    light: {
      chrome: "rgba(238, 238, 238, 0.75)", surface: "#ffffff", "surface-2": "#f5f5f5", "surface-3": "#e9e9e9", elevated: "#ffffff",
      text: "#111111", "text-2": "#444444", "text-3": "#666666", ...tint("0, 0, 0", [0.12, 0.22, 0.05, 0.09]),
      "avatar-bg": "#e8e8e8", "avatar-ink": "#444444", "tint-base": "#f4f4f4",
    },
    dark: {
      chrome: "rgba(14, 14, 14, 0.7)", surface: "#161616", "surface-2": "#1d1d1d", "surface-3": "#262626", elevated: "#202020",
      text: "#f2f2f2", "text-2": "#bdbdbd", "text-3": "#949494", ...tint("255, 255, 255", [0.1, 0.18, 0.055, 0.1]),
      "avatar-bg": "#2c2c2c", "avatar-ink": "#c4c4c4", "tint-base": "#181818",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    blurb: "Deep navy at night, cool blue-white by day, with a bright blue accent.",
    accent: "#3f6fe0",
    light: {
      chrome: "rgba(228, 233, 245, 0.72)", surface: "#fcfdff", "surface-2": "#f1f4fb", "surface-3": "#e4e9f5", elevated: "#ffffff",
      text: "#141a2b", "text-2": "#48526b", "text-3": "#636e88", ...tint("20, 35, 80", LIGHT_A),
      "avatar-bg": "#e2e7f3", "avatar-ink": "#48526b", "tint-base": "#f1f4fa",
    },
    dark: {
      chrome: "rgba(12, 17, 32, 0.66)", surface: "#121a2c", "surface-2": "#172036", "surface-3": "#1f2a43", elevated: "#1a2338",
      text: "#e6ebf7", "text-2": "#a6b1c9", "text-3": "#8290ab", ...tint("170, 195, 255", [0.09, 0.15, 0.055, 0.1]),
      "avatar-bg": "#24304b", "avatar-ink": "#b5c1da", "tint-base": "#141c2f",
    },
  },
  // ---------- dark moods: always dark ----------
  {
    id: "graphite",
    name: "Graphite",
    blurb: "A true neutral dark with steel-blue accents. Easy on the eyes at night.",
    accent: "#7aa2c8",
    scheme: "dark",
    dark: {
      chrome: "rgba(16, 16, 17, 0.72)", surface: "#18181a", "surface-2": "#1e1e21", "surface-3": "#28282c", elevated: "#222225",
      text: "#ececee", "text-2": "#b4b4ba", "text-3": "#8e8e95", ...tint("255, 255, 255", [0.08, 0.15, 0.05, 0.09]),
      "avatar-bg": "#2c2c30", "avatar-ink": "#c4c4ca", "tint-base": "#1a1a1c",
    },
  },
  {
    id: "abyss",
    name: "Abyss",
    blurb: "Deep teal waters, matching Post's stamp. Calm and focused.",
    accent: "#3fb6ad",
    scheme: "dark",
    dark: {
      chrome: "rgba(10, 22, 24, 0.7)", surface: "#0f1d20", "surface-2": "#142529", "surface-3": "#1d3237", elevated: "#172a2e",
      text: "#e3f1f0", "text-2": "#a8c6c3", "text-3": "#7fa19e", ...tint("180, 240, 235", [0.08, 0.15, 0.055, 0.1]),
      "avatar-bg": "#1e363a", "avatar-ink": "#b3d3d0", "tint-base": "#112023",
    },
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Warm charcoal and amber, like a fire burning low.",
    accent: "#e0a04a",
    scheme: "dark",
    dark: {
      chrome: "rgba(24, 19, 15, 0.7)", surface: "#1d1814", "surface-2": "#241e19", "surface-3": "#302820", elevated: "#28211b",
      text: "#f2e9df", "text-2": "#c9baa8", "text-3": "#9f8e7b", ...tint("255, 225, 190", DARK_A),
      "avatar-bg": "#352b23", "avatar-ink": "#d2c0aa", "tint-base": "#1f1a15",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    blurb: "Deep indigo with a soft violet glow.",
    accent: "#9b8cff",
    scheme: "dark",
    dark: {
      chrome: "rgba(14, 13, 28, 0.7)", surface: "#15142a", "surface-2": "#1b1a33", "surface-3": "#25233f", elevated: "#1e1d38",
      text: "#e9e7fb", "text-2": "#b4b0dc", "text-3": "#8c88b7", ...tint("200, 195, 255", [0.09, 0.15, 0.055, 0.1]),
      "avatar-bg": "#2a2848", "avatar-ink": "#c3bfea", "tint-base": "#171630",
    },
  },
  {
    id: "oled",
    name: "Pitch black",
    blurb: "Pure black, for OLED screens and the darkest rooms.",
    accent: "#34a69a",
    scheme: "dark",
    dark: {
      chrome: "rgba(0, 0, 0, 0.88)", surface: "#000000", "surface-2": "#0b0b0b", "surface-3": "#171717", elevated: "#111111",
      text: "#f5f5f5", "text-2": "#bababa", "text-3": "#8c8c8c", ...tint("255, 255, 255", [0.1, 0.18, 0.06, 0.11]),
      "avatar-bg": "#1d1d1d", "avatar-ink": "#c8c8c8", "tint-base": "#050505",
    },
  },
];
/** When Auto is dark, in minutes after midnight (Settings, Appearance); theme.ts keeps it current. */
let darkFrom = 21 * 60;
let darkUntil = 5 * 60;
export function setAutoSchedule(from: number, until: number) {
  darkFrom = from;
  darkUntil = until;
}

/** Morning ends and evening begins at these times (minutes after midnight). */
const DAY_FROM = 11 * 60;
const EVENING_FROM = 17 * 60;

function isDark(m: number): boolean {
  if (darkFrom === darkUntil) return false;
  return darkFrom < darkUntil ? m >= darkFrom && m < darkUntil : m >= darkFrom || m < darkUntil;
}

/** Which mood Auto stands for at a given time: Ember (dark) between the chosen times, otherwise
    Slate in the morning, Classic during the day and Sand in the evening. */
export function autoMoodId(d = new Date()): string {
  const m = d.getHours() * 60 + d.getMinutes();
  if (isDark(m)) return "ember";
  return m < DAY_FROM ? "slate" : m < EVENING_FROM ? "classic" : "sand";
}

/** When Auto next changes mood. */
export function nextAutoChange(d = new Date()): Date {
  const m = d.getHours() * 60 + d.getMinutes();
  const turns = [darkFrom, darkUntil, DAY_FROM, EVENING_FROM];
  const ahead = turns.filter((t) => t > m);
  const at = ahead.length ? Math.min(...ahead) : Math.min(...turns) + 24 * 60;
  const next = new Date(d);
  next.setHours(0, at, 0, 0);
  return next;
}

/** The mood to apply; Auto resolves to the mood for the current time. */
export const moodById = (id: string | undefined) =>
  MOODS.find((m) => m.id === (id === "auto" ? autoMoodId() : id)) ?? MOODS[0];

/** Classic's colors (the defaults in styles/01-base.css), as a palette like the other moods'. */
export const CLASSIC_PALETTE: Record<"light" | "dark", MoodPalette> = {
  light: {
    chrome: "rgba(243, 243, 240, 0.55)", surface: "#ffffff", "surface-2": "#f6f6f4", "surface-3": "#ececea", elevated: "#ffffff",
    text: "#1b1c1f", "text-2": "#55585f", "text-3": "#6c6f77",
    ...tint("20, 20, 30", [0.08, 0.14, 0.04, 0.07]),
    "avatar-bg": "#e7e7e4", "avatar-ink": "#5b5e65", "tint-base": "#f4f4f2",
  },
  dark: {
    chrome: "rgba(28, 28, 31, 0.5)", surface: "#1d1e21", "surface-2": "#232428", "surface-3": "#2c2d32", elevated: "#2a2b30",
    text: "#ececee", "text-2": "#adb0b6", "text-3": "#8b8e95",
    ...tint("255, 255, 255", [0.07, 0.13, 0.045, 0.08]),
    "avatar-bg": "#34353a", "avatar-ink": "#b9bcc2", "tint-base": "#222326",
  },
};

/** A mood's colors for one scheme; a mood made only for dark falls back to Classic in light. */
export function paletteFor(id: string | undefined, scheme: "light" | "dark"): MoodPalette {
  const mood = moodById(id);
  return (scheme === "dark" ? mood.dark : mood.scheme === "dark" ? undefined : mood.light) ?? CLASSIC_PALETTE[scheme];
}

export const KEYS: (keyof MoodPalette)[] = [
  "chrome", "surface", "surface-2", "surface-3", "elevated", "text", "text-2", "text-3", "border", "border-strong",
  "hover", "press", "avatar-bg", "avatar-ink", "tint-base",
];

/** Apply a mood's palette for the resolved light/dark theme; Classic clears all overrides. */
export function applyMood(root: HTMLElement, id: string | undefined, theme: "light" | "dark") {
  const mood = moodById(id);
  const palette = theme === "dark" || mood.scheme === "dark" ? mood.dark : mood.light;
  for (const k of KEYS) {
    if (palette) root.style.setProperty(`--${k}`, palette[k]);
    else root.style.removeProperty(`--${k}`);
  }
  if (mood.display) root.style.setProperty("--font-display", mood.display);
  else root.style.removeProperty("--font-display");
  if (mood.read) root.style.setProperty("--font-read", mood.read);
  else root.style.removeProperty("--font-read");
  root.dataset.mood = mood.id;
}
