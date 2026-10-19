import type React from "react";
import { Check } from "lucide-react";
import type { Settings } from "../api";
import { moodById, MOODS, type MoodPalette } from "../moods";
import { resolvedTheme } from "../theme";
import { cx } from "../util";

/** Classic's own colors (from styles/01-base.css), so its preview matches the other moods'. */
const CLASSIC: Record<
  "light" | "dark",
  Pick<MoodPalette, "chrome" | "surface" | "surface-3" | "text" | "text-3" | "border">
> = {
  light: {
    chrome: "#ecece9",
    surface: "#ffffff",
    "surface-3": "#ececea",
    text: "#1b1c1f",
    "text-3": "#6c6f77",
    border: "rgba(20,20,30,0.1)",
  },
  dark: {
    chrome: "#1c1c1f",
    surface: "#1d1e21",
    "surface-3": "#2c2d32",
    text: "#ececee",
    "text-3": "#8b8e95",
    border: "rgba(255,255,255,0.08)",
  },
};

/** Opaque version of a window tint for the preview. */
const solid = (c: string) => c.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, "rgb($1,$2,$3)");

/** A miniature Post in each mood: window, inbox card with a selected row, reading pane and a heading. */
export function MoodPicker({ settings, onPick }: { settings: Settings; onPick: (id: string, accent: string) => void }) {
  // Moods for both themes preview in your Theme setting; dark moods always preview dark.
  const theme = resolvedTheme({ ...settings, mood: "classic" });
  const current = settings.mood || "classic";
  const card = (m: (typeof MOODS)[number]) => {
    // Auto previews whichever mood it stands for right now.
    const r = m.id === "auto" ? moodById("auto") : m;
    const p = (theme === "dark" || r.scheme === "dark" ? r.dark : r.light) ?? CLASSIC[theme];
    const on = current === m.id;
    const accent = on ? settings.accent || r.accent : r.accent;
    return (
      <button
        key={m.id}
        role="radio"
        aria-checked={on}
        className={cx("mood", on && "on")}
        style={{ "--ma": accent } as React.CSSProperties}
        onClick={() => onPick(m.id, m.accent)}
        title={m.blurb}
      >
        <span
          className="mood-preview"
          style={{
            background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${accent} 14%, transparent), transparent 70%), ${solid(p.chrome)}`,
          }}
          aria-hidden
        >
          <span className="mp-rail">
            <i style={{ background: accent }} />
            <i style={{ background: p["text-3"] }} />
            <i style={{ background: p["text-3"] }} />
          </span>
          <span className="mp-list" style={{ background: p.surface, borderColor: p.border }}>
            <span
              className="mp-row sel"
              style={{
                background: `color-mix(in srgb, ${accent} 16%, ${p.surface})`,
              }}
            >
              <i style={{ background: accent }} />
              <span className="mp-lines">
                <b style={{ background: p.text }} />
                <b style={{ background: p["text-3"], width: "55%" }} />
              </span>
            </span>
            <span className="mp-row">
              <i style={{ background: p["surface-3"] }} />
              <span className="mp-lines">
                <b style={{ background: p.text, opacity: 0.45 }} />
                <b style={{ background: p["text-3"], width: "55%" }} />
              </span>
            </span>
            <span className="mp-row">
              <i style={{ background: p["surface-3"] }} />
              <span className="mp-lines">
                <b style={{ background: p.text, opacity: 0.45 }} />
                <b style={{ background: p["text-3"], width: "55%" }} />
              </span>
            </span>
          </span>
          <span className="mp-read" style={{ background: p.surface, borderColor: p.border }}>
            <span className="mp-head" style={{ color: p.text, fontFamily: r.display ?? "var(--font)" }}>
              Aa
            </span>
            <b style={{ background: p["text-3"] }} />
            <b style={{ background: p["text-3"], width: "86%" }} />
            <b style={{ background: p["text-3"], width: "60%" }} />
            <span className="mp-btn" style={{ background: accent }} />
          </span>
        </span>
        <span className="mood-name">
          {m.name}
          {on && <Check size={13} />}
        </span>
        <span className="mood-blurb">{m.id === "auto" ? `${m.blurb} Now: ${r.name}.` : m.blurb}</span>
      </button>
    );
  };
  return (
    <div className="mood-groups" role="radiogroup" aria-label="Mood">
      <div className="mood-group-label">Light and dark</div>
      <div className="moods">{MOODS.filter((m) => m.scheme !== "dark").map(card)}</div>
      <div className="mood-group-label">Always dark</div>
      <div className="moods">{MOODS.filter((m) => m.scheme === "dark").map(card)}</div>
    </div>
  );
}
