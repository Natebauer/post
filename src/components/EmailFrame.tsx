import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Attachment } from "../api";
import { useStore } from "../store";
import { resolvedTheme } from "../theme";
import { fromComposeData, openCompose } from "../compose";
import { escapeHtml, parseAddressList } from "../util";
import { AArrowDown, AArrowUp, ExternalLink, Globe, Image as ImageIcon, ImageOff, Lock, LockOpen, Mail, Type } from "lucide-react";
import { highlightDom } from "./Highlight";
import { Popover } from "./Popover";
import { ImageViewer, imageName } from "./ImageViewer";
import { prepareEmail } from "../safeHtml";

/* ---------- color math for dark-mode adaptation ---------- */

type RGBA = [number, number, number, number];

function parseColor(s: string): RGBA | null {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function luminance([r, g, b]: RGBA) {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function toHsl([r, g, b]: RGBA): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h * 360, s, l];
}

function hsl(h: number, s: number, l: number, a: number) {
  return `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(1)}%, ${a})`;
}

function darkBg(c: RGBA) {
  const [h, s, l] = toHsl(c);
  // Light backgrounds become deep tones that keep a hint of their hue.
  return hsl(h, s * 0.45, 0.085 + (1 - l) * 0.42, c[3]);
}

function lightText(c: RGBA) {
  const [h, s, l] = toHsl(c);
  return hsl(h, Math.min(s, 0.75), Math.max(0.72, 0.93 - l * 0.35), c[3]);
}

/** Recolor light-themed email markup so it reads well on a dark surface. Images are left alone. */
function adaptDark(doc: Document) {
  const win = doc.defaultView!;
  const els = [doc.body, ...Array.from(doc.body.querySelectorAll<HTMLElement>("*"))];
  const changes: [HTMLElement, string, string][] = [];
  for (const el of els) {
    if (el.tagName === "IMG" || el.tagName === "svg" || el.closest("svg")) continue;
    const cs = win.getComputedStyle(el);
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg[3] > 0.05 && luminance(bg) > 0.35) changes.push([el, "background-color", darkBg(bg)]);
    const fg = parseColor(cs.color);
    if (fg && luminance(fg) < 0.4) changes.push([el, "color", lightText(fg)]);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const w = parseFloat(cs.getPropertyValue(`border-${side}-width`));
      if (w > 0) {
        const bc = parseColor(cs.getPropertyValue(`border-${side}-color`));
        if (bc && luminance(bc) > 0.5) changes.push([el, `border-${side}-color`, darkBg(bc)]);
      }
    }
  }
  for (const [el, prop, val] of changes) el.style.setProperty(prop, val, "important");
  doc.documentElement.style.setProperty("background", "transparent", "important");
}

/* ---------- text size: per email, with an automatic fix for unreadable sizes ---------- */

/** Text-size steps offered by the smaller/larger buttons, as a share of the email's own size. */
const SCALE_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.25, 2.5, 3];
const SCALE_KEY = "post.textScale";
const SCALE_KEEP = 500;

/** The text size you picked for each email, remembered on this computer (newest last). */
function loadScales(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SCALE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveScale(id: string, scale: number | null) {
  try {
    const all = loadScales();
    delete all[id];
    if (scale !== null) all[id] = scale;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - SCALE_KEEP))) delete all[old];
    localStorage.setItem(SCALE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the choice lasts until the email closes */
  }
}

/** Text sizes shared by the email and its ⋯ menu: the ones you picked, and Post's automatic fixes. */
const useScales = create<{ chosen: Record<string, number>; auto: Record<string, number> }>(() => ({ chosen: loadScales(), auto: {} }));

export type TextScale = ReturnType<typeof useTextScale>;

