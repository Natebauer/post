import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Attachment } from "../api";
import { useStore } from "../store";
import { resolvedTheme } from "../theme";
import { fromComposeData, openCompose } from "../compose";
import { escapeHtml, parseAddressList } from "../util";
import { ImageOff } from "lucide-react";
import { highlightDom } from "./Highlight";
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
`;

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

export function EmailFrame({
  html,
  attachments,
  highlight,
  sender,
}: {
  html: string;
  attachments: Attachment[];
  highlight?: string | null;
  /** The sender's address, for "always show images from this sender". */
  sender?: string;
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
  const adapt = dark && (settings?.emailDarkMode ?? true) && !original;
  // Remote images can be held back (Settings → Appearance) so senders can't tell you opened it.
  const [showImages, setShowImages] = useState(false);
  useEffect(() => setShowImages(false), [html]);
  const trusted = !!sender && (settings?.imageSenders ?? []).includes(sender.toLowerCase());
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
      {hover && (
        <div className="link-status" style={{ left: hover.left, bottom: hover.bottom }} role="status">
          {hover.text}
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
