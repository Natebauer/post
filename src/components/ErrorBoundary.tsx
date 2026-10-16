import { Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Send a front-end problem to Post's log file (%APPDATA%\app.post.mail\post.log). */
export function logToBackend(message: string) {
  try {
    void invoke("log_frontend", { message: message.slice(0, 4000) }).catch(() => {});
  } catch {
    /* not running inside Post */
  }
}

async function closeWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    window.close();
  }
}

/**
 * Last line of defense: if anything throws while drawing, show what happened and a way out
 * instead of a blank, frameless window that can't be closed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logToBackend(`Render error: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-bar" data-tauri-drag-region>
          <span data-tauri-drag-region>Post</span>
          <button className="crash-x" onClick={() => void closeWindow()} aria-label="Close window" title="Close">
            ✕
          </button>
        </div>
        <div className="crash-body">
          <h1>Something went wrong</h1>
          <p>This window ran into a problem and couldn't finish drawing. It's been written to Post's log.</p>
          <pre>{error.message}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => location.reload()}>
              Try again
            </button>
            <button className="btn outline" onClick={() => void closeWindow()}>
              Close window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
