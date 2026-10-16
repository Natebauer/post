import { useEffect } from "react";
import type { Folder } from "./api";
import { useStore } from "./store";

interface Nav {
  folder: Folder;
  selectedId: string | null;
}

const navOf = (s: { folder: Folder; selectedId: string | null }): Nav => ({ folder: s.folder, selectedId: s.selectedId });
const keyOf = (n: Nav) => `${n.folder}|${n.selectedId ?? ""}`;

/**
 * Mirror navigation (folder + open conversation) into the webview's history so the mouse's
 * Back/Forward buttons and Alt+←/→ step through it. Back from an open email closes it or
 * returns to the previous one.
 */
export function useNavHistory() {
  useEffect(() => {
    let restoring = false;
    let last = keyOf(navOf(useStore.getState()));
    history.replaceState(navOf(useStore.getState()), "");

    const unsub = useStore.subscribe((s) => {
      const n = navOf(s);
      const k = keyOf(n);
      if (k === last) return;
      last = k;
      if (!restoring) history.pushState(n, "");
    });

    const onPop = (e: PopStateEvent) => {
      const n = e.state as Nav | null;
      if (!n) return;
      restoring = true;
      try {
        const s = useStore.getState();
        if (n.folder !== s.folder) s.setFolder(n.folder);
        s.clearChecks();
        s.select(n.selectedId);
        last = keyOf(n);
      } finally {
        restoring = false;
      }
    };

    // Handle the mouse's side buttons ourselves so behavior doesn't depend on the webview.
    const isNavButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
    const onDown = (e: MouseEvent) => {
      if (isNavButton(e)) e.preventDefault();
    };
    const onUp = (e: MouseEvent) => {
      if (!isNavButton(e)) return;
      e.preventDefault();
      if (e.button === 3) history.back();
      else history.forward();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        history.back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        history.forward();
      }
    };

    window.addEventListener("popstate", onPop);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey);
    return () => {
      unsub();
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
