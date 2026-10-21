import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type React from "react";
import { Bell, BookOpen, Moon, Sun, Keyboard, Monitor, Palette, PenLine, Plus, Sparkles, Trash2, UserRound, X } from "lucide-react";
import { ArrowLeftRight } from "lucide-react";
import { api, errText, type AiStatus, type ComposeMode, type Settings, type Template } from "../api";
import { useStore } from "../store";
import { accentFor, ACCENTS, AUTO_ACCENT, DEFAULT_ACCENT, resolvedTheme, WINDOW_COLORS, WINDOW_GRADIENTS, luminance } from "../theme";
import { MoodPicker } from "./MoodPicker";
import { moodById } from "../moods";
import { ShortcutList } from "./Shortcuts";
import { cx, relativeAgo } from "../util";
import { Avatar } from "./Avatar";
import { usePresence } from "../hooks";
import { setZoom } from "../actions";
import { season } from "../theme";
import { Shuffle } from "lucide-react";
import { etaText } from "./TitleBar";

type Tab = "appearance" | "reading" | "compose" | "notifications" | "ai" | "shortcuts" | "system" | "account";

/** An icon for each section of Settings, shown beside its name. */
const TAB_ICONS: Record<Tab, JSX.Element> = {
  appearance: <Palette size={16} />,
  reading: <BookOpen size={16} />,
  compose: <PenLine size={16} />,
  notifications: <Bell size={16} />,
  ai: <Sparkles size={16} />,
  shortcuts: <Keyboard size={16} />,
  system: <Monitor size={16} />,
  account: <UserRound size={16} />,
};

/** Minutes after midnight as "HH:MM" for a time field, and back. */
const toClock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromClock = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};

const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