/** An email's text size: the one you picked (remembered per email), else Post's automatic fix. */
export function useTextScale(messageId: string) {
  const chosen = useScales((s) => s.chosen[messageId] ?? null);
  // The automatic fix EmailFrame measured for this email (1 when none is needed).
  const auto = useScales((s) => s.auto[messageId] ?? 1);
  const scale = chosen ?? auto;
  const setAuto = useCallback(
    (a: number) => useScales.setState((s) => (s.auto[messageId] === a ? s : { auto: { ...s.auto, [messageId]: a } })),
    [messageId],
  );
  const choose = (v: number | null) => {
    useScales.setState((s) => {
      const next = { ...s.chosen };
      if (v === null) delete next[messageId];
      else next[messageId] = v;
      return { chosen: next };
    });
    saveScale(messageId, v);
  };
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? SCALE_STEPS.find((x) => x > scale + 0.001) : [...SCALE_STEPS].reverse().find((x) => x < scale - 0.001);
    if (next !== undefined) choose(next);
  };
  return { chosen, auto, setAuto, scale, choose, step };
}

/** A ⋯ menu row with smaller / size / larger buttons; the size in the middle resets. */
export function TextSizeMenuRow({ messageId }: { messageId: string }) {
  const { chosen, auto, scale, choose, step } = useTextScale(messageId);
  return (
    <div className="menu-item menu-row">
      <Type size={15} /> Text size
      <div className="text-size" role="group" aria-label="Text size for this email">
        <button className="icon-btn sm" title="Smaller text" aria-label="Smaller text" disabled={scale <= SCALE_STEPS[0]} onClick={() => step(-1)}>
          <AArrowDown size={15} />
        </button>
        <button
          className="link-btn text-size-value"
          title={chosen === null ? "Show original size" : auto !== 1 ? "Let Post pick a readable size" : "Reset to original size"}
          disabled={chosen === null && auto === 1}
          onClick={() => choose(chosen === null ? 1 : null)}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          className="icon-btn sm"
          title="Larger text"
          aria-label="Larger text"
          disabled={scale >= SCALE_STEPS[SCALE_STEPS.length - 1]}
          onClick={() => step(1)}
        >
          <AArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}

/** One element's own text, with the inline sizes it came with so they can be put back. */
type TextBox = { el: HTMLElement; fs: number; lh: number | null; chars: number; fsInline: [string, string]; lhInline: [string, string] };

/** Every visible element that holds text of its own, with its rendered font size. */
function measureText(doc: Document): TextBox[] {
  const win = doc.defaultView!;
  const out: TextBox[] = [];
  for (const el of [doc.body, ...Array.from(doc.body.querySelectorAll<HTMLElement>("*"))]) {
    if (el.closest("svg, style, script, title")) continue;
    let chars = 0;
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) chars += (n.textContent || "").replace(/[\s ‌]+/g, "").length;
    if (!chars) continue;
    const cs = win.getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    // Leave 0–5px text alone: that's spacer cells and hidden preview text, not something to read.
    if (!(fs >= 6) || cs.visibility === "hidden" || !el.getClientRects().length) continue;
    const lh = cs.lineHeight.endsWith("px") ? parseFloat(cs.lineHeight) : null;
    const inline = (p: string): [string, string] => [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    out.push({ el, fs, lh, chars, fsInline: inline("font-size"), lhInline: inline("line-height") });
  }
  return out;
}

/** The size most of the email's words are set in (character-weighted median). */
function typicalSize(boxes: TextBox[]) {
  const total = boxes.reduce((n, b) => n + b.chars, 0);
  const sorted = [...boxes].sort((a, b) => a.fs - b.fs);
  let seen = 0;
  for (const b of sorted) if ((seen += b.chars) >= total / 2) return { size: b.fs, chars: total };
  return { size: 0, chars: total };
}

/** Comfortable reading sizes, in on-screen pixels. Outside these, Post adjusts the email. */
const READABLE_MIN = 12.5;
const READABLE_MAX = 24;
const READABLE_TARGET_UP = 15;
const READABLE_TARGET_DOWN = 18;

/** The scale that brings unreadably small or large text to a comfortable size, or 1. */
function autoScale(boxes: TextBox[], zoom: number) {
  const { size, chars } = typicalSize(boxes);
  // Too little text to judge (a picture with a short caption, say).
  if (chars < 40 || !size) return 1;
  const shown = size * zoom;
  const f = shown < READABLE_MIN ? READABLE_TARGET_UP / shown : shown > READABLE_MAX ? READABLE_TARGET_DOWN / shown : 1;
  return Math.round(Math.min(3, Math.max(0.5, f)) * 100) / 100;
}

function applyScale(boxes: TextBox[], scale: number) {
  for (const b of boxes) {
    if (scale === 1) {
      b.el.style.setProperty("font-size", ...b.fsInline);
      b.el.style.setProperty("line-height", ...b.lhInline);
      continue;
    }
    // Absolute sizes on every text holder, so nested text is scaled once rather than compounding.
    b.el.style.setProperty("font-size", `${(b.fs * scale).toFixed(2)}px`, "important");
    if (b.lh !== null) b.el.style.setProperty("line-height", `${(b.lh * scale).toFixed(2)}px`, "important");
  }
}

const BASE_CSS = (dark: boolean) => `
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  html { overflow-x: auto; overflow-y: hidden; }
  body {
    margin: 0; padding: 0;
    font-family: "Inter Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 15px; line-height: 1.6;
    color: ${dark ? "#e6e6e8" : "#1b1c1f"};
    background: transparent;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; }
  /* Pictures held back for privacy leave their space but no broken-image icon. */
  img:not([src]) { visibility: hidden; }
  /* Keep proportions when a sized image is narrowed, but leave a height-only image at the height
     the email asks for (an unconditional height: auto would blow it up to the photo's full size). */
  img[width] { height: auto; }
  table img { max-width: none; }
  a { color: ${dark ? "#9db0ff" : "#3653d4"}; }
  blockquote { margin: 0 0 0 .8ex; border-left: 2px solid ${dark ? "#444" : "#ccc"}; padding-left: 1ex; }
  pre { white-space: pre-wrap; }
  ${READING_CSS(dark)}
  /* Selection and search matches look the same as in the rest of Post. */
  ::selection { background: color-mix(in srgb, ${accentNow()} 30%, transparent); }
  mark {
    color: inherit;
    background: color-mix(in srgb, #f5c542 ${dark ? 30 : 38}%, transparent);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, #f5c542 ${dark ? 75 : 90}%, transparent);
    border-radius: 3px;
    padding: 0 1px;
  }
`;

/**
 * Email written by a person (no layout tables) reads like Post's plain-text mail: the same reading
 * face and measure, links in the accent with a soft underline, lists and code set with care, and
 * quoted replies set off by an accent rule instead of a gray one. Designed newsletters keep their
 * own look, since they style what they need.
 */
const READING_CSS = (dark: boolean) => {
  const root = getComputedStyle(document.documentElement);
  const font = root.getPropertyValue("--font-read").trim() || '"Inter Variable", "Segoe UI", system-ui, sans-serif';
  const accent = accentNow();
  const link = `color-mix(in srgb, ${accent} ${dark ? 68 : 82}%, ${dark ? "white" : "black"})`;
  const text = dark ? "#e6e6e8" : "#1b1c1f";
  const muted = dark ? "#a3a4a8" : "#62646b";
  return `
  body:not(:has(table)) {
    font-family: ${font};
    font-size: 15.5px; line-height: 1.72;
    color: color-mix(in srgb, ${text} 92%, transparent);
    max-width: 68ch;
    text-wrap: pretty;
  }
  body:not(:has(table)) a {
    color: ${link};
    text-decoration: none;
    background:
      linear-gradient(currentColor, currentColor) left 0 bottom 0 / 0% 1.5px no-repeat,
      linear-gradient(color-mix(in srgb, ${accent} 40%, transparent), color-mix(in srgb, ${accent} 40%, transparent)) left 0 bottom 0 / 100% 1px no-repeat;
    padding-bottom: 1px;
    transition: background-size .26s cubic-bezier(.2,.8,.2,1);
  }
  body:not(:has(table)) a:hover { background-size: 100% 1.5px, 100% 1px; }
  body:not(:has(table)) :is(ul, ol) { padding-left: 1.5em; margin: .5em 0 .9em; }
  body:not(:has(table)) li { margin: .2em 0; padding-left: .15em; }
  body:not(:has(table)) li::marker { color: color-mix(in srgb, ${accent} 70%, ${muted}); }
  body:not(:has(table)) :is(code, kbd, samp) {
    font-family: "Cascadia Mono", Consolas, ui-monospace, monospace;
    font-size: .86em;
    padding: .1em .4em;
    border-radius: 5px;
    background: color-mix(in srgb, ${text} ${dark ? 12 : 6}%, transparent);
  }
  body:not(:has(table)) pre {
    font-family: "Cascadia Mono", Consolas, ui-monospace, monospace;
    font-size: .86em;
    padding: .8em 1em;
    border-radius: 8px;
    background: color-mix(in srgb, ${text} ${dark ? 10 : 5}%, transparent);
  }
  body:not(:has(table)) pre code { padding: 0; background: none; }
  body:not(:has(table)) hr { border: 0; height: 1px; margin: 1.4em 0; background: color-mix(in srgb, ${text} 14%, transparent); }
  body:not(:has(table)) :is(h1, h2, h3) { line-height: 1.25; letter-spacing: -0.012em; text-wrap: balance; }
  blockquote:is(.gmail_quote, [type="cite"]), body:not(:has(table)) blockquote {
    margin: .6em 0 .6em 2px !important;
    padding: .1em 0 .1em 14px !important;
    border-left: 2px solid color-mix(in srgb, ${accent} 38%, transparent) !important;
    color: ${muted};
  }
  .gmail_attr { color: ${muted}; font-size: .9em; }
  /* Quoted history, folded behind a pill (see foldQuote). */
  details.post-quote { margin: 1em 0 0; }
  details.post-quote > summary {
    display: inline-flex; align-items: center; gap: 8px;
    list-style: none; cursor: pointer; user-select: none;
    padding: 3px 12px 3px 8px;
    border-radius: 999px;
    font: 500 12.5px/1.4 ${font};
    color: ${muted};
    background: color-mix(in srgb, ${text} ${dark ? 9 : 5}%, transparent);
    border: 1px solid color-mix(in srgb, ${text} ${dark ? 14 : 10}%, transparent);
    transition: background-color .15s ease, color .15s ease, border-color .15s ease;
  }
  details.post-quote > summary::-webkit-details-marker { display: none; }
  details.post-quote > summary:hover {
    color: ${link};
    background: color-mix(in srgb, ${accent} 10%, transparent);
    border-color: color-mix(in srgb, ${accent} 30%, transparent);
  }
  details.post-quote > summary .dots {
    display: inline-grid; place-items: center;
    height: 16px; padding: 0 5px; border-radius: 8px;
    font-size: 9px; letter-spacing: 1px;
    color: ${dark ? "#1b1c1f" : "#fff"};
    background: color-mix(in srgb, ${accent} 75%, ${muted});
  }
  details.post-quote[open] > summary { margin-bottom: .5em; }
  details.post-quote[open] > :not(summary) { animation: post-unfold .26s cubic-bezier(.2,.8,.2,1); }
  @keyframes post-unfold { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) { details.post-quote[open] > :not(summary) { animation: none; } }
`;
};

/** The app's current accent color, for styles inside the email's own document. */
function accentNow(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2a737b";
}

/** Inline cid: images by pointing them at the attachment protocol. */
function resolveCids(html: string, atts: Attachment[]) {
  if (!html.includes("cid:")) return html;
  return html.replace(/cid:([^"'\s)>]+)/gi, (m, cid) => {
    const id = decodeURIComponent(cid);
    const a = atts.find((x) => x.contentId === id || x.contentId === cid);
    return a ? a.url : m;
  });
}

/** What a link really points to, readable: "mailto:" addresses as plain addresses, URLs decoded. */
function linkLabel(href: string) {
  if (/^mailto:/i.test(href)) return href.slice(7).split("?")[0];
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/**
 * A link's address, readable at a glance: a lock for a secure site (an open lock when it isn't),
 * the site's name in full strength and the rest of the address quieter after it.
 */
function LinkAddress({ text }: { text: string }) {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(text);
  if (!m) {
    const mail = !/^[a-z][a-z0-9+.-]*:/i.test(text);
    return (
      <>
        {mail ? <Mail size={13} className="ls-ic" /> : <Globe size={13} className="ls-ic" />}
        <span className="ls-host">{text}</span>
      </>
    );
  }
  const secure = m[1].toLowerCase() === "https";
  const host = m[2].replace(/^www\./i, "");
  return (
    <>
      {secure ? <Lock size={12} className="ls-ic" /> : <LockOpen size={12} className="ls-ic insecure" />}
      <span className="ls-host">{host}</span>
      {m[3] && m[3] !== "/" && <span className="ls-rest">{m[3]}</span>}
    </>
  );
}

export function EmailFrame({
  html,
  attachments,
  highlight,
  sender,
  messageId,
}: {
  html: string;
  attachments: Attachment[];
  highlight?: string | null;
  /** The sender's address, for "always show images from this sender". */
  sender?: string;
  /** Which email this is, so its text size is remembered. */
  messageId: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const settings = useStore((s) => s.settings);
  const dark = resolvedTheme(settings) === "dark";
  const [original, setOriginal] = useState(false);
  // Hidden until the email is parsed and measured, so it appears at full height in one step.
  const [ready, setReady] = useState(false);
  // The body fades in on its own only when it arrives after the email is already showing; while
  // the email itself is still fading in (or loading out of sight), one fade is enough.
  const [quiet, setQuiet] = useState(false);
  // The address of the link under the mouse, shown like a browser's status bubble.
  const [hover, setHover] = useState<{ text: string; left: number; bottom: number } | null>(null);
  // Right-clicking a picture: a small menu to view it on its own, and the picture being viewed.
  const [imgMenu, setImgMenu] = useState<{ src: string; name: string; x: number; y: number } | null>(null);
  const [viewing, setViewing] = useState<{ src: string; name: string } | null>(null);
  const adapt = dark && (settings?.emailDarkMode ?? true) && !original;
  // Remote images can be held back (Settings → Appearance) so senders can't tell you opened it.
  const [showImages, setShowImages] = useState(false);
  useEffect(() => setShowImages(false), [html]);
  const trusted = !!sender && (settings?.imageSenders ?? []).includes(sender.toLowerCase());
  const { chosen, auto, setAuto, scale, choose } = useTextScale(messageId);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const rescale = useRef<((s: number) => void) | null>(null);
  useEffect(() => rescale.current?.(scale), [scale]);
  const blockRemote = !(settings?.remoteImages ?? true) && !trusted && !showImages;

  const prepared = useMemo(() => prepareEmail(resolveCids(html, attachments), blockRemote), [html, attachments, blockRemote]);
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>${BASE_CSS(dark && !original ? true : false)}</style><style>${prepared.styles}</style></head><body>${prepared.body}</body></html>`,
    [prepared, dark, original],
  );
  const alwaysShow = () => {
    const st = useStore.getState();
    const list = st.settings?.imageSenders ?? [];
    if (sender && !list.includes(sender.toLowerCase())) void st.saveSettings({ imageSenders: [...list, sender.toLowerCase()] });
  };

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    let paneRo: ResizeObserver | null = null;
    let done = false;
    let raf = 0;
    let natural = 0;
    const off = new AbortController();
    const signal = off.signal;
    setReady(false);
    rescale.current = null;
    let boxes: TextBox[] = [];
    // Emails built wider than the reading column (some newsletters are 775px) get the room they need: the
    // email area widens evenly on both sides into the pane's spare space. Only when the pane is
    // too narrow is the email scaled down to fit, so nothing is ever cut off on the right.
    const widen = () => {
      const doc = frame.contentDocument;
      const wrap = frame.parentElement;
      const pane = frame.closest<HTMLElement>(".read-scroll");
      if (!doc?.documentElement || !wrap) return;
      doc.documentElement.style.zoom = "";
      wrap.style.marginLeft = wrap.style.marginRight = "";
      natural = Math.max(natural, doc.documentElement.scrollWidth);
      const base = wrap.getBoundingClientRect();
      if (!pane || natural <= base.width + 1) return;
      const p = pane.getBoundingClientRect();
      const gutter = 16;
      const roomL = Math.max(0, base.left - p.left - gutter);
      const roomR = Math.max(0, p.left + pane.clientWidth - base.right - gutter);
      const extra = Math.min(natural - base.width, roomL + roomR);
      let l = Math.min(extra / 2, roomL);
      const r = Math.min(extra - l, roomR);
      l = extra - r;
      wrap.style.marginLeft = `${-l}px`;
      wrap.style.marginRight = `${-r}px`;
      const width = base.width + extra;
      if (natural > width + 1) doc.documentElement.style.zoom = String(width / natural);
    };
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      frame.style.height = `${h}px`;
    };
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      if (done) {
        fit();
        return;
      }
      done = true;
      if (adapt) {
        try {
          adaptDark(doc);
        } catch (e) {
          console.warn("dark adapt failed", e);
        }
      } else if (dark) {
        // "Original colors" in dark mode: show the email on a white card.
        doc.documentElement.style.background = "#fff";
        doc.body.style.color = "#1b1c1f";
      }
      if (highlight) highlightDom(doc.body, highlight);
      widen();
      try {
        boxes = measureText(doc);
        // Judged as it appears on screen: a wide email shrunk to fit the pane reads smaller than it's set.
        const a = autoScale(boxes, parseFloat(doc.documentElement.style.zoom) || 1);
        setAuto(a);
        applyScale(boxes, chosenRef.current ?? a);
        natural = 0;
      } catch (e) {
        console.warn("text size check failed", e);
      }
      rescale.current = (s) => {
        applyScale(boxes, s);
        natural = 0;
        widen();
        fit();
      };
      widen();
      fit();
      setQuiet(!!ref.current?.closest(".pane-waiting, .pane-opening, .layer-in"));
      setReady(true);
      ro = new ResizeObserver(fit);
      ro.observe(doc.documentElement);
      doc.querySelectorAll("img").forEach((img) =>
        img.addEventListener(
          "load",
          () => {
            widen();
            fit();
          },
          { signal },
        ),
      );
      const pane = frame.closest(".read-scroll");
      if (pane) {
        paneRo = new ResizeObserver(() => {
          widen();
          fit();
        });
        paneRo.observe(pane);
      }
      doc.addEventListener("mouseover", (e) => {
        const a = (e.target as Element).closest?.("a[href]");
        const href = a?.getAttribute("href")?.trim();
        if (!a || !href || href.startsWith("#")) return setHover(null);
        const pane = (frame.closest(".read-pane") ?? frame).getBoundingClientRect();
        setHover({ text: linkLabel(href), left: pane.left + 8, bottom: window.innerHeight - pane.bottom + 8 });
      }, { signal });
      doc.documentElement.addEventListener("mouseleave", () => setHover(null), { signal });
      // Links (left or middle click) open in your browser, never inside Post.
      const onLink = (e: MouseEvent) => {
        if (e.type === "auxclick" && e.button !== 1) return;
        const a = (e.target as Element).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        if (/^mailto:/i.test(href)) {
          const [addr, query] = href.slice(7).split("?");
          const params = new URLSearchParams(query || "");
          void openCompose(
            fromComposeData({
              to: parseAddressList(decodeURIComponent(addr)),
              cc: parseAddressList(params.get("cc") || ""),
              bcc: [],
              subject: params.get("subject") || "",
              html: params.get("body") ? `<p>${escapeHtml(params.get("body")!)}</p>` : "",
              attachments: [],
              forwardAttachments: [],
            }),
          );
        } else if (/^https?:/i.test(href)) {
          void openUrl(href);
        }
      };
      doc.addEventListener("click", onLink, { signal });
      doc.addEventListener("auxclick", onLink, { signal });
      // Right-click a picture for "View image" (anything else keeps the usual menu).
      doc.addEventListener(
        "contextmenu",
        (e) => {
          const img = (e.target as Element).closest?.("img");
          const src = img?.currentSrc || img?.getAttribute("src") || "";
          if (!img || !src) return;
          e.preventDefault();
          const box = frame.getBoundingClientRect();
          const z = parseFloat(doc.documentElement.style.zoom) || 1;
          setImgMenu({ src, name: imageName(src, img.getAttribute("alt")), x: box.left + e.clientX * z, y: box.top + e.clientY * z });
        },
        { signal },
      );
    };
    // Set up as soon as the HTML is parsed ("interactive"), not after every remote image loads.
    const poll = () => {
      const doc = frame.contentDocument;
      if (frame.contentWindow?.location.href === "about:srcdoc" && doc && doc.readyState !== "loading") onLoad();
      else raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    frame.addEventListener("load", onLoad);
    return () => {
      off.abort();
      setHover(null);
      cancelAnimationFrame(raf);
      frame.removeEventListener("load", onLoad);
      ro?.disconnect();
      paneRo?.disconnect();
    };
  }, [srcDoc, adapt, dark, highlight]);

  return (
    <div className={ready ? (quiet ? "frame-wrap ready quiet" : "frame-wrap ready") : "frame-wrap"}>
      {prepared.blocked > 0 && (
        <div className="images-held" role="status">
          <ImageOff size={14} />
          <span>Images are hidden so the sender can't tell you opened this.</span>
          <button className="link-btn" onClick={() => setShowImages(true)}>
            Show images
          </button>
          {sender && (
            <button className="link-btn" onClick={alwaysShow}>
              Always show from {sender}
            </button>
          )}
        </div>
      )}
      {chosen === null && auto !== 1 && (
        <div className="frame-note" role="status">
          <Type size={14} />
          <span>
            {auto > 1 ? "Post enlarged this email's small text" : "Post reduced this email's oversized text"} so it's easier to read.
          </span>
          <button className="link-btn" onClick={() => choose(1)}>
            Show original size
          </button>
        </div>
      )}
      <iframe
        ref={ref}
        // A fresh frame for each look (dark colors, search highlight) so nothing carries over.
        key={`${adapt}-${highlight ?? ""}`}
        className="email-frame"
        // No scripts and no popups: links are opened in your browser by the handler above.
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        title="Email content"
        style={!adapt && dark ? { borderRadius: 8, background: "#fff", padding: 0 } : undefined}
      />
      {imgMenu && (
        <Popover point={{ x: imgMenu.x, y: imgMenu.y }} onClose={() => setImgMenu(null)}>
          <button
            className="menu-item"
            onClick={() => {
              setViewing({ src: imgMenu.src, name: imgMenu.name });
              setImgMenu(null);
            }}
          >
            <ImageIcon size={15} /> View image
          </button>
          {/^https?:/i.test(imgMenu.src) && (
            <button
              className="menu-item"
              onClick={() => {
                void openUrl(imgMenu.src);
                setImgMenu(null);
              }}
            >
              <ExternalLink size={15} /> Open image in browser
            </button>
          )}
        </Popover>
      )}
      {viewing && <ImageViewer src={viewing.src} name={viewing.name} onClose={() => setViewing(null)} />}
      {hover && (
        <div className="link-status" style={{ left: hover.left, bottom: hover.bottom }} role="status">
          <LinkAddress text={hover.text} />
        </div>
      )}
      {dark && (settings?.emailDarkMode ?? true) && (
        <div className="frame-tools">
          <button className="link-btn" onClick={() => setOriginal((o) => !o)}>
            {original ? "Use dark colors" : "Show original colors"}
          </button>
        </div>
      )}
    </div>
  );
}
