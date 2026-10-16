import type { Address, Message, Participant } from "./api";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DAY = 86_400_000;

/** Compact list timestamp: time today, "Mon" this week, "Oct 3" this year, else "3/14/22". */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (ms >= startToday - 6 * DAY) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

export function longDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const hours = diff / 3_600_000;
  if (hours < 1) return "";
  if (hours < 24) return `(${Math.floor(hours)} hour${Math.floor(hours) === 1 ? "" : "s"} ago)`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `(${days} day${days === 1 ? "" : "s"} ago)`;
  return "";
}

export function whenLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

export function initials(nameOrEmail: string): string {
  const s = nameOrEmail.replace(/<.*>/, "").replace(/["']/g, "").trim();
  if (!s) return "?";
  if (s.includes("@") && !s.includes(" ")) return s[0].toUpperCase();
  const parts = s.split(/\s+/).filter((p) => /[A-Za-z0-9À-￿]/.test(p[0]));
  if (parts.length === 0) return s[0].toUpperCase();
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Muted, theme-friendly hue for initials avatars. */
export function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function displayName(a: Address, me?: string): string {
  if (me && a.email.toLowerCase() === me) return "me";
  return a.name || a.email;
}

export function firstName(name: string): string {
  if (name.includes("@")) return name.split("@")[0];
  const n = name.split(/[\s,]+/)[0];
  return n || name;
}

/** "Alice, Bob, me" style participant line. */
export function participantLine(ps: Participant[], folder: string): string {
  if (ps.length === 0) return folder === "DRAFT" ? "(no recipients)" : "(unknown)";
  const label = (p: Participant) => (p.isMe ? "me" : ps.length > 1 ? firstName(p.name) : p.name);
  const prefix = folder === "SENT" || folder === "DRAFT" ? "To: " : "";
  if (ps.length <= 3) return prefix + ps.map(label).join(", ");
  return `${prefix}${label(ps[0])} .. ${ps.slice(-2).map(label).join(", ")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function addrHeader(a: Address): string {
  return a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.email)}&gt;` : escapeHtml(a.email);
}

export function bodyInner(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split("\n")
    .join("<br>");
}

export function messageHtml(m: Message): string {
  return m.html ? bodyInner(m.html) : textToHtml(m.text);
}

export function linkify(text: string): (string | { url: string })[] {
  const out: (string | { url: string })[] = [];
  const re = /\b(https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ url: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function parseAddressList(s: string): Address[] {
  const out: Address[] = [];
  const parts = s.split(/[,;\n]+/);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(.*?)<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() });
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) out.push({ name: "", email: p });
  }
  return out;
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function nextAt(dayOffset: number, hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function nextWeekday(weekday: number, hour: number): number {
  const d = new Date();
  let diff = (weekday - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** For showing mail-derived HTML read-only in the app (see safeHtml.ts). */
export { sanitizeHtml } from "./safeHtml";