function AiSettings({ settings, set }: { settings: Settings; set: (p: Partial<Settings>) => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => void api.aiStatus().then(setStatus).catch(() => {});
  useEffect(refresh, [settings.aiEnabled, settings.aiCapUsd]);

  const saveKey = async () => {
    setMsg(null);
    try {
      setStatus(await api.setAiKey(key));
      setKey("");
      setMsg({ ok: true, text: "Key saved. Use Test key to check it works." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const reply = await api.testAi();
      setMsg({ ok: true, text: `Connected to Claude${reply.trim() ? `: "${reply.trim()}"` : ""}. That test cost less than a cent.` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const remove = async () => {
    setStatus(await api.clearAiKey());
    set({ aiEnabled: false });
    setMsg({ ok: true, text: "Key removed." });
  };

  const pct = status ? Math.min(100, (status.monthSpend / Math.max(0.01, status.cap)) * 100) : 0;

  return (
    <>
      <h4>AI</h4>
      <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
        Post uses Claude for the AI assistant (questions about your mail, and doing things like archiving or
        accepting invitations after you confirm), drafting replies, summarizing emails, sorting mail into AI sections
        and spotting emails waiting on a reply. It uses your own Anthropic API key and the low-cost{" "}
        {status?.model ?? "Claude Haiku"} model.
      </p>
      <Row
        title="Anthropic API key"
        col
        sub={
          status?.hasKey
            ? `Saved in Windows Credential Manager (ends in ${status.keyHint?.replace("…", "")}).`
            : "Create one at console.anthropic.com → API keys. It's stored in Windows Credential Manager, never in a file."
        }
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            id="ai-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            style={{ flex: "1 1 260px" }}
            placeholder={status?.hasKey ? "Paste a new key to replace it" : "sk-ant-…"}
            aria-label="Anthropic API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
          />
          <button className="btn primary" disabled={!key.trim()} onClick={() => void saveKey()}>
            Save key
          </button>
          {status?.hasKey && (
            <>
              <button className="btn outline" disabled={busy} onClick={() => void test()}>
                {busy ? "Testing…" : "Test key"}
              </button>
              <button className="btn danger" onClick={() => void remove()}>
                Remove
              </button>
            </>
          )}
        </div>
        {msg && (
          <div style={{ fontSize: 12.5, color: msg.ok ? "var(--text-2)" : "var(--danger)" }} role="status">
            {msg.text}
          </div>
        )}
      </Row>
      <Row title="Use AI features" sub={status?.hasKey ? "Turn Claude-powered features on or off at any time." : "Add a key first."}>
        <Switch
          label="Use AI features"
          on={settings.aiEnabled && !!status?.hasKey}
          onChange={(v) => status?.hasKey && set({ aiEnabled: v })}
        />
      </Row>
      <Row title="Monthly spending cap" sub="AI features pause for the rest of the month once Post has spent this much.">
        <Seg
          label="Monthly spending cap"
          value={String(settings.aiCapUsd)}
          options={[
            ["2", "$2"],
            ["5", "$5"],
            ["10", "$10"],
            ["20", "$20"],
          ]}
          onChange={(v) => set({ aiCapUsd: Number(v) })}
        />
      </Row>
      {status && (
        <Row
          title="Spent this month"
          col
          sub={`${money(status.monthSpend)} of ${money(status.cap)} · ${status.monthCalls} request${status.monthCalls === 1 ? "" : "s"}${
            status.capped ? " · Cap reached, AI paused until next month" : ""
          }`}
        >
          <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${pct}%`, background: status.capped ? "var(--danger)" : undefined }} />
          </div>
        </Row>
      )}
    </>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={cx("switch", on && "on")} onClick={() => onChange(!on)} />;
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, React.ReactNode][]; onChange: (v: T) => void; label?: string }) {
  // A highlight that slides to the chosen option (the options can be different widths).
  const ref = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const on = ref.current?.querySelector<HTMLElement>("button.on");
    if (on) setPill({ x: on.offsetLeft, w: on.offsetWidth });
  }, [value]);
  return (
    <div className="seg seg-slide" role="radiogroup" aria-label={label} ref={ref}>
      {pill && <span className="seg-pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden />}
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={cx(value === v && "on")} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** A color as #rrggbb from hue (degrees), saturation and lightness (0 to 1). */
function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

/** The same color turned round the color wheel, keeping its lightness, so text reads the same on
    both ends of a gradient made from the two. Greys get a touch of color, or there'd be nothing to turn. */
function hueShift(hex: string, deg: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return hslHex((h * 60 + deg + 360) % 360, Math.max(s, 0.22), l);
}

const isDeep = (hex: string) => luminance(hex) < 0.179;

/** Everything behind the panes, in three short decisions: the background (the mood's own, or a
    color, which can fade into a second one) with a live preview beside it, what the inbox card
    does on it, and whether a seasonal pattern sits on top. */
function BackgroundSettings({ settings, look }: { settings: Settings; look: (p: Partial<Settings>) => void }) {
  const value = settings.windowColor?.toLowerCase() ?? "";
  // A background is one color, or a color and the one it fades into.
  const [base = "", second = ""] = value.split(">");
  const grad = !!second;
  // The color it last faded into, so switching the gradient off and on again brings it back.
  const lastSecond = useRef("");
  if (second) lastSecond.current = second;
  const solids = WINDOW_COLORS.map((c) => ({ ...c, deep: isDeep(c.value) }));
  const nameOf = (hex: string) => solids.find((c) => c.value === hex)?.name ?? hex;
  const ownBase = !!base && !solids.some((c) => c.value === base);
  const suggested = base ? hueShift(base, 40) : "";
  const ownSecond = grad && second !== suggested && !solids.some((c) => c.value === second);
  // What picking a color does: with the gradient on, it keeps the second color if that still
  // goes (as light or as deep as the new one), and otherwise finds it a partner.
  const withBase = (b: string) => {
    if (!grad) return b;
    const keep = second !== b && isDeep(second) === isDeep(b);
    return `${b}>${keep ? second : hueShift(b, 40)}`;
  };
  // Backgrounds of your own you've used lately (colors or gradients), kept on this computer.
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("post-recent-backgrounds") || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!value || solids.some((c) => c.value === value)) return;
    setRecent((r) => {
      const next = [value, ...r.filter((x) => x !== value)].slice(0, 4);
      try {
        localStorage.setItem("post-recent-backgrounds", JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // Pointing at a tile tries it in the little window beside, before you pick it.
  const [peek, setPeek] = useState<string | null>(null);
  const css = (v: string) => (v.includes(">") ? `linear-gradient(150deg, ${v.split(">").join(", ")})` : v);
  // A color tile; `to` is the background picking it would give.
  const tile = (c: { name: string; value: string }, on: boolean, to: string) => (
    <button
      key={c.value}
      className={cx("swatch has-dot", on && "on")}
      style={
        {
          // In the second row, each tile shows the gradient it would make.
          background: to === `${base}>${c.value}` ? css(to) : c.value,
          "--sw": c.value,
          // The accent Auto would bring with it, as a small dot in the corner.
          "--dot": accentFor({ mood: settings.mood, accent: AUTO_ACCENT, windowColor: to }).value,
        } as React.CSSProperties
      }
      title={c.name}
      aria-label={c.name}
      aria-pressed={on}
      onClick={() => look({ windowColor: to })}
      onMouseEnter={() => setPeek(to)}
      onMouseLeave={() => setPeek(null)}
    />
  );
  const preset = WINDOW_GRADIENTS.find((g) => g.value === value);
  return (
    <>
      <Row
        title="Background"
        sub={
          // The chosen one by name, ahead of what it does.
          <>
            <b className="sub-name">
              {!value
                ? "The mood's own"
                : preset
                  ? `${preset.name} · ${preset.deep ? "deep" : "pale"} gradient`
                  : `${ownBase ? `Your color ${base}` : nameOf(base)}${grad ? ` into ${nameOf(second)}` : ""} · ${isDeep(base) ? "deep" : "pale"}`}
            </b>
            {" · what sits behind the panes. Text on it turns light or dark to match"}
          </>
        }
        col
        look
      >
        <div className="bg-pick">
          <div className="bg-controls">
            <div className="swatches">
              {/* The mood's own backdrop, crossed through: no background of your own. */}
              <button
                className={cx("swatch swatch-mood", !value && "on")}
                title="The mood's own"
                aria-label="The mood's own background"
                aria-pressed={!value}
                onClick={() => look({ windowColor: "" })}
              />
              {solids.filter((c) => !c.deep).map((c) => tile(c, base === c.value, withBase(c.value)))}
            {/* Pale ones (dark text), then deep ones (light text). */}
            <i className="bg-divider" aria-hidden />
              {solids.filter((c) => c.deep).map((c) => tile(c, base === c.value, withBase(c.value)))}
              <input
                type="color"
                className={cx("swatch-custom", ownBase && "on")}
                title={ownBase ? `Custom background ${base}` : "Custom background"}
                aria-label="Custom background color"
                value={ownBase ? base : "#e4e4e1"}
                onChange={(e) => look({ windowColor: withBase(e.target.value) })}
              />
            </div>
            {/* A gradient is the chosen color fading into a second one. */}
            <label className={cx("bg-grad", !base && "off")} title={base ? undefined : "Pick a color first"}>
              <Switch
                on={grad}
                label="Gradient"
                onChange={(v) => {
                  const back = lastSecond.current;
                  const again = back && back !== base && isDeep(back) === isDeep(base) ? back : hueShift(base, 40);
                  if (base) look({ windowColor: v ? `${base}>${again}` : base });
                }}
              />
              Gradient
            </label>
            {grad && (
              <>
                <span className="bg-sub bg-sub-row">
                  Fades into
                  {/* Another color that goes: the first turned a different way round the wheel. */}
                  <button
                    type="button"
                    className="bg-dice"
                    title="Another color that goes"
                    aria-label="Pick another color that goes"
                    onClick={() => look({ windowColor: `${base}>${hueShift(base, (Math.random() < 0.5 ? -1 : 1) * (25 + Math.random() * 55))}` })}
                  >
                    <Shuffle size={11} />
                  </button>
                </span>
                <div className="swatches">
                  {/* Only colors as light or as deep as the first, so text reads all the way across. */}
                  {solids
                    .filter((c) => c.deep === isDeep(base) && c.value !== base)
                    .map((c) => tile(c, second === c.value, `${base}>${c.value}`))}
                  {/* The partner Post would pick: the same color turned a little round the wheel. */}
                  <button
                    className={cx("swatch has-dot swatch-suggest", second === suggested && "on")}
                    style={{ background: suggested, "--sw": suggested, "--dot": accentFor({ mood: settings.mood, accent: AUTO_ACCENT, windowColor: `${base}>${suggested}` }).value } as React.CSSProperties}
                    title={`Suggested: ${suggested}, a near neighbor of the first color`}
                    aria-label="Suggested second color"
                    aria-pressed={second === suggested}
                    onClick={() => look({ windowColor: `${base}>${suggested}` })}
                    onMouseEnter={() => setPeek(`${base}>${suggested}`)}
                    onMouseLeave={() => setPeek(null)}
                  >
                    <span className="sw-star">✦</span>
                  </button>
                  <input
                    type="color"
                    className={cx("swatch-custom", ownSecond && "on")}
                    title={`The color it fades into: ${second}`}
                    aria-label="Second gradient color"
                    value={second}
                    onChange={(e) => look({ windowColor: `${base}>${e.target.value}` })}
                  />
                  {/* Turn it round: the second color first. */}
                  <button type="button" className="icon-btn sm bg-swap" title="Swap the two colors" aria-label="Swap the two colors" onClick={() => look({ windowColor: `${second}>${base}` })}>
                    <ArrowLeftRight size={14} />
                  </button>
                </div>
              </>
            )}
            {recent.length > 0 && (
              <>
                <div className="bg-sub">Recent</div>
                <div className="swatches">
                  {recent.map((r) => (
                    <button
                      key={r}
                      className={cx("swatch", value === r && "on")}
                      style={{ background: r.includes(">") ? `linear-gradient(150deg, ${r.split(">").join(", ")})` : r, "--sw": r.split(">").pop() } as React.CSSProperties}
                      title={`Your ${r.includes(">") ? "gradient" : "color"} ${r.replace(">", " to ")}`}
                      aria-label={`Recent background ${r.replace(">", " to ")}`}
                      aria-pressed={value === r}
                      onClick={() => look({ windowColor: r })}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          {/* A little window showing the result: the background, the sidebar and the inbox card. */}
          <div
            className={cx("bg-preview", peek && peek !== value && "peeking")}
            style={peek && peek !== value ? { background: css(peek) } : undefined}
            aria-hidden
          >
            <span className="bgp-side">
              <i />
              <i />
              <i />
            </span>
            <span className="bgp-card">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="bgp-home">
              <i />
              <i />
            </span>
            {/* Its title bar: the search box across the top, as in Post. */}
            <span className="bgp-bar" />
          </div>
        </div>
      </Row>
      <Row title="Inbox card" sub="Plain white, a little of the background's color, a thin white frost over it, or mostly see-through" look>
        {/* Pointing at a card style tries it on the preview's little inbox card. */}
        <div
          className="card-peek"
          onMouseOver={(e) => {
            const b = (e.target as HTMLElement).closest("button");
            document.querySelector(".bg-preview")?.setAttribute("data-card", b?.textContent?.trim().toLowerCase() ?? "");
          }}
          onMouseLeave={() => document.querySelector(".bg-preview")?.removeAttribute("data-card")}
        >
        <Seg
          label="Inbox card"
          value={settings.cardClear ? "clear" : settings.cardFrost ? "frost" : settings.cardTint ? "tinted" : "white"}
          options={[
            ["white", "White"],
            ["tinted", "Tinted"],
            ["frost", "Frost"],
            ["clear", "Clear"],
          ]}
          onChange={(v) => look({ cardTint: v === "tinted", cardFrost: v === "frost", cardClear: v === "clear" })}
        />
        </div>
      </Row>
      <Row title="Pattern" sub="A faint pattern behind the panes that follows the season: petals, sun, leaves or snow" look>
        <Seg
          label="Pattern"
          value={settings.seasonal ? "seasonal" : "none"}
          options={[
            ["none", "None"],
            // Named for the season it shows right now.
            ["seasonal", `Seasonal · ${season()}`],
          ]}
          onChange={(v) => look({ seasonal: v === "seasonal" })}
        />
      </Row>
    </>
  );
}

function Row({
  title,
  sub,
  children,
  col,
  look,
}: {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
  col?: boolean;
  /** Changes the app's look: adjusting it clears the scrim so the change shows behind Settings. */
  look?: boolean;
}) {
  return (
    <div className={cx("set-row", col && "col")} data-look={look || undefined}>
      <div className="lbl">
        {title}
        {sub && <small>{sub}</small>}
      </div>
      {children}
    </div>
  );
}

const hours = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

function SyncDetails() {
  const status = useStore((s) => s.status);
  if (!status) return null;
  if (status.phase !== "backfill") {
    return (
      <Row title="Local index" sub="Headers and text of every email are stored for instant offline search.">
        <span className="muted">Up to date</span>
      </Row>
    );
  }
  const pct = Math.min(100, (status.backfilled / Math.max(1, status.total)) * 100);
  const throttled = status.spacingMs > 120;
  return (
    <Row
      title="Building your local index"
      col
      sub={
        <>
          {status.backfilled.toLocaleString()} of ~{status.total.toLocaleString()} messages
          {status.rate >= 1 && ` · ~${Math.round(status.rate)} per minute`}
          {etaText(status) && ` · ${etaText(status)}`}
          {throttled && (
            <>
              <br />
              Gmail is limiting how fast Post can download (your Cloud project's "Units per minute per user" quota).
              Raising it in Google Cloud Console → Gmail API → Quotas speeds this up; Post adapts automatically.
            </>
          )}
        </>
      }
    >
      <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </Row>
  );
}

function Templates({ value, onChange }: { value: Template[]; onChange: (t: Template[]) => void }) {
  const [list, setList] = useState(value);
  useEffect(() => setList(value), [value]);
  const commit = (next: Template[]) => {
    setList(next);
    onChange(next);
  };
  return (
    <div>
      {list.map((t, i) => (
        <div key={i} className="template">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="Template name"
              aria-label="Template name"
              value={t.name}
              onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              onBlur={() => onChange(list)}
            />
            <button className="icon-btn" aria-label="Delete template" title="Delete template" onClick={() => commit(list.filter((_, j) => j !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
          <textarea
            className="input"
            rows={3}
            placeholder="Text to insert"
            aria-label="Template text"
            value={t.body}
            onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
            onBlur={() => onChange(list)}
          />
        </div>
      ))}
      <button className="btn outline" onClick={() => commit([...list, { name: "", body: "" }])}>
        <Plus size={14} /> Add template
      </button>
    </div>
  );
}

/** Who you're signed in as: your avatar, name and address, and how syncing is going. */
function AccountCard({ email, name }: { email: string; name: string }) {
  const status = useStore((s) => s.status);
  const state = !status
    ? null
    : status.error
      ? { tone: "problem", text: "Sync problem" }
      : status.phase === "backfill" && status.total
        ? { tone: "busy", text: `Indexing ${Math.min(100, Math.round((status.backfilled / status.total) * 100))}%` }
        : { tone: "ok", text: status.lastSync ? `Up to date · synced ${relativeAgo(status.lastSync)}` : "Up to date" };
  return (
    <div className="account-card">
      <Avatar email={email} name={name || email} size="lg" />
      <div className="ac-who">
        <div className="ac-name">{name || email || "Not signed in"}</div>
        {name && <div className="ac-email">{email}</div>}
        {state && (
          <span className={cx("ac-sync", state.tone)}>
            <span className="ac-dot" />
            {state.text}
          </span>
        )}
      </div>
      <span className="ac-gmail">Gmail</span>
    </div>
  );
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const email = useStore((s) => s.info?.email);
  const [tab, setTab] = useState<Tab>("appearance");
  const [sig, setSig] = useState(settings?.signature ?? "");
  // While theme, mood or accent is being adjusted the scrim fades away so the app shows through;
  // touching any other setting brings it back.
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!open) setPeek(false);
  }, [open]);
  const { mounted, closing } = usePresence(open);

  useEffect(() => {
    if (open) setSig(settings?.signature ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.setState({ settingsOpen: false });
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);

  if (!mounted || !settings) return null;
  const set = (p: Partial<Settings>) => void save(p);
  const look = (p: Partial<Settings>) => {
    setPeek(true);
    set(p);
  };
  const other = (e: React.SyntheticEvent) => {
    if (!(e.target as HTMLElement).closest("[data-look]")) setPeek(false);
  };
  const close = () => {
    if (sig !== settings.signature) set({ signature: sig });
    useStore.setState({ settingsOpen: false });
  };

  const tabs: [Tab, string][] = [
    ["appearance", "Appearance"],
    ["reading", "Reading"],
    ["compose", "Writing"],
    ["notifications", "Notifications"],
    ["ai", "AI"],
    ["shortcuts", "Shortcuts"],
    ["system", "System & sync"],
    ["account", "Account"],
  ];

  return createPortal(
    <>
      <div className={cx("scrim", peek && "peek", closing && "closing")} onClick={close} />
      <div
        className={cx("modal settings", closing && "closing")}
        role="dialog"
        aria-label="Settings"
        aria-modal
        onPointerDownCapture={other}
        onFocusCapture={other}
      >
        <nav aria-label="Settings sections">
          <h3>Settings</h3>
          {tabs.map(([t, l]) => (
            <button key={t} className={cx("nav-item", tab === t && "active")} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {TAB_ICONS[t]}
              {l}
            </button>
          ))}
        </nav>
        <section>
          <div style={{ display: "flex", justifyContent: "flex-end", margin: "-12px -12px 0 0" }}>
            <button className="icon-btn" onClick={close} aria-label="Close settings" title="Close">
              <X size={17} />
            </button>
          </div>
          {tab === "appearance" && (
            <>
              <h4>Appearance</h4>
              <Row
                title="Theme"
                sub={
                  moodById(settings.mood).scheme === "dark"
                    ? "Your mood is a dark one, so Post stays dark"
                    : settings.theme === "system"
                      ? // Following Windows: say which way that is right now.
                        `Match Windows, or pick one. Windows is ${resolvedTheme({ ...settings, mood: "classic" })} right now`
                      : "Match Windows, or pick one"
                }
                look
              >
                <Seg
                  label="Theme"
                  value={settings.theme}
                  options={[
                    [
                      "system",
                      <>
                        <Monitor size={13} /> Windows
                      </>,
                    ],
                    [
                      "light",
                      <>
                        <Sun size={13} /> Light
                      </>,
                    ],
                    [
                      "dark",
                      <>
                        <Moon size={13} /> Dark
                      </>,
                    ],
                  ]}
                  onChange={(theme) => look({ theme })}
                />
              </Row>
              <Row title="Mood" sub="The feel of the whole app: its colors, background and inbox card. Each mood works in light and dark." col look>
                <MoodPicker
                  settings={settings}
                  onApply={look}
                  // The Custom tab: your saved moods, then the accent, background, card and pattern.
                  custom={
                    <>
                  <Row
                    title="Accent color"
                    sub={
                      // The chosen one by name, ahead of what it's for.
                      <>
                        <b className="sub-name">
                          {(() => {
                            const a = accentFor(settings);
                            return a.auto ? `Auto · ${a.name}` : (ACCENTS.find((x) => x.value === a.value.toLowerCase())?.name ?? "Custom");
                          })()}
                        </b>
                        {" · used for unread markers, selection and buttons"}
                      </>
                    }
                    col
                    look
                  >
                    <div className="swatches">
                      {/* Auto: the accent follows the background (theme.ts, accentFor). */}
                      <button
                        className={cx("swatch swatch-auto", accentFor(settings).auto && "on")}
                        style={
                          {
                            background: accentFor({ ...settings, accent: AUTO_ACCENT }).value,
                            "--sw": accentFor({ ...settings, accent: AUTO_ACCENT }).value,
                          } as React.CSSProperties
                        }
                        title="Auto: follows the background"
                        aria-label="Auto accent, following the background"
                        aria-pressed={accentFor(settings).auto}
                        onClick={() => look({ accent: AUTO_ACCENT })}
                      />
                      {ACCENTS.map((a) => (
                        <button
                          key={a.value}
                          className={cx("swatch", settings.accent.toLowerCase() === a.value && "on")}
                          style={{ background: a.value, "--sw": a.value } as React.CSSProperties}
                          title={a.name}
                          aria-label={a.name}
                          aria-pressed={settings.accent.toLowerCase() === a.value}
                          onClick={() => look({ accent: a.value })}
                        />
                      ))}
                      <input
                        type="color"
                        // A color of your own is the chosen one too: it wears the ring, and says its value.
                        className={cx("swatch-custom", !accentFor(settings).auto && !ACCENTS.some((a) => a.value === settings.accent.toLowerCase()) && "on")}
                        title={!accentFor(settings).auto && !ACCENTS.some((a) => a.value === settings.accent.toLowerCase()) ? `Custom color ${settings.accent}` : "Custom color"}
                        aria-label="Custom accent color"
                        value={accentFor(settings).value}
                        onChange={(e) => look({ accent: e.target.value })}
                      />
                    </div>
                  </Row>
                  <BackgroundSettings settings={settings} look={look} />
                    </>
                  }
                />
              </Row>
              {settings.mood === "auto" && (
                <Row title="Auto goes dark" sub="Ember, Auto's dark mood, between these times" look>
                  <div className="time-range">
                    <input
                      type="time"
                      aria-label="Dark from"
                      value={toClock(settings.autoDarkStart ?? 21 * 60)}
                      onChange={(e) => e.target.value && look({ autoDarkStart: fromClock(e.target.value) })}
                    />
                    <span>until</span>
                    <input
                      type="time"
                      aria-label="Dark until"
                      value={toClock(settings.autoDarkEnd ?? 5 * 60)}
                      onChange={(e) => e.target.value && look({ autoDarkEnd: fromClock(e.target.value) })}
                    />
                  </div>
                </Row>
              )}
              <Row title="Text size" sub="Also Ctrl + and Ctrl −">
                <Seg
                  label="Text size"
                  value={String(settings.zoom ?? 1)}
                  options={[
                    ["0.9", "Small"],
                    ["1", "Default"],
                    ["1.1", "Large"],
                    ["1.2", "Larger"],
                  ]}
                  onChange={(v) => void setZoom(Number(v))}
                />
              </Row>
              <Row
                title="Default look"
                sub={(() => {
                  // What a reset would change, by name, or that there's nothing to.
                  const off = [
                    settings.theme !== "system" && "theme",
                    settings.mood !== "classic" && "mood",
                    !accentFor(settings).auto && settings.accent.toLowerCase() !== DEFAULT_ACCENT && "accent",
                    !!settings.windowColor && "background",
                    (settings.cardTint || settings.cardFrost || settings.cardClear) && "inbox card",
                    settings.seasonal && "pattern",
                    (settings.zoom ?? 1) !== 1 && "text size",
                  ].filter(Boolean) as string[];
                  if (!off.length) return "You're on Post's defaults";
                  const list = off.length > 1 ? `${off.slice(0, -1).join(", ")} and ${off[off.length - 1]}` : off[0];
                  const cap = list[0].toUpperCase() + list.slice(1);
                  return `${cap} ${off.length > 1 ? "differ" : "differs"} from Post's defaults, and would go back`;
                })()}
              >
                <button
                  className="btn outline"
                  onClick={() => {
                    // Everything on this page, put back, with an Undo in case it was a slip.
                    const keys = ["theme", "mood", "accent", "windowColor", "cardTint", "cardClear", "cardFrost", "seasonal", "autoDarkStart", "autoDarkEnd"] as const;
                    const was = Object.fromEntries(keys.map((k) => [k, settings[k]])) as Partial<Settings>;
                    const wasZoom = settings.zoom ?? 1;
                    look({
                      theme: "system",
                      mood: "classic",
                      accent: AUTO_ACCENT,
                      windowColor: "",
                      cardTint: false,
                      cardClear: false,
                      cardFrost: false,
                      seasonal: false,
                      autoDarkStart: 21 * 60,
                      autoDarkEnd: 5 * 60,
                    });
                    if (wasZoom !== 1) void setZoom(1);
                    useStore.getState().snack({
                      text: "Appearance reset to the defaults",
                      action: {
                        label: "Undo",
                        run: () => {
                          set(was);
                          if (wasZoom !== 1) void setZoom(wasZoom);
                        },
                      },
                    });
                  }}
                >
                  Reset to defaults
                </button>
              </Row>
            </>
          )}
          {tab === "reading" && (
            <>
              <h4>Reading</h4>
              <Row
                title="Load images in emails"
                sub="When off, pictures from the web stay hidden until you choose to show them, so senders can't tell when you open their email"
              >
                <Switch label="Load images in emails" on={settings.remoteImages} onChange={(v) => set({ remoteImages: v })} />
              </Row>
              {settings.imageSenders.length > 0 && !settings.remoteImages && (
                <Row title="Always show images from" sub={settings.imageSenders.join(", ")}>
                  <button className="btn outline" onClick={() => set({ imageSenders: [] })}>
                    Clear list
                  </button>
                </Row>
              )}
              <Row title="Dark colors for emails" sub="In dark mode, recolor bright newsletters and messages to match">
                <Switch label="Dark colors for emails" on={settings.emailDarkMode} onChange={(v) => set({ emailDarkMode: v })} />
              </Row>
              <Row title="Expand sidebar on launch" sub="Otherwise it starts as a slim column of icons">
                <Switch
                  label="Expand sidebar on launch"
                  on={settings.sidebarOpen}
                  onChange={(v) => {
                    set({ sidebarOpen: v });
                    useStore.setState({ sidebarOpen: v });
                  }}
                />
              </Row>
            </>
          )}
          {tab === "compose" && (
            <>
              <h4>Writing</h4>
              <Row title="Compose opens in" col>
                <Seg<ComposeMode>
                  label="Compose opens in"
                  value={settings.composeMode}
                  options={[
                    ["inline", "Reading pane"],
                    ["floating", "Floating panel"],
                    ["fullscreen", "Full screen"],
                    ["window", "Separate window"],
                  ]}
                  onChange={(composeMode) => set({ composeMode })}
                />
              </Row>
              <Row title="Your name" sub="Shown to recipients. Leave blank to use just your address.">
                <input
                  className="input"
                  style={{ width: 220 }}
                  aria-label="Your name"
                  defaultValue={settings.displayName}
                  onBlur={(e) => set({ displayName: e.target.value.trim() })}
                />
              </Row>
              <Row title="Undo send" sub="How long you have to take a message back">
                <Seg
                  label="Undo send"
                  value={String(settings.undoSeconds)}
                  options={[
                    ["0", "Off"],
                    ["5", "5s"],
                    ["10", "10s"],
                    ["20", "20s"],
                    ["30", "30s"],
                  ]}
                  onChange={(v) => set({ undoSeconds: Number(v) })}
                />
              </Row>
              <Row
                title="Check before sending"
                sub="Catch a missing attachment or a weekday that doesn't match its date, and with AI on, a tone that reads sharper than you mean"
              >
                <Switch label="Check before sending" on={settings.sendCheck ?? true} onChange={(v) => set({ sendCheck: v })} />
              </Row>
              <Row title="Signature" sub="Added to new messages, replies and forwards" col>
                <textarea
                  className="input"
                  rows={4}
                  aria-label="Signature"
                  value={sig}
                  onChange={(e) => setSig(e.target.value)}
                  onBlur={() => set({ signature: sig })}
                  placeholder={"Best,\nYour name"}
                />
              </Row>
              <Row title="Templates" sub="Reusable snippets you can insert from the composer toolbar" col>
                <Templates value={settings.templates ?? []} onChange={(templates) => set({ templates })} />
              </Row>
            </>
          )}
          {tab === "notifications" && (
            <>
              <h4>Notifications</h4>
              <Row title="Notify for new email" sub='Windows notifications with "Reply" and "Mark as read" buttons'>
                <Switch label="Notifications" on={settings.notifications} onChange={(v) => set({ notifications: v })} />
              </Row>
              <Row title="Only notify for people" sub="Skip newsletters, promotions and automated mail">
                <Switch label="Only notify for people" on={settings.notifyPeopleOnly} onChange={(v) => set({ notifyPeopleOnly: v })} />
              </Row>
              <Row title="Quiet hours" sub="No notifications during these hours (the unread badge still updates)">
                <Switch label="Quiet hours" on={settings.quietHours} onChange={(v) => set({ quietHours: v })} />
              </Row>
              {settings.quietHours && (
                <Row title="Quiet from">
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select className="input" aria-label="Quiet hours start" value={settings.quietStart} onChange={(e) => set({ quietStart: Number(e.target.value) })}>
                      {hours.map((h) => (
                        <option key={h} value={h}>
                          {hourLabel(h)}
                        </option>
                      ))}
                    </select>
                    <span className="faint">to</span>
                    <select className="input" aria-label="Quiet hours end" value={settings.quietEnd} onChange={(e) => set({ quietEnd: Number(e.target.value) })}>
                      {hours.map((h) => (
                        <option key={h} value={h}>
                          {hourLabel(h)}
                        </option>
                      ))}
                    </select>
                  </div>
                </Row>
              )}
            </>
          )}
          {tab === "ai" && <AiSettings settings={settings} set={set} />}
          {tab === "shortcuts" && (
            <div className="settings-shortcuts">
              <h4>Keyboard shortcuts</h4>
              <Row title="Compose from anywhere" sub="Ctrl+Alt+M opens a new message, even when Post is in the background. Takes effect after restart.">
                <Switch label="Global compose shortcut" on={settings.globalShortcut} onChange={(v) => set({ globalShortcut: v })} />
              </Row>
              <ShortcutList />
            </div>
          )}
          {tab === "system" && (
            <>
              <h4>System & sync</h4>
              <SyncDetails />
              <Row title="Check for new mail every" sub="Post checks Gmail in the background">
                <Seg
                  label="Check frequency"
                  value={String(settings.pollSeconds)}
                  options={[
                    ["5", "5s"],
                    ["10", "10s"],
                    ["30", "30s"],
                    ["60", "1 min"],
                  ]}
                  onChange={(v) => set({ pollSeconds: Number(v) })}
                />
              </Row>
              <Row title="Start Post with Windows" sub="Runs quietly in the tray so mail and scheduled sends keep flowing">
                <Switch label="Start with Windows" on={settings.launchAtStartup} onChange={(v) => set({ launchAtStartup: v })} />
              </Row>
              <Row title="Default email app" sub="Open mailto: links in Post. Windows asks you to confirm in Settings.">
                <button className="btn outline" onClick={() => void api.makeDefaultMailApp()}>
                  Set as default…
                </button>
              </Row>
              <Row
                title="Cache for older email layouts"
                sub="Your newest 2,000 emails are always kept in full. Older ones you've opened are kept up to this size."
              >
                <Seg
                  label="Cache size"
                  value={String(settings.htmlCacheMb)}
                  options={[
                    ["50", "50 MB"],
                    ["150", "150 MB"],
                    ["500", "500 MB"],
                  ]}
                  onChange={(v) => set({ htmlCacheMb: Number(v) })}
                />
              </Row>
            </>
          )}
          {tab === "account" && (
            <>
              <h4>Account</h4>
              <AccountCard email={email ?? ""} name={settings?.displayName ?? ""} />
              <Row title="Sign out" sub="Connected through your own Google Cloud OAuth client">
                <button
                  className="btn danger"
                  onClick={() => {
                    if (window.confirm("Sign out of Post? Your local mail cache will be cleared.")) {
                      void api.signOut().then(() => {
                        useStore.setState({ settingsOpen: false });
                        void useStore.getState().init();
                      });
                    }
                  }}
                >
                  Sign out
                </button>
              </Row>
            </>
          )}
        </section>
      </div>
    </>,
    document.body,
  );
}
