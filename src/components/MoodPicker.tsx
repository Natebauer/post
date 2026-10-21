import type React from "react";
import { useState } from "react";
import { Check, Moon, SunMoon, X } from "lucide-react";
import type { SavedLook, Settings } from "../api";
import { autoMoodId, lookFor, looksOf, moodById, MOODS, type CardStyle, type MoodLook, type MoodPalette } from "../moods";
import { cardOf, cardPatch, luminance, mixHex, resolvedTheme, windowStops } from "../theme";
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

/** Auto's day as a thin strip: each mood it wears, in that mood's accent, from midnight to midnight,
    with a mark at the time now. */
function AutoDay() {
  const at = (min: number) => {
    const d = new Date();
    d.setHours(0, min, 0, 0);
    return moodById(autoMoodId(d));
  };
  const stops: string[] = [];
  let from = 0;
  let cur = at(0);
  for (let min = 15; min <= 1440; min += 15) {
    const next = min < 1440 ? at(min) : null;
    if (!next || next.id !== cur.id) {
      stops.push(`${cur.accent} ${(from / 1440) * 100}% ${(min / 1440) * 100}%`);
      if (next) {
        cur = next;
        from = min;
      }
    }
  }
  const now = new Date();
  const pos = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  return (
    <span className="mp-day" style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }} title="Auto's moods through the day" aria-hidden>
      <i style={{ left: `${pos}%` }} />
    </span>
  );
}

/** What a card in the picker shows and applies: a mood's colors with a look on top. */
interface Choice {
  mood: string;
  accent: string;
  look: MoodLook;
  seasonal?: boolean;
}

const sameLook = (a: MoodLook, b: MoodLook) => a.bg.toLowerCase() === b.bg.toLowerCase() && a.card === b.card;

/**
 * The moods, each previewed with the look it brings (its background and inbox card), then the looks
 * you've saved as moods of your own. Picking one applies the whole look. Once you change the
 * accent, background or card, the mood's card says so and offers its own look back.
 */
