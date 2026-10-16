import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, errText, type Settings } from "./api";
import { useStore } from "./store";
import { applyTheme, onSystemThemeChange } from "./theme";
import { newDraft, type ComposeDraft } from "./compose";
import { Composer } from "./components/Composer";
import { WindowControls } from "./components/TitleBar";

interface Init {
  draft: ComposeDraft;
  settings: Settings;
  email: string;
}

// Cached so React StrictMode's double effect doesn't consume the init twice.
let initPromise: Promise<Init | null> | null = null;

/** Root for a standalone compose window. */
export function ComposeWindow() {
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const win = getCurrentWindow();
    void (async () => {
      try {
        initPromise ??= api.takeComposeInit(win.label) as Promise<Init | null>;
        const init = await initPromise;
        const info = await api.appState();
        useStore.setState({ info, settings: info.settings });
        applyTheme(info.settings);
        // If the hand-off was lost (e.g. the window was reloaded), start a fresh message.
        const d = init?.draft ?? newDraft(info.settings);
        setDraft(d);
        void win.setTitle(d.subject || "New message");
      } catch (e) {
        setError(errText(e));
      }
    })();
    const un = listen<Settings>("settings-changed", (e) => {
      useStore.setState({ settings: e.payload });
      applyTheme(e.payload);
    });
    const off = onSystemThemeChange(() => applyTheme(useStore.getState().settings));
    return () => {
      off();
      void un.then((f) => f());
    };
  }, []);

  if (draft) {
    return (
      <div style={{ height: "100%" }}>
        <Composer draft={draft} mode="window" />
      </div>
    );
  }
  // Never leave a frameless window without a way to move or close it.
  return (
    <div className="composer window">
      <div className="c-head" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>
          New message
        </span>
        <WindowControls />
      </div>
      <div className="empty">
        {error ? (
          <div>
            <div className="big">Couldn't open the composer</div>
            {error}
          </div>
        ) : (
          "Opening…"
        )}
      </div>
    </div>
  );
}
