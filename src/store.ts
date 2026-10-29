import { cancelCloseFade, closeWithFade } from "./paneFade";
import { motionMs } from "./motionTokens";
import { create } from "zustand";
import {
  api,
  errText,
  type AppInfo,
  type Folder,
  type OutboxItem,
  type SendAs,
  type Settings,
  type SyncStatus,
  type ThreadDetail,
  type ThreadSummary,
} from "./api";
import type { ComposeDraft } from "./compose";
import type { Dropped } from "./senders";

export interface Snack {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  /** A second button after `action`, e.g. "Show in folder" beside "Open". */
  action2?: { label: string; run: () => void };
  ms?: number;
  leaving?: boolean;
  /** "sending": a ring that runs down the undo window, then a check as it goes. */
  icon?: "sending";
}

interface SearchState {
  query: string;
  local: ThreadSummary[];
  remote: ThreadSummary[] | null;
  remoteError: string | null;
  loading: boolean;
}

/** How long exit animations run before elements are removed. */
/** How long overlays and leaving rows take to go (the stylesheet's --med-out). */
export const exitMs = () => motionMs("med-out");

interface Store {
  info: AppInfo | null;
  settings: Settings | null;
  status: SyncStatus | null;
  unread: number;
  counts: Record<string, number>;

  folder: Folder;
  threads: ThreadSummary[];
  total: number;
  loadingList: boolean;
  outbox: OutboxItem[];

  /** The conversation open in the reading pane. */
  selectedId: string | null;
  /** Keyboard focus in the list (arrow keys move it without opening). */
  cursorId: string | null;
  /** Multi-selection for bulk actions. */
  checked: string[];
  /** Anchor for Shift+click range selection. */
  anchorId: string | null;
  /** Rows animating out before removal. */
  leaving: string[];
  thread: ThreadDetail | null;
  search: SearchState | null;
  recentSearches: string[];
  sendAs: SendAs[] | null;

  compose: ComposeDraft | null;
  composeMinimized: boolean;
  /** Overrides the compose mode for the current draft (e.g. a window that failed to open). */
  composeForcedMode: "floating" | null;

  sidebarOpen: boolean;
  /** Just signed in for the first time: "Make it yours" before the inbox (Setup.tsx). */
  welcome: boolean;
  /** The short tour over the app, after "Make it yours". */
  tour: boolean;
  /** Back in the Google setup from sign-in (to fix or replace the OAuth client). */
  editClient: boolean;
  /** The AI assistant is open. */
  askOpen: boolean;
  /** Ask is focused on one conversation (an email dropped on it, or "Summarize with AI"). */
  /** The email the assistant is focused on (null: the whole inbox). `summarize` starts with a summary. */
  askThread: { threadId: string; subject: string; summarize?: boolean } | null;
  /** The Home calendar shows a full month instead of the week. */
  calMonth: boolean;
  /** An email just dropped on a sidebar section, waiting for "group by…". */
  groupDrop: Dropped | null;
  /** The sidebar section being edited (its key). */
  sectionEdit: string | null;
  /** Things that just appeared, changed or are leaving, for animation (see motion.ts). */
  marks: Record<string, import("./motion").Mark>;
  paletteOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  snoozeFor: string | null;
  snacks: Snack[];
  authProblem: boolean;

  init: () => Promise<void>;
  refreshInfo: () => Promise<void>;
  setFolder: (f: Folder) => void;
  loadThreads: (opts?: { more?: boolean }) => Promise<void>;
  select: (id: string | null) => void;
  move: (delta: number, open?: boolean) => void;
  visibleThreads: () => ThreadSummary[];
  removeLocally: (ids: string[]) => void;
  toggleCheck: (id: string) => void;
  checkRange: (id: string) => void;
  clearChecks: () => void;
  setSearch: (q: string | null) => void;
  runRemoteSearch: () => Promise<void>;
  rememberSearch: (q: string) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  loadSendAs: () => Promise<SendAs[]>;
  snack: (s: Omit<Snack, "id">) => number;
  dropSnack: (id: number) => void;
  /** Reverse the most recent undoable action (Ctrl+Z). */
  undo: () => void;
  set: (p: Partial<Store>) => void;
}

let snackSeq = 1;
/** Every snackbar with an "Undo" button lands here, so Ctrl+Z works even after it fades. */
const undoStack: { snackId: number; run: () => void }[] = [];
let listSeq = 0;
let localSearchSeq = 0;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem("post.recentSearches") || "[]");
  } catch {
    return [];
  }
}

