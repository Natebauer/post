import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
// Styles, in cascade order (later files build on earlier ones).
import "./styles/01-base.css";
import "./styles/02-sidebar-list.css";
import "./styles/03-reading.css";
import "./styles/04-overlays-compose.css";
import "./styles/05-settings.css";
import "./styles/06-home.css";
import "./styles/07-sections-motion.css";
import "./styles/08-calendar-ask.css";
import "./styles/09-moods-header-layouts.css";
import { App } from "./App";
import { hideSplash } from "./splash";
import { ComposeWindow } from "./ComposeWindow";
import { ErrorBoundary, logToBackend } from "./components/ErrorBoundary";

// Suppress the browser context menu outside editable areas for a native feel.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, [contenteditable], .msg-body, .ProseMirror")) e.preventDefault();
});

// Scrollbars show while something scrolls and fade back afterwards (01-base.css).
const scrolling = new Map<Element, number>();
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target instanceof Element ? e.target : document.scrollingElement;
    if (!el) return;
    el.classList.add("is-scrolling");
    window.clearTimeout(scrolling.get(el));
    scrolling.set(
      el,
      window.setTimeout(() => {
        el.classList.remove("is-scrolling");
        scrolling.delete(el);
      }, 900),
    );
  },
  true,
);

// While another app has focus, Post's frame (title bar and sidebar) quiets down, like a native
// inactive window (01-base.css).
window.addEventListener("blur", () => document.documentElement.classList.add("win-inactive"));
window.addEventListener("focus", () => document.documentElement.classList.remove("win-inactive"));

// Anything that goes wrong in the UI ends up in Post's log, so problems can be diagnosed.
window.addEventListener("error", (e) => logToBackend(`Uncaught: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  logToBackend(`Unhandled promise rejection: ${r instanceof Error ? `${r.message}\n${r.stack}` : String(r)}`);
});

/** Compose windows are created with a "compose-…" label (see open_compose_window). */
async function isComposeWindow(): Promise<boolean> {
  if (window.location.hash.startsWith("#compose")) return true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label.startsWith("compose-");
  } catch {
    return false;
  }
}

async function start() {
  // Plain-browser preview during development: swap in a fake backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev-mock")).installMock();
  }
  const compose = await isComposeWindow();
  if (compose) {
    logToBackend("Compose window starting");
    hideSplash();
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>{compose ? <ComposeWindow /> : <App />}</ErrorBoundary>
    </React.StrictMode>,
  );
}

void start();
