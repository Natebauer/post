/**
 * Opening and closing an email: the email card fades in over Home, and fades out over it.
 * Nothing else moves.
 *
 * The reading pane switches between Home and an email in one render, so the outgoing view is
 * kept as a still copy for the length of the fade:
 *   - Opening: a copy of Home stays underneath while the new email card fades in on top.
 *   - Closing: a copy of the email card stays on top and fades out, with Home already in place.
 */

import { flushSync } from "react-dom";
import { motionMs, READY_WAIT_MS, reduceMotion } from "./motionTokens";



/** A still copy of the pane, placed exactly over it inside the sheet. */
function stillCopy(pane: HTMLElement): HTMLElement | null {
  const sheet = pane.parentElement;
  if (!sheet) return null;
  const s = sheet.getBoundingClientRect();
  const r = pane.getBoundingClientRect();
  const copy = pane.cloneNode(true) as HTMLElement;
  copy.removeAttribute("role");
  copy.setAttribute("aria-hidden", "true");
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  copy.classList.add("pane-still");
  // An email's body is a sealed frame; copying it would make it reload (and flash empty for a
  // moment). Show a copy of what it has already drawn instead, kept apart in a shadow root so its
  // styles stay its own.
  const frames = pane.querySelectorAll("iframe");
  copy.querySelectorAll("iframe").forEach((f, i) => {
    const doc = frames[i]?.contentDocument;
    if (!doc?.documentElement) return;
    const r = frames[i].getBoundingClientRect();
    const host = document.createElement("div");
    host.className = f.className;
    host.style.cssText = f.style.cssText;
    Object.assign(host.style, { width: `${r.width}px`, height: `${r.height}px`, overflow: "hidden" });
    // The email's own styles, with its page and body rules pointed at stand-in elements.
    const root = host.attachShadow({ mode: "open" });
    const css = Array.from(doc.querySelectorAll("style"))
      .map((st) => (st.textContent ?? "").replace(/(^|[\s,}])html(?=[\s,{.:#\[])/g, "$1.doc").replace(/(^|[\s,}])body(?=[\s,{.:#\[])/g, "$1.body"))
      .join("\n");
    const page = document.createElement("div");
    page.className = "doc";
    page.style.cssText = doc.documentElement.style.cssText;
    const body = document.createElement("div");
    body.className = "body";
    body.style.cssText = doc.body.style.cssText;
    for (const a of Array.from(doc.body.attributes)) if (a.name !== "class" && a.name !== "style") body.setAttribute(a.name, a.value);
    body.append(...Array.from(doc.body.childNodes).map((n) => n.cloneNode(true)));
    page.append(body);
    const style = document.createElement("style");
    style.textContent = `:host{display:block}.doc{display:block;height:100%}.body{display:block}${css}`;
    root.append(style, page);
    f.replaceWith(host);
  });
  Object.assign(copy.style, {
    position: "absolute",
    left: `${r.left - s.left}px`,
    top: `${r.top - s.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: "0",
    pointerEvents: "none",
  });
  return copy;
}

function clearStills(sheet: HTMLElement) {
  sheet.querySelectorAll(".pane-still").forEach((el) => el.remove());
}

/**
 * Call before the pane changes between Home and an email (`opening` says which way).
 * Returns a function to call once the new content has rendered.
 */
export function fadePane(pane: HTMLElement | null, opening: boolean): (() => void) | null {
  if (!pane || reduceMotion()) return null;
  const sheet = pane.parentElement!;
  clearStills(sheet);
  pane.classList.remove("pane-opening", "pane-waiting");
  const copy = stillCopy(pane);
  if (!copy) return null;
  // Opening: Home's copy goes underneath (before the pane in the sheet), and is kept for when the
  // email closes. Closing: the copy goes on top (after it). Scrolled areas keep their position so
  // the copy matches the screen.
  if (opening) {
    homeCopy = copy.cloneNode(true) as HTMLElement;
    sheet.insertBefore(copy, pane);
  }
  else sheet.appendChild(copy);
  const scrolls = Array.from(pane.querySelectorAll<HTMLElement>("*")).map((el) => el.scrollTop);
  copy.querySelectorAll<HTMLElement>("*").forEach((el, i) => scrolls[i] && (el.scrollTop = scrolls[i]));

  return () => {
    if (opening) {
      // Wait (briefly) until the email has loaded, so it fades in whole rather than as loading
      // placeholders that then change.
      pane.classList.add("pane-waiting");
      const started = performance.now();
      // An email view is ready once its content is in and its body has drawn; anything else (a
      // composer, a selection) is ready straight away.
      const ready = () =>
        !pane.querySelector(".read-scroll") ||
        (!!pane.querySelector(".read-inner:not([aria-busy]):not(.layer-in)") &&
          !pane.querySelector(".read-inner:not(.layer-in) .frame-wrap:not(.ready)"));
      const go = () => {
        if (!pane.classList.contains("pane-waiting")) return;
        if (!ready() && performance.now() - started < READY_WAIT_MS) return void requestAnimationFrame(go);
        pane.classList.remove("pane-waiting");
        pane.classList.add("pane-opening");
        window.setTimeout(() => {
          pane.classList.remove("pane-opening");
          copy.remove();
        }, motionMs("pane-in") + 20);
      };
      requestAnimationFrame(go);
    } else {
      copy.classList.add("pane-closing");
      window.setTimeout(() => copy.remove(), motionMs("pane-out") + 20);
    }
  };
}

/* ---------- closing an email ---------- */

let paneEl: HTMLElement | null = null;
/** Home as it looked when the email opened, to sit under the email while it fades out. */
let homeCopy: HTMLElement | null = null;
let closing: { timer: number; under: HTMLElement } | null = null;

export function registerPane(el: HTMLElement | null) {
  paneEl = el;
}

/** Whether a close is fading right now (the pane swap that follows needs no copy of its own). */
export const isClosingWithFade = () => !!closing;

/**
 * Close the open email by fading the real email out (its fonts and images exactly as shown) over
 * Home, then `commit` the close. Returns false when it can't (then close straight away).
 */
export function closeWithFade(commit: () => void): boolean {
  const pane = paneEl;
  if (!pane || !homeCopy || reduceMotion() || pane.classList.contains("bare") || closing) return false;
  const sheet = pane.parentElement!;
  clearStills(sheet);
  pane.classList.remove("pane-opening", "pane-waiting");
  const under = homeCopy.cloneNode(true) as HTMLElement;
  const s = sheet.getBoundingClientRect();
  const r = pane.getBoundingClientRect();
  Object.assign(under.style, { left: `${r.left - s.left}px`, top: `${r.top - s.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  sheet.insertBefore(under, pane);
  pane.classList.add("pane-leaving");
  const timer = window.setTimeout(() => {
    // Render Home into the pane now and drop the copy in the same frame: if both showed at once,
    // anything see-through (faint text, the AI budget bar) would briefly draw twice as dark.
    flushSync(commit);
    pane.classList.remove("pane-leaving");
    under.remove();
    closing = null;
  }, motionMs("pane-out"));
  closing = { timer, under };
  return true;
}

/** Something else happened mid-fade (another email opened): stop and show the pane as it is. */
export function cancelCloseFade() {
  if (!closing || !paneEl) return;
  window.clearTimeout(closing.timer);
  closing.under.remove();
  paneEl.classList.remove("pane-leaving");
  closing = null;
}
