import { api, errText, type Folder, type HomeModuleCfg, type SenderView } from "./api";
import { useStore } from "./store";
import { leave, mark } from "./motion";

/**
 * Sidebar sections: drag an email onto the sidebar for a sender section; drag another onto a
 * section to group them (by sender, domain or subject word) or let Claude make it an AI category.
 */

const S = () => useStore.getState();

export const sectionKey = (v: SenderView) => v.id || v.email.toLowerCase();
export const sectionFolder = (v: SenderView): Folder => `sec:${sectionKey(v)}`;
const views = () => S().settings?.senderViews ?? [];

export function sectionOf(folder: Folder): SenderView | null {
  if (!folder.startsWith("sec:")) return null;
  const key = folder.slice(4);
  return views().find((v) => sectionKey(v) === key) ?? null;
}

export const findSection = (key: string) => views().find((v) => sectionKey(v) === key) ?? null;

/** Every address a section matches by sender. */
export function sectionSenders(v: SenderView): string[] {
  return Array.from(new Set([v.email, ...v.senders].filter(Boolean).map((s) => s.toLowerCase())));
}

async function saveViews(next: SenderView[], homeLayout?: HomeModuleCfg[]) {
  await S().saveSettings(homeLayout ? { senderViews: next, homeLayout } : { senderViews: next });
  void S().refreshInfo(); // picks up unread counts
}

/** Home layout without this section's module (a section only appears on Home when you put it there). */
function homeWithout(key: string): HomeModuleCfg[] | undefined {
  const layout = S().settings?.homeLayout ?? [];
  const id = `sec:${key}`;
  return layout.some((m) => m.id === id) ? layout.filter((m) => m.id !== id) : undefined;
}

/** Replace one section (by key) and offer Undo back to how it was. */
async function replaceSection(key: string, next: SenderView, text: string) {
  const before = views();
  const prev = before.find((v) => sectionKey(v) === key);
  await saveViews(before.map((v) => (sectionKey(v) === key ? next : v)));
  mark(`sec:${sectionKey(next)}`, "changed");
  mark(`home:sec:${sectionKey(next)}`, "changed");
  if (S().folder === `sec:${key}` && sectionKey(next) !== key) S().setFolder(sectionFolder(next));
  else if (S().folder === sectionFolder(next)) void S().loadThreads();
  S().snack({
    text,
    action: prev
      ? {
          label: "Undo",
          run: () => {
            void saveViews(views().map((v) => (sectionKey(v) === sectionKey(next) ? prev : v)));
            if (S().folder === sectionFolder(next)) S().setFolder(sectionFolder(prev));
          },
        }
      : undefined,
  });
}

function blank(email: string, name: string): SenderView {
  return { email: email.toLowerCase(), name: name || email, id: "", kind: "sender", senders: [], domains: [], subjects: [], description: "" };
}

export async function addSender(email: string, name: string) {
  const key = email.toLowerCase();
  if (!key) return;
  if (views().some((v) => sectionKey(v) === key || (v.kind !== "ai" && sectionSenders(v).length === 1 && sectionSenders(v)[0] === key))) {
    S().snack({ text: `${name || email} is already in the sidebar`, ms: 2000 });
    return;
  }
  // Marked before it's saved, so the row's first appearance is its entrance (marking it after
  // would show it, then restart it from nothing).
  mark(`sec:${key}`, "new");
  // Clear any Home slot left over from an earlier section with the same sender.
  await saveViews([...views(), blank(key, name)], homeWithout(key));
  S().snack({
    text: `Added ${name || email} to the sidebar`,
    action: { label: "Undo", run: () => void removeSection(key, true) },
  });
}

export async function removeSection(key: string, quiet = false) {
  const before = views();
  const removed = before.find((v) => sectionKey(v) === key);
  if (!removed) return;
  const index = before.indexOf(removed);
  const homeBefore = S().settings?.homeLayout ?? [];
  await leave([`sec:${key}`, `home:sec:${key}`]);
  // Removing a section takes it off Home too (Undo puts both back).
  await saveViews(before.filter((v) => v !== removed), homeWithout(key));
  if (S().folder === `sec:${key}`) S().setFolder("INBOX");
  if (quiet) return;
  S().snack({
    text: `Removed ${removed.name} from the sidebar`,
    action: {
      label: "Undo",
      run: () => {
        const back = [...views()];
        back.splice(Math.min(index, back.length), 0, removed);
        mark(`sec:${key}`, "new");
        if (homeBefore.some((m) => m.id === `sec:${key}`)) mark(`home:sec:${key}`, "new");
        void saveViews(back, homeBefore);
      },
    },
  });
}

/** Save edits from the section editor; a changed AI description re-sorts recent mail. */
export async function saveSection(key: string, next: SenderView) {
  const prev = findSection(key);
  await saveViews(views().map((v) => (sectionKey(v) === key ? next : v)));
  mark(`sec:${key}`, "changed");
  mark(`home:sec:${key}`, "changed");
  if (S().folder === `sec:${key}`) void S().loadThreads();
  if (next.kind === "ai" && prev && prev.description.trim() !== next.description.trim()) {
    void api.categoryClassify(sectionKey(next), true);
    S().snack({ text: `Re-sorting recent mail into ${next.name}…` });
  }
}

/* ---------------- grouping by drag and drop ---------------- */

export interface Dropped {
  key: string;
  threadId: string;
  email: string;
  name: string;
  subject: string;
}

export interface GroupOption {
  id: "senders" | "domain" | "subject" | "ai";
  label: string;
  sub: string;
  value?: string;
}

