import { useEffect } from "react";
import type { Folder } from "./api";
import { useStore } from "./store";
import * as A from "./actions";
import { isTypingTarget } from "./util";
import { togglePin } from "./components/Home";

const G_MAP: Record<string, Folder> = { i: "INBOX", t: "SENT", d: "DRAFT", b: "SNOOZED", "!": "SPAM", s: "SENT" };

const anyDialogOpen = () => !!document.querySelector('.modal[role="dialog"], [role="menu"]');
const isControl = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("button, a[href], [role='button'], [role='menuitem'], [role='option'] button");
const inReadingPane = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest(".read-pane");

export function useShortcuts() {
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState({ paletteOpen: !st.paletteOpen });
        return;
      }
      if (ctrl && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (st.askOpen) useStore.setState({ askOpen: false });
        else A.openAssistant();
        return;
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        useStore.setState({ settingsOpen: true });
        return;
      }
      // Text zoom (works everywhere, including while typing).
      if (ctrl && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        void A.setZoom((st.settings?.zoom ?? 1) + 0.1);
        return;
      }
      if (ctrl && e.key === "-") {
        e.preventDefault();
        void A.setZoom((st.settings?.zoom ?? 1) - 0.1);
        return;
      }
      if (ctrl && e.key === "0") {
        e.preventDefault();
        void A.setZoom(1);
        return;
      }
      if (isTypingTarget(e.target)) return;
      // Nothing reaches the mail behind an open dialog (Ask, Settings, the source viewer, …).
      if (anyDialogOpen() || st.askOpen || st.groupDrop) return;
      // Outside text fields, Ctrl+Z reverses the last delete, spam, snooze, pin, mark read, or send.
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        st.undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        A.toggleSidebar();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        window.dispatchEvent(new Event("post:focus-search"));
        return;
      }
      if (ctrl && e.key.toLowerCase() === "p" && st.thread) {
        e.preventDefault();
        const last = st.thread.messages.at(-1);
        if (last) A.printMessage(last);
        return;
      }
      if (ctrl || e.altKey) return;
      if (st.paletteOpen || st.settingsOpen || st.shortcutsOpen) return;

      if (Date.now() - gAt < 1500) {
        gAt = 0;
        const f = G_MAP[e.key.toLowerCase()];
        if (f) {
          e.preventDefault();
          A.goFolder(f);
        }
        return;
      }

      const handled = () => e.preventDefault();
      switch (e.key) {
        case "g":
          gAt = Date.now();
          return handled();
        // j/k and the arrow keys move to the next/previous conversation and open it.
        case "j":
          st.move(1, true);
          return handled();
        case "k":
          st.move(-1, true);
          return handled();
        // Arrow keys scroll the email when you're reading it; they move through the list otherwise.
        case "ArrowDown":
          if (inReadingPane(e.target)) return;
          st.move(1, true);
          return handled();
        case "ArrowUp":
          if (inReadingPane(e.target)) return;
          st.move(-1, true);
          return handled();
        case "Enter":
          // Enter on a focused button or link is that control's own click.
          if (isControl(e.target)) return;
          if (st.cursorId && st.cursorId !== st.selectedId) {
            if (st.folder === "DRAFT") void A.openDraftThread(st.cursorId);
            else st.select(st.cursorId);
          } else if (!st.selectedId) st.move(0, true);
          return handled();
        case "o":
          if (st.cursorId && st.cursorId !== st.selectedId) {
            if (st.folder === "DRAFT") void A.openDraftThread(st.cursorId);
            else st.select(st.cursorId);
          } else if (!st.selectedId) st.move(0, true);
          return handled();
        case "x":
          if (st.cursorId ?? st.selectedId) st.toggleCheck((st.cursorId ?? st.selectedId)!);
          return handled();
        case "u":
          st.select(null);
          return handled();
        case "Escape":
          if (st.checked.length) st.clearChecks();
          else if (st.search) st.setSearch(null);
          else st.select(null);
          return handled();
        case "/":
          window.dispatchEvent(new Event("post:focus-search"));
          return handled();
        case "c":
          A.compose();
          return handled();
        case "r":
          void A.respond("reply");
          return handled();
        case "a":
          void A.respond("replyAll");
          return handled();
        case "f":
          void A.respond("forward");
          return handled();
        case "#":
        case "Delete":
          void A.trash();
          return handled();
        case "!":
          void A.spam();
          return handled();
        case "p":
          if (st.selectedId && !st.selectedId.startsWith("outbox:")) void togglePin(st.selectedId);
          return handled();
        case "b":
          A.openSnooze();
          return handled();
        case "I":
          if (e.shiftKey) void A.markRead(true);
          return handled();
        case "U":
          if (e.shiftKey) void A.markRead(false);
          return handled();
        case "?":
          useStore.setState({ shortcutsOpen: true });
          return handled();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
