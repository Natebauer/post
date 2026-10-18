import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ComposeData, type Settings, type SyncStatus } from "./api";
import { useStore } from "./store";
import { announceSent, newDraft, openCompose, type ComposeDraft, type SentInfo } from "./compose";
import { applyTheme, onSystemThemeChange } from "./theme";
import { updateBadge } from "./badge";
import { useShortcuts } from "./keyboard";
import { useNavHistory } from "./history";
import { cx } from "./util";
import { fadePane, isClosingWithFade, registerPane } from "./paneFade";
import * as A from "./actions";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ThreadList } from "./components/ThreadList";
import { Splitter } from "./components/Splitter";
import { ThreadView } from "./components/ThreadView";
import { Composer } from "./components/Composer";
import { CommandPalette } from "./components/CommandPalette";
import { AskPanel } from "./components/Ask";
import { SettingsModal } from "./components/SettingsModal";
import { Shortcuts } from "./components/Shortcuts";
import { Snackbar } from "./components/Snackbar";
import { Tooltips } from "./components/Tooltip";
import { ClientSetup, SignIn, Tour, Welcome } from "./components/Setup";
import { TimePicker } from "./components/TimePicker";

function useBackendEvents() {
  useEffect(() => {
    const S = useStore.getState;
    let listTimer: number | undefined;
    const refreshOutbox = () => void api.listOutbox().then((outbox) => useStore.setState({ outbox })).catch(() => {});
    const subs = [
      listen<{ unread: number; counts: Record<string, number> }>("threads-changed", (e) => {
        useStore.setState({ unread: e.payload.unread, counts: e.payload.counts });
        window.clearTimeout(listTimer);
        listTimer = window.setTimeout(() => void S().loadThreads(), 250);
      }),
      listen<SyncStatus>("sync-status", (e) => useStore.setState({ status: e.payload })),
      listen("auth-required", () => {
        useStore.setState({ authProblem: true });
        void S().refreshInfo();
      }),
      listen("account", () => void S().refreshInfo()),
      listen<string>("open-thread", (e) => {
        const id = e.payload;
        if (!S().threads.some((t) => t.threadId === id)) S().setFolder("INBOX");
        S().select(id);
      }),
      listen<ComposeData>("mailto", (e) => void openCompose(newDraft(S().settings, e.payload))),
      listen("compose-new", () => A.compose()),
      // A compose window failed to start: continue the same draft here instead.
      listen<{ draft: ComposeDraft }>("compose-fallback", (e) => {
        useStore.setState({ compose: e.payload.draft, composeMinimized: false, composeForcedMode: "floating" });
        S().snack({ text: "The compose window didn't open, so your message is here instead.", ms: 6000 });
      }),
      listen<string>("reply-thread", (e) => {
        const id = e.payload;
        if (!S().threads.some((t) => t.threadId === id)) S().setFolder("INBOX");
        S().select(id);
        void A.respond("reply", undefined, id);
      }),
      listen<SentInfo>("compose-sent", (e) => announceSent(e.payload)),
      listen("outbox-changed", () => {
        refreshOutbox();
        if (S().folder === "SCHEDULED") void S().loadThreads();
      }),
      listen<{ error: string }>("outbox-failed", (e) =>
        S().snack({
          text: `Couldn't send: ${e.payload.error}`,
          action: { label: "View", run: () => S().setFolder("SCHEDULED") },
          ms: 12000,
        }),
      ),
      listen<Settings>("settings-changed", (e) => useStore.setState({ settings: e.payload })),
    ];
    refreshOutbox();
    void api.takeLaunchMailto().then((c) => c && void openCompose(newDraft(S().settings, c)));
    return () => {
      window.clearTimeout(listTimer);
      subs.forEach((p) => void p.then((f) => f()));
    };
  }, []);
}

/** Snooze picker opened with the B key, anchored to the reading header's … button. */
function SnoozeFromKeyboard() {
  const ids = useStore((s) => s.snoozeFor);
  const [fallback, setFallback] = useState<HTMLDivElement | null>(null);
  if (!ids) return null;
  const anchor = document.getElementById("read-more") ?? fallback;
  return (
    <>
      {!document.getElementById("read-more") && (
        <div ref={setFallback} style={{ position: "fixed", top: 52, right: 24, width: 1, height: 1 }} />
      )}
      {anchor && (
        <TimePicker
          anchor={anchor}
          kind="snooze"
          align="right"
          onClose={() => useStore.setState({ snoozeFor: null })}
          onPick={(ms) => {
            useStore.setState({ snoozeFor: null });
            void A.snooze(ids.split(","), ms);
          }}
        />
      )}
    </>
  );
}