export function MoodPicker({ settings, onApply }: { settings: Settings; onApply: (p: Partial<Settings>) => void }) {
  // Moods for both themes preview in your Theme setting; dark moods always preview dark.
  const theme = resolvedTheme({ ...settings, mood: "classic" });
  const current = settings.mood || "classic";
  const now: MoodLook = { bg: settings.windowColor ?? "", card: cardOf(settings) };
  const saved = settings.savedLooks ?? [];
  const savedOn = saved.findIndex(
    (l) => l.mood === current && l.accent === settings.accent && sameLook({ bg: l.windowColor, card: l.card }, now) && l.seasonal === !!settings.seasonal,
  );
  const [naming, setNaming] = useState<string | null>(null);
  // Opens on the tab the current look comes from.
  const [tab, setTab] = useState<"moods" | "yours">(savedOn >= 0 ? "yours" : "moods");

  const apply = (c: Choice) =>
    onApply({
      mood: c.mood,
      accent: c.accent,
      windowColor: c.look.bg,
      ...cardPatch(c.look.card),
      ...(c.seasonal !== undefined && { seasonal: c.seasonal }),
    });

  /** A miniature Post: the window in its background, the inbox card as it sits there, the reading pane. */
  const preview = (moodId: string, accent: string, look: MoodLook) => {
    const r = moodId === "auto" ? moodById("auto") : moodById(moodId);
    const scheme = theme === "dark" || r.scheme === "dark" ? "dark" : "light";
    const p = (scheme === "dark" ? r.dark : r.light) ?? CLASSIC[scheme];
    const stops = windowStops(look.bg);
    const mid = stops.length ? mixHex(stops) : solid(p.chrome);
    // What sits on the background takes light or dark colors to suit it, like the app does.
    const bgDark = stops.length ? luminance(mid) < 0.179 : scheme === "dark";
    const onBg = (bgDark ? r.dark : r.scheme === "dark" ? undefined : r.light) ?? CLASSIC[bgDark ? "dark" : "light"];
    const see = look.card === "frost" || look.card === "clear";
    const cp = see ? onBg : p;
    const card: Record<CardStyle, string> = {
      white: p.surface,
      tinted: `color-mix(in srgb, ${mid} ${bgDark === (scheme === "dark") ? 40 : 9}%, ${p.surface})`,
      frost: `rgba(255, 255, 255, ${bgDark ? 0.07 : 0.4})`,
      clear: `color-mix(in srgb, ${onBg.surface} 14%, transparent)`,
    };
    const background = stops.length
      ? stops.length > 1
        ? `linear-gradient(150deg, ${stops.join(", ")})`
        : stops[0]
      : `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${accent} 14%, transparent), transparent 70%), ${solid(p.chrome)}`;
    return (
      <span className="mood-preview" style={{ background }} aria-hidden>
        <span className="mp-rail">
          <i style={{ background: accent }} />
          <i style={{ background: onBg["text-3"] }} />
          <i style={{ background: onBg["text-3"] }} />
        </span>
        <span className="mp-list" style={{ background: card[look.card], borderColor: cp.border }}>
          <span className="mp-row sel" style={{ background: `color-mix(in srgb, ${accent} ${see ? 30 : 16}%, ${see ? "transparent" : p.surface})` }}>
            <i style={{ background: accent }} />
            <span className="mp-lines">
              <b style={{ background: cp.text }} />
              <b style={{ background: cp["text-3"], width: "55%" }} />
            </span>
          </span>
          {[0, 1].map((k) => (
            <span className="mp-row" key={k}>
              <i style={{ background: cp["surface-3"] }} />
              <span className="mp-lines">
                <b style={{ background: cp.text, opacity: 0.45 }} />
                <b style={{ background: cp["text-3"], width: "55%" }} />
              </span>
            </span>
          ))}
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
    );
  };

  const card = (m: (typeof MOODS)[number]) => {
    // Auto previews whichever mood it stands for right now.
    const r = m.id === "auto" ? moodById("auto") : m;
    const on = savedOn < 0 && current === m.id;
    const look = lookFor(m.id, theme);
    // Changed since it was picked: a different accent, background or card than any it suggests.
    const changed = on && ((settings.accent || "").toLowerCase() !== (m.accent || "").toLowerCase() || !looksOf(m.id).some((l) => sameLook(l, now)));
    const accent = on ? settings.accent || r.accent : r.accent;
    return (
      <button
        key={m.id}
        role="radio"
        aria-checked={on}
        className={cx("mood", on && "on")}
        style={{ "--ma": accent } as React.CSSProperties}
        onClick={() => apply({ mood: m.id, accent: m.accent, look })}
        title={m.blurb}
      >
        {preview(m.id, r.accent, on ? now : look)}
        {m.id === "auto" && <AutoDay />}
        <span className="mood-name">
          {m.name}
          {on && !changed && <Check size={13} />}
          {changed && <span className="mood-tag">Customized</span>}
        </span>
        <span className="mood-blurb">{m.id === "auto" ? `${m.blurb} Now: ${r.name}.` : m.blurb}</span>
      </button>
    );
  };

  const savedCard = (l: SavedLook, i: number) => {
    const on = i === savedOn;
    const look = { bg: l.windowColor, card: l.card };
    const accent = l.accent || moodById(l.mood).accent || "#2a737b";
    return (
      <button
        key={`${l.name}-${i}`}
        role="radio"
        aria-checked={on}
        className={cx("mood mood-saved", on && "on")}
        style={{ "--ma": accent } as React.CSSProperties}
        onClick={() => apply({ mood: l.mood, accent: l.accent, look, seasonal: l.seasonal })}
        title={`${l.name}: ${moodById(l.mood).name} with your own touches`}
      >
        {preview(l.mood, accent, look)}
        <span className="mood-name">
          {l.name}
          {on && <Check size={13} />}
        </span>
        <span className="mood-blurb">{moodById(l.mood).name}, your way</span>
        <span
          role="button"
          tabIndex={0}
          className="mood-del"
          title="Remove this mood"
          aria-label={`Remove ${l.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onApply({ savedLooks: saved.filter((_, k) => k !== i) });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onApply({ savedLooks: saved.filter((_, k) => k !== i) });
            }
          }}
        >
          <X size={12} />
        </span>
      </button>
    );
  };

  const base = moodById(current);
  const customized =
    savedOn < 0 &&
    ((settings.accent || "").toLowerCase() !== (base.accent || "").toLowerCase() || !looksOf(current).some((l) => sameLook(l, now)));
  const saveLook = () => {
    const name = (naming ?? "").trim() || "My mood";
    const entry: SavedLook = {
      name,
      mood: current,
      accent: settings.accent,
      windowColor: settings.windowColor ?? "",
      card: cardOf(settings),
      seasonal: !!settings.seasonal,
    };
    onApply({ savedLooks: [...saved.filter((l) => l.name !== name), entry] });
    setNaming(null);
    setTab("yours");
  };

  const nameForm = (
    <form
      className="mood-save"
      onSubmit={(e) => {
        e.preventDefault();
        saveLook();
      }}
    >
      <input
        className="input"
        autoFocus
        maxLength={24}
        placeholder="Name it, like Evening"
        aria-label="Name for this mood"
        value={naming ?? ""}
        onChange={(e) => setNaming(e.target.value)}
      />
      <button type="submit" className="btn primary">
        Save
      </button>
      <button type="button" className="btn ghost" onClick={() => setNaming(null)}>
        Cancel
      </button>
    </form>
  );

  return (
    <div className="mood-groups">
      {/* Post's moods, and the ones you've saved, each on its own tab. */}
      <div className="seg mood-tabs" role="tablist" aria-label="Moods">
        {(
          [
            ["moods", "Moods"],
            ["yours", saved.length ? `Yours · ${saved.length}` : "Yours"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={cx(tab === k && "on")} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "moods" ? (
        <>
          {customized && (
            <div className="mood-note">
              <span>
                <b>{base.name}</b>, customized
              </span>
              <span className="spacer" />
              {naming === null ? (
                <>
                  <button type="button" className="btn ghost" onClick={() => apply({ mood: current, accent: base.accent, look: lookFor(current, theme) })}>
                    Back to {base.name}'s look
                  </button>
                  <button type="button" className="btn outline" onClick={() => setNaming("")}>
                    Save as a mood
                  </button>
                </>
              ) : (
                nameForm
              )}
            </div>
          )}
          <div role="radiogroup" aria-label="Mood" className="mood-groups">
            <div className="mood-group-label">
              <SunMoon size={13} /> Light and dark
            </div>
            <div className="moods">{MOODS.filter((m) => m.scheme !== "dark").map(card)}</div>
            <div className="mood-group-label">
              <Moon size={13} /> Always dark
            </div>
            <div className="moods">{MOODS.filter((m) => m.scheme === "dark").map(card)}</div>
          </div>
        </>
      ) : (
        <div role="radiogroup" aria-label="Your moods" className="moods">
          {saved.map(savedCard)}
          {/* Keeping the current look: its accent, background, inbox card and pattern, together. */}
          <div className="mood mood-add">
            {naming === null ? (
              <button type="button" className="mood-add-btn" onClick={() => setNaming("")}>
                <span className="mood-add-plus" aria-hidden>
                  +
                </span>
                Save current look
                <small>Its colors, accent, background, inbox card and pattern, kept together</small>
              </button>
            ) : (
              nameForm
            )}
          </div>
        </div>
      )}
    </div>
  );
}
