import { prepareEmail } from "./safeHtml";
import { api, errText, type Folder, type Message, type ThreadDetail } from "./api";
import { forwardDraft, fromComposeData, newDraft, openCompose, replyDraft } from "./compose";
import { useStore } from "./store";
import { escapeHtml, longDate, messageHtml, whenLabel } from "./util";

const S = () => useStore.getState();

function fail(e: unknown) {
  S().snack({ text: errText(e) });
  void S().loadThreads();
}

/** Targets for an action: the multi-selection if any, else the open conversation. */
export function selectedIds(): string[] {
  const c = S().checked;
  if (c.length) return [...c];
  const id = S().selectedId;
  return id ? [id] : [];
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? `Conversation ${one}` : `${n} conversations ${many}`);

export async function trash(ids = selectedIds()) {
  if (!ids.length) return;
  if (S().folder === "TRASH") return restore(ids);
  S().removeLocally(ids);
  try {
    await api.trash(ids);
    S().snack({
      text: ids.length === 1 ? "Conversation moved to Trash" : `${ids.length} conversations moved to Trash`,
      action: { label: "Undo", run: () => void api.untrash(ids).then(() => S().loadThreads()) },
    });
  } catch (e) {
    fail(e);
  }
}

/** Archive: out of the inbox, still in All Mail. */
export async function archive(ids = selectedIds()) {
  if (!ids.length) return;
  S().removeLocally(ids);
  try {
    await api.labelThreads(ids, [], ["INBOX"]);
    S().snack({
      text: plural(ids.length, "archived"),
      action: { label: "Undo", run: () => void api.labelThreads(ids, ["INBOX"], []).then(() => S().loadThreads()) },
    });
  } catch (e) {
    fail(e);
  }
}

export async function star(threadId: string, on: boolean) {
  try {
    await api.labelThreads([threadId], on ? ["STARRED"] : [], on ? [] : ["STARRED"]);
    S().snack({ text: on ? "Starred" : "Star removed", ms: 1800 });
  } catch (e) {
    fail(e);
  }
}