export const useStore = create<Store>((set, get) => ({
  info: null,
  settings: null,
  status: null,
  unread: 0,
  counts: {},
  folder: "INBOX",
  threads: [],
  total: 0,
  loadingList: false,
  outbox: [],
  selectedId: null,
  cursorId: null,
  checked: [],
  anchorId: null,
  leaving: [],
  thread: null,
  search: null,
  recentSearches: loadRecent(),
  sendAs: null,
  compose: null,
  composeMinimized: false,
  composeForcedMode: null,
  sidebarOpen: false,
  askOpen: false,
  welcome: false,
  tour: false,
  editClient: false,
  askThread: null,
  calMonth: false,
  groupDrop: null,
  sectionEdit: null,
  marks: {},
  paletteOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  snoozeFor: null,
  snacks: [],
  authProblem: false,

  set: (p) => set(p),

  init: async () => {
    // The backend may still be starting; retry briefly rather than guessing.
    let info: AppInfo | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        info = await api.appState();
        break;
      } catch (e) {
        if (attempt >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    set({
      info,
      settings: info.settings,
      status: info.status,
      unread: info.unread,
      counts: info.counts,
      sidebarOpen: info.settings.sidebarOpen,
    });
  },

  refreshInfo: async () => {
    const info = await api.appState();
    set({ info, settings: info.settings, status: info.status, unread: info.unread, counts: info.counts });
  },

  setFolder: (f) => {
    set({ folder: f, threads: [], total: 0, selectedId: null, cursorId: null, checked: [], search: null });
    void get().loadThreads();
  },

  loadThreads: async (opts) => {
    const { folder, threads } = get();
    const seq = ++listSeq;
    if (folder === "SCHEDULED") {
      const outbox = await api.listOutbox();
      if (seq === listSeq) set({ outbox, threads: [], total: outbox.length });
      return;
    }
    set({ loadingList: true });
    try {
      // On refresh, reload everything currently shown so scroll position is kept.
      const offset = opts?.more ? threads.length : 0;
      const limit = opts?.more ? 100 : Math.max(100, threads.length);
      const r = await api.listThreads(folder, offset, limit);
      if (seq !== listSeq) return;
      const leaving = get().leaving;
      const fresh = r.threads.filter((t) => !leaving.includes(t.threadId));
      set({
        threads: opts?.more ? [...threads, ...fresh] : fresh,
        total: r.total,
      });
    } catch (e) {
      get().snack({ text: errText(e) });
    } finally {
      if (seq === listSeq) set({ loadingList: false });
    }
  },

  visibleThreads: () => {
    const { search, threads } = get();
    if (!search) return threads;
    const seen = new Set<string>();
    const merged: ThreadSummary[] = [];
    for (const t of [...search.local, ...(search.remote ?? [])]) {
      if (seen.has(t.threadId)) continue;
      seen.add(t.threadId);
      merged.push(t);
    }
    merged.sort((a, b) => b.date - a.date);
    return merged;
  },

  select: (id) => {
    const apply = () => set({ selectedId: id, cursorId: id ?? get().cursorId, anchorId: id ?? get().anchorId });
    // Closing an email fades it out over Home first (paneFade.ts); anything else is immediate.
    if (id === null && get().selectedId && closeWithFade(apply)) return;
    cancelCloseFade();
    apply();
  },

  move: (delta, open = true) => {
    const list = get().visibleThreads().filter((t) => !get().leaving.includes(t.threadId));
    if (list.length === 0) return;
    const from = get().cursorId ?? get().selectedId;
    const i = list.findIndex((t) => t.threadId === from);
    const next = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    const id = list[next].threadId;
    if (open) set({ selectedId: id, cursorId: id, anchorId: id });
    else set({ cursorId: id });
  },

  removeLocally: (ids) => {
    const list = get().visibleThreads();
    const sel = get().selectedId;
    let nextSel = sel;
    if (sel && ids.includes(sel)) {
      const i = list.findIndex((t) => t.threadId === sel);
      const rest = list.filter((t) => !ids.includes(t.threadId));
      nextSel = rest.length ? rest[Math.min(i, rest.length - 1)].threadId : null;
    }
    // Animate rows out, then drop them so the rows below glide up.
    set({
      leaving: [...get().leaving, ...ids],
      selectedId: nextSel,
      cursorId: nextSel,
      checked: get().checked.filter((c) => !ids.includes(c)),
    });
    setTimeout(() => {
      const drop = (arr: ThreadSummary[]) => arr.filter((t) => !ids.includes(t.threadId));
      const s = get().search;
      set({
        threads: drop(get().threads),
        total: Math.max(0, get().total - ids.length),
        leaving: get().leaving.filter((l) => !ids.includes(l)),
        search: s ? { ...s, local: drop(s.local), remote: s.remote ? drop(s.remote) : null } : null,
      });
    }, exitMs());
  },

  toggleCheck: (id) => {
    const c = get().checked;
    // Starting a multi-selection includes the conversation that's currently open.
    const base = c.length === 0 && get().selectedId && get().selectedId !== id ? [get().selectedId!] : c;
    set({
      checked: base.includes(id) ? base.filter((x) => x !== id) : [...base, id],
      anchorId: id,
      cursorId: id,
    });
  },

  checkRange: (id) => {
    const list = get().visibleThreads();
    const anchor = get().anchorId ?? get().selectedId ?? id;
    const a = list.findIndex((t) => t.threadId === anchor);
    const b = list.findIndex((t) => t.threadId === id);
    if (a < 0 || b < 0) return get().toggleCheck(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = list.slice(lo, hi + 1).map((t) => t.threadId);
    set({ checked: Array.from(new Set([...get().checked, ...range])), cursorId: id });
  },

  clearChecks: () => set({ checked: [] }),

  setSearch: (q) => {
    if (q === null || q.trim() === "") {
      set({ search: null });
      return;
    }
    const prev = get().search;
    set({
      search: { query: q, local: prev?.local ?? [], remote: null, remoteError: null, loading: prev?.loading ?? false },
    });
    const seq = ++localSearchSeq;
    api
      .searchLocal(q)
      .then((local) => {
        const s = get().search;
        if (seq === localSearchSeq && s && s.query === q) set({ search: { ...s, local } });
      })
      .catch(() => {});
  },

  runRemoteSearch: async () => {
    const s = get().search;
    if (!s) return;
    const q = s.query;
    get().rememberSearch(q);
    set({ search: { ...s, loading: true, remoteError: null } });
    try {
      const remote = await api.searchRemote(q);
      const cur = get().search;
      if (cur && cur.query === q) set({ search: { ...cur, remote, loading: false } });
    } catch (e) {
      const cur = get().search;
      if (cur && cur.query === q) set({ search: { ...cur, loading: false, remoteError: errText(e) } });
    }
  },

  rememberSearch: (q) => {
    const t = q.trim();
    if (!t) return;
    const recent = [t, ...get().recentSearches.filter((r) => r !== t)].slice(0, 6);
    set({ recentSearches: recent });
    try {
      localStorage.setItem("post.recentSearches", JSON.stringify(recent));
    } catch {
      /* storage unavailable */
    }
  },

  saveSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ settings: next });
    await api.saveSettings(next);
  },

  loadSendAs: async () => {
    const have = get().sendAs;
    if (have) return have;
    try {
      const list = await api.listSendAs();
      set({ sendAs: list });
      return list;
    } catch {
      return [];
    }
  },

  snack: (s) => {
    const id = snackSeq++;
    let action = s.action;
    if (action && action.label === "Undo") {
      const entry = { snackId: id, run: action.run };
      undoStack.push(entry);
      if (undoStack.length > 25) undoStack.shift();
      // Clicking the button uses up the entry too, so Ctrl+Z won't repeat it.
      action = {
        ...action,
        run: () => {
          const i = undoStack.indexOf(entry);
          if (i >= 0) undoStack.splice(i, 1);
          entry.run();
        },
      };
    }
    set({ snacks: [...get().snacks.slice(-2), { ...s, action, id }] });
    const ms = s.ms ?? (s.action ? 8000 : 4000);
    if (ms > 0) setTimeout(() => get().dropSnack(id), ms);
    return id;
  },

  dropSnack: (id) => {
    if (!get().snacks.some((x) => x.id === id && !x.leaving)) return;
    set({ snacks: get().snacks.map((x) => (x.id === id ? { ...x, leaving: true } : x)) });
    setTimeout(() => set({ snacks: get().snacks.filter((x) => x.id !== id) }), exitMs());
  },

  undo: () => {
    const entry = undoStack.pop();
    if (!entry) {
      get().snack({ text: "Nothing to undo", ms: 1500 });
      return;
    }
    get().dropSnack(entry.snackId);
    entry.run();
    get().snack({ text: "Undone", ms: 1500 });
  },
}));