/** Whether the reading pane shows something (an email, a selection or a composer) or Home. */
function paneHasContent(s: ReturnType<typeof useStore.getState>) {
  const mode = s.composeForcedMode ?? s.settings?.composeMode ?? "inline";
  const inThread = s.compose && s.compose.kind !== "new" && s.compose.threadId === s.selectedId;
  return !!s.selectedId || s.checked.length > 1 || (!!s.compose && mode === "inline" && !inThread);
}

function MainView() {
  const compose = useStore((s) => s.compose);
  const selectedId = useStore((s) => s.selectedId);
  const checked = useStore((s) => s.checked);
  const listWidth = useStore((s) => s.settings?.listWidth ?? 0);
  const forcedMode = useStore((s) => s.composeForcedMode);
  const settingsMode = useStore((s) => s.settings?.composeMode ?? "inline");
  const mode = forcedMode ?? settingsMode;
  const loadThreads = useStore((s) => s.loadThreads);
  useShortcuts();
  useNavHistory();

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const composeInThread = compose && compose.kind !== "new" && compose.threadId === selectedId;
  const paneComposer = compose && mode === "inline" && !composeInThread;
  // With nothing open, the reading pane drops its card and sits on the window background.
  const hasContent = !!selectedId || checked.length > 1 || !!paneComposer;

  // Opening or closing an email fades the email card over Home (see paneFade.ts). The still copy
  // has to be taken before React swaps the pane's content, so watch the store directly.
  const paneRef = useRef<HTMLDivElement>(null);
  const finishFade = useRef<(() => void) | null>(null);
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const was = paneHasContent(prev);
        const now = paneHasContent(s);
        // A close that already faded the real email out (closeWithFade) needs no copy.
        if (was !== now && !(was && isClosingWithFade())) finishFade.current = fadePane(paneRef.current, now);
      }),
    [],
  );
  useLayoutEffect(() => {
    registerPane(paneRef.current);
  }, []);
  useLayoutEffect(() => {
    finishFade.current?.();
    finishFade.current = null;
  }, [hasContent]);

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Sidebar />
        <main
          className="sheet"
          aria-label="Mail"
          style={listWidth ? ({ "--list-w": `${listWidth}px` } as React.CSSProperties) : undefined}
        >
          <ThreadList />
          <Splitter />
          <div ref={paneRef} className={cx("read-pane", !hasContent && "bare")} role="region" aria-label="Reading pane">
            {paneComposer ? <Composer key={compose.key} draft={compose} mode="pane" /> : <ThreadView />}
          </div>
        </main>
      </div>
      {compose && (mode === "floating" || mode === "fullscreen") && (
        <Composer key={compose.key} draft={compose} mode={mode} />
      )}
      <SnoozeFromKeyboard />
      <CommandPalette />
      <AskPanel />
      <SettingsModal />
      <Shortcuts />
      <Snackbar />
      <Tooltips />
    </div>
  );
}

export function App() {
  const info = useStore((s) => s.info);
  const settings = useStore((s) => s.settings);
  const unread = useStore((s) => s.unread);
  const authProblem = useStore((s) => s.authProblem);
  const welcome = useStore((s) => s.welcome);
  const editClient = useStore((s) => s.editClient);
  const tour = useStore((s) => s.tour);
  const init = useStore((s) => s.init);
  useBackendEvents();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    applyTheme(settings);
    return onSystemThemeChange(() => applyTheme(useStore.getState().settings));
  }, [settings]);

  useEffect(() => {
    void updateBadge(unread);
  }, [unread]);

  // Restore text zoom once settings arrive.
  const zoom = settings?.zoom ?? 1;
  useEffect(() => {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(zoom))
      .catch(() => {
        document.documentElement.style.zoom = String(zoom);
      });
  }, [zoom]);

  if (!info) return null;
  if (!info.configured || (editClient && !info.signedIn)) return <ClientSetup />;
  if (!info.signedIn) return <SignIn reconnect={authProblem || !!info.email} />;
  if (welcome) return <Welcome />;
  return (
    <>
      <MainView />
      {tour && <Tour />}
    </>
  );
}