/** Mute: the thread leaves the inbox, and later replies skip it without notifying. */
export async function mute(threadId: string, on: boolean): Promise<boolean> {
  if (on) S().removeLocally([threadId]);
  try {
    await api.muteThread(threadId, on);
    S().snack(
      on
        ? {
            text: "Muted. New replies will skip your inbox",
            action: {
              label: "Undo",
              run: () =>
                void api
                  .muteThread(threadId, false)
                  .then(() => api.labelThreads([threadId], ["INBOX"], []))
                  .then(() => S().loadThreads()),
            },
          }
        : { text: "Unmuted", ms: 1800 },
    );
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function restore(ids = selectedIds()) {
  if (!ids.length) return;
  S().removeLocally(ids);
  try {
    await api.untrash(ids);
    S().snack({ text: plural(ids.length, "restored") });
  } catch (e) {
    fail(e);
  }
}

export async function spam(ids = selectedIds()) {
  if (!ids.length) return;
  const isSpamFolder = S().folder === "SPAM";
  S().removeLocally(ids);
  try {
    await api.spam(ids, !isSpamFolder);
    S().snack({
      text: isSpamFolder ? plural(ids.length, "moved to Inbox") : plural(ids.length, "reported as spam"),
      action: isSpamFolder ? undefined : { label: "Undo", run: () => void api.spam(ids, false).then(() => S().loadThreads()) },
    });
  } catch (e) {
    fail(e);
  }
}

export async function markRead(read: boolean, ids = selectedIds()) {
  if (!ids.length) return;
  const was = S().threads.filter((t) => ids.includes(t.threadId) && t.unread === read).map((t) => t.threadId);
  useStore.setState({
    threads: S().threads.map((t) => (ids.includes(t.threadId) ? { ...t, unread: !read } : t)),
  });
  if (!read && S().selectedId && ids.includes(S().selectedId!)) S().select(null);
  try {
    await api.markRead(ids, read);
    if (ids.length > 1 || S().checked.length) {
      S().snack({
        text: `${ids.length} marked as ${read ? "read" : "unread"}`,
        action: was.length ? { label: "Undo", run: () => void api.markRead(was, !read) } : undefined,
      });
    }
  } catch (e) {
    fail(e);
  }
}

export async function markAllRead() {
  const folder = S().folder;
  try {
    const n = await api.markAllRead(folder);
    useStore.setState({ threads: S().threads.map((t) => ({ ...t, unread: false })) });
    S().snack({ text: n ? `Marked ${n} conversation${n === 1 ? "" : "s"} as read` : "Nothing unread here" });
  } catch (e) {
    fail(e);
  }
}

export async function snooze(threadId: string | string[], until: number) {
  const ids = Array.isArray(threadId) ? threadId : [threadId];
  const inSnoozed = S().folder === "SNOOZED";
  if (!inSnoozed) S().removeLocally(ids);
  try {
    for (const id of ids) await api.snooze(id, until);
    S().snack({
      text: `${ids.length > 1 ? `${ids.length} conversations snoozed` : "Snoozed"} until ${whenLabel(until)}`,
      action: {
        label: "Undo",
        run: () => void Promise.all(ids.map((id) => api.unsnooze(id))).then(() => S().loadThreads()),
      },
    });
    if (inSnoozed) void S().loadThreads();
  } catch (e) {
    fail(e);
  }
}

export async function unsnooze(threadId: string) {
  try {
    await api.unsnooze(threadId);
    if (S().folder === "SNOOZED") S().removeLocally([threadId]);
    S().snack({ text: "Moved back to Inbox" });
  } catch (e) {
    fail(e);
  }
}

export async function unsubscribe(messageId: string) {
  try {
    const r = await api.unsubscribe(messageId);
    S().snack({
      text:
        r === "done"
          ? "Unsubscribed"
          : r === "mailto"
            ? "Unsubscribe request sent"
            : "Opened the sender's unsubscribe page in your browser",
    });
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

export function goFolder(f: Folder) {
  S().setFolder(f);
}

export function compose() {
  void openCompose(newDraft(S().settings));
}

async function loadThread(threadId: string): Promise<ThreadDetail | null> {
  const cur = S().thread;
  if (cur && cur.threadId === threadId) return cur;
  const t = S().visibleThreads().find((x) => x.threadId === threadId);
  const folder = t?.folder && t.folder !== "SNOOZED" ? t.folder : S().folder === "SNOOZED" ? "INBOX" : S().folder;
  try {
    return await api.getThread(threadId, folder);
  } catch (e) {
    S().snack({ text: errText(e) });
    return null;
  }
}

/** Reply / reply all / forward. Defaults to the last real message of the open thread. */
/** Reply, reply all or forward; `text` starts the reply with a drafted body (from AI). */
export async function respond(kind: "reply" | "replyAll" | "forward", messageId?: string, threadId?: string, text?: string) {
  const id = threadId ?? S().selectedId;
  if (!id) return;
  const t = await loadThread(id);
  if (!t || !t.messages.length) return;
  if (threadId && threadId !== S().selectedId) S().select(threadId);
  const msgs = t.messages.filter((m) => !m.isDraft);
  const m = (messageId && msgs.find((x) => x.id === messageId)) || msgs[msgs.length - 1];
  if (!m) return;
  const me = S().info?.email ?? "";
  const d = kind === "forward" ? forwardDraft(m, S().settings) : replyDraft(m, kind === "replyAll", me, S().settings, text);
  void openCompose(d);
}

/** In Drafts, clicking a conversation opens the draft for editing. */
export async function openDraftThread(threadId: string) {
  const t = await loadThread(threadId);
  const d = t?.messages.filter((m) => m.isDraft).at(-1);
  if (!d) return S().select(threadId);
  try {
    await openCompose(fromComposeData(await api.loadDraft(d.id)));
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

/** Open the AI assistant, focused on the open email if there is one (otherwise the whole inbox). */
export function openAssistant() {
  const s = S();
  const t = s.thread && s.selectedId === s.thread.threadId ? s.thread : null;
  useStore.setState({ askOpen: true, askThread: t ? { threadId: t.threadId, subject: t.subject } : null });
}

export function openSnooze() {
  const ids = selectedIds();
  if (ids.length) useStore.setState({ snoozeFor: ids.join(",") });
}

export function toggleSidebar() {
  const open = !S().sidebarOpen;
  useStore.setState({ sidebarOpen: open });
  void S().saveSettings({ sidebarOpen: open });
}

// ---------- message tools ----------

export function printMessage(m: Message) {
  // The email is printed from a sealed frame: no scripts can run in it (only printing is allowed).
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  const who = (a: { name: string; email: string }) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email);
  const email = prepareEmail(messageHtml(m), !(S().settings?.remoteImages ?? true));
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title>
    <style>body{font-family:"Inter Variable","Segoe UI",sans-serif;font-size:13px;color:#111;margin:24px}
    h1{font-size:18px;margin:0 0 12px}.meta{color:#555;border-bottom:1px solid #ddd;padding-bottom:10px;margin-bottom:16px;line-height:1.6}
    img{max-width:100%}</style><style>${email.styles}</style></head><body>
    <h1>${escapeHtml(m.subject || "(no subject)")}</h1>
    <div class="meta"><b>From:</b> ${who(m.from)}<br><b>To:</b> ${m.to.map(who).join(", ")}${
      m.cc.length ? `<br><b>Cc:</b> ${m.cc.map(who).join(", ")}` : ""
    }<br><b>Date:</b> ${escapeHtml(longDate(m.date))}</div>${email.body}</body></html>`;
  frame.onload = () =>
    window.setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      window.setTimeout(() => frame.remove(), 1000);
    }, 150);
  document.body.appendChild(frame);
}

export async function saveOriginal(m: Message) {
  const name = (m.subject || "message").slice(0, 80);
  try {
    if (await api.saveRaw(m.id, name)) S().snack({ text: "Saved as .eml" });
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

export async function downloadAll(m: Message) {
  try {
    const n = await api.saveAllAttachments(m.id);
    if (n !== null) S().snack({ text: `Saved ${n} attachment${n === 1 ? "" : "s"}` });
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

export function searchFrom(email: string) {
  S().setSearch(`from:${email}`);
  void S().runRemoteSearch();
}

// ---------- zoom ----------

export async function setZoom(z: number) {
  const zoom = Math.round(Math.min(1.6, Math.max(0.8, z)) * 10) / 10;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(zoom);
  } catch {
    document.documentElement.style.zoom = String(zoom);
  }
  await S().saveSettings({ zoom });
  S().snack({ text: `Zoom ${Math.round(zoom * 100)}%`, ms: 1200 });
}