/** Personal email providers: sharing one says nothing about what two emails have in common. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com",
]);
const STOP = new Set(
  "your with from this that have about will been were what when there their here into more than just only also re fwd fw please thanks thank today week weekly update updates new news newsletter".split(" "),
);
const domainOf = (email: string) => email.toLowerCase().split("@")[1] ?? "";
const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w));

/** What two (or more) emails could be grouped by. */
export async function groupOptions(section: SenderView, drop: Dropped): Promise<GroupOption[]> {
  const senders = sectionSenders(section);
  const others = senders.filter((s) => s !== drop.email.toLowerCase());
  const opts: GroupOption[] = [];
  const newName = first(drop.name || drop.email);
  if (others.length === senders.length) {
    opts.push({
      id: "senders",
      label: "Group these senders",
      sub: `${section.kind === "group" ? section.name : first(section.name)} + ${newName}`,
    });
  }
  const d = domainOf(drop.email);
  if (d && !PERSONAL_DOMAINS.has(d) && (senders.some((s) => domainOf(s) === d) || section.domains.includes(d))) {
    opts.push({ id: "domain", label: `Everyone at @${d}`, sub: "Any address from this company", value: d });
  }
  // A word the dropped subject shares with this section's recent mail.
  try {
    const recent = await api.listThreads(sectionFolder(section), 0, 8);
    const theirs = new Set(recent.threads.filter((t) => t.threadId !== drop.threadId).flatMap((t) => words(t.subject)));
    const common = words(drop.subject).find((w) => theirs.has(w));
    if (common) opts.push({ id: "subject", label: `Subject mentions “${common}”`, sub: "From anyone", value: common });
  } catch {
    /* no suggestion */
  }
  opts.push({ id: "ai", label: "Let AI decide", sub: "Claude names it and sorts similar mail" });
  return opts;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** Apply a rule-based grouping option to the section the email was dropped on. */
export async function applyGroup(section: SenderView, drop: Dropped, opt: GroupOption) {
  const key = sectionKey(section);
  const wasSingle = section.kind !== "group";
  const next: SenderView = { ...section, kind: "group", senders: sectionSenders(section), domains: [...section.domains], subjects: [...section.subjects] };
  if (!next.id) next.id = key;
  if (opt.id === "senders") {
    if (!next.senders.includes(drop.email.toLowerCase())) next.senders.push(drop.email.toLowerCase());
    if (wasSingle) next.name = `${first(section.name)} + ${first(drop.name || drop.email)}`;
  } else if (opt.id === "domain" && opt.value) {
    if (!next.domains.includes(opt.value)) next.domains.push(opt.value);
    if (wasSingle) next.name = `@${opt.value}`;
  } else if (opt.id === "subject" && opt.value) {
    if (!next.subjects.includes(opt.value)) next.subjects.push(opt.value);
    if (wasSingle) next.name = cap(opt.value);
  }
  await replaceSection(key, next, `Grouped as “${next.name}”`);
}

/** Turn a section into an AI category: Claude names it from examples, then sorts recent mail. */
export async function makeAiCategory(section: SenderView, drop: Dropped) {
  const key = sectionKey(section);
  const recent = await api.listThreads(sectionFolder(section), 0, 4).catch(() => ({ threads: [] as { threadId: string }[] }));
  const examples = Array.from(new Set([drop.threadId, ...recent.threads.map((t) => t.threadId)]));
  const idea = await api.aiDescribeCategory(examples);
  // Same id, so its place on Home (and an open view of it) carries over.
  const next: SenderView = { ...section, id: key, kind: "ai", name: idea.name, description: idea.description };
  await api.categoryMark(sectionKey(next), examples, true);
  await replaceSection(key, next, `Created “${idea.name}” · sorting your recent mail…`);
  await api.categoryClassify(sectionKey(next));
}

/** Drop onto an AI category: it's an example of what belongs. */
export async function addToCategory(section: SenderView, threadId: string) {
  try {
    await api.categoryMark(sectionKey(section), [threadId], true);
    mark(`sec:${sectionKey(section)}`, "changed");
    S().snack({ text: `Added to ${section.name}`, ms: 2500 });
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

/** "Not in this category": removes it and teaches Claude what doesn't belong. */
export async function removeFromCategory(section: SenderView, threadIds: string[]) {
  try {
    await api.categoryMark(sectionKey(section), threadIds, false);
    if (S().folder === sectionFolder(section)) S().removeLocally(threadIds);
    S().snack({
      text: threadIds.length === 1 ? `Removed from ${section.name}` : `${threadIds.length} removed from ${section.name}`,
      action: {
        label: "Undo",
        run: () => void api.categoryMark(sectionKey(section), threadIds, true).then(() => S().loadThreads()),
      },
    });
  } catch (e) {
    S().snack({ text: errText(e) });
  }
}

/**
 * Edit a sender section or group by describing it: it becomes an AI category with that
 * description. The emails it holds now are kept as examples, and Claude sorts the rest.
 */
export async function describeSection(key: string, draft: SenderView, description: string) {
  const current = await api.listThreads(sectionFolder(draft), 0, 20).catch(() => ({ threads: [] as { threadId: string }[] }));
  const next: SenderView = { ...draft, id: key, kind: "ai", description };
  if (current.threads.length) await api.categoryMark(key, current.threads.map((t) => t.threadId), true);
  await replaceSection(key, next, `${next.name} is now sorted by Claude · sorting your recent mail…`);
  await api.categoryClassify(key, true);
}