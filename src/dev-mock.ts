/**
 * Dev-only fake backend so the UI can be previewed in a plain browser (npm run dev).
 * Never loaded inside the Tauri app.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Message, Settings, ThreadDetail, ThreadSummary } from "./api";

const me = "you@example.com";
const H = 3_600_000;
const now = Date.now();

const people = [
  ["Maya Chen", "maya@studio-north.co"],
  ["GitHub", "noreply@github.com"],
  ["Daniel Okafor", "daniel.okafor@gmail.com"],
  ["Figma", "team@figma.com"],
  ["Priya Raman", "priya@lumen.dev"],
  ["Delta Air Lines", "deltaairlines@t.delta.com"],
  ["Sam Whitaker", "sam.whitaker@outlook.com"],
  ["The Browser Company", "hello@thebrowser.company"],
  ["Lena Fischer", "lena@fischer.design"],
  ["Stripe", "receipts@stripe.com"],
];
const subjects = [
  ["Sketches for the spring campaign", "Attached a few directions, I think the second one has legs. Let me know what you think before Thursday."],
  ["[post] Fix sync backoff on 429 (#142)", "@you approved these changes. All checks have passed."],
  ["Dinner Saturday?", "We're thinking 7:30 at that Ethiopian place on 5th. Can you make it?"],
  ["Your weekly Figma digest", "3 files were updated by your team this week, including Mobile Onboarding v4."],
  ["Re: API contract review", "Agreed on the pagination changes. One question on the error envelope, see inline."],
  ["Your trip to Lisbon is confirmed", "Confirmation #HX7Q2L. Departing Fri, Nov 14 at 6:05 PM from JFK."],
  ["Quick favor", "Could you look over this cover letter when you get a chance? No rush at all."],
  ["Arc for Windows: what's new", "Split view, little arc improvements and a faster start-up time."],
  ["Invoice for October", "Hi! Please find attached the invoice for the October brand work. Thanks again."],
  ["Your receipt from Linear", "Receipt #2291-0441. Amount paid $96.00. Thanks for your business."],
];

const threads: ThreadSummary[] = Array.from({ length: 60 }, (_, i) => {
  const p = people[i % people.length];
  const s = subjects[i % subjects.length];
  return {
    threadId: `t${i}`,
    folder: "INBOX",
    date: now - i * 5.3 * H - 20 * 60_000,
    subject: s[0],
    snippet: s[1],
    participants:
      i % 4 === 0
        ? [
            { name: p[0], email: p[1], isMe: false, unread: false },
            { name: "me", email: me, isMe: true, unread: false },
          ]
        : [{ name: p[0], email: p[1], isMe: false, unread: i < 3 }],
    count: i % 4 === 0 ? 3 : 1,
    unread: i < 3 || i === 7,
    hasAttachments: i % 5 === 0 || i % 10 === 8,
    avatarEmail: p[1],
    snoozedUntil: null,
  };
});

const newsletterHtml = `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea"><tr><td align="center" style="padding:24px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e5e0d5">
<tr><td style="padding:28px 32px;background:#1f3b2c;color:#ffffff;border-radius:12px 12px 0 0">
<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b9d3c2">Weekly digest</div>
<div style="font-size:24px;font-weight:700;margin-top:6px">3 files updated this week</div></td></tr>
<tr><td style="padding:24px 32px;color:#333333;font-size:15px;line-height:1.6">
<p>Hi there,</p><p>Here's what changed across your team's files. <a href="https://example.com">Mobile Onboarding v4</a> got 14 new comments.</p>
<table width="100%" style="background:#f7f7f7;border:1px solid #e6e6e6;border-radius:8px"><tr><td style="padding:14px 16px;color:#555">
<b style="color:#111">Design System / Tokens</b><br>Updated by Maya Chen · 2 days ago</td></tr></table>
<p style="margin-top:22px"><a href="https://example.com" style="background:#1f3b2c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Open Figma</a></p>
</td></tr></table></td></tr></table>`;

const inviteIcs = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:mock-1@example.com",
  "DTSTART:20261020T190000Z",
  "DTEND:20261020T200000Z",
  "SUMMARY:Post design review",
  "LOCATION:Studio North, 3rd floor",
  'ORGANIZER;CN="GitHub Events":mailto:events@github.com',
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function msg(id: string, t: ThreadSummary, i: number, n: number): Message {
  const p = t.participants[0];
  const fromMe = n > 1 && i === 1;
  return {
    id,
    threadId: t.threadId,
    date: t.date - (n - 1 - i) * 3 * H,
    from: fromMe ? { name: "You", email: me } : { name: p.name, email: p.email },
    to: fromMe ? [{ name: p.name, email: p.email }] : [{ name: "", email: me }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: t.subject,
    snippet: t.snippet,
    labels: ["INBOX"],
    unread: false,
    isDraft: false,
    attachments:
      t.hasAttachments && i === n - 1
        ? [
            { filename: "spring-direction-02.png", mimeType: "image/png", size: 482_113, attachmentId: "a", partId: "2", contentId: null, inline: false, url: "https://picsum.photos/seed/post/600/400" },
            { filename: "Brief v3.pdf", mimeType: "application/pdf", size: 1_204_551, attachmentId: "b", partId: "3", contentId: null, inline: false, url: "" },
          ]
        : [],
    text: fromMe
      ? "Sounds great, Thursday works.\n\nI'll bring the printouts."
      : `${t.snippet}\n\nA couple more thoughts:\n- The palette feels calmer than last round\n- Type could go a touch larger on mobile\n\nhttps://example.com/board\n\nThanks!\n${p.name.split(" ")[0]}`,
    html: t.threadId === "t3" ? newsletterHtml : null,
    messageIdHeader: `${id}@mail.example.com`,
    references: "",
    canUnsubscribe: t.threadId === "t3",
    ics: t.threadId === "t2" && i === n - 1 ? inviteIcs : null,
  };
}

function detail(id: string): ThreadDetail {
  const t = threads.find((x) => x.threadId === id) ?? threads[0];
  return {
    threadId: t.threadId,
    subject: t.subject,
    snoozedUntil: null,
    messages: Array.from({ length: t.count }, (_, i) => msg(`${t.threadId}m${i}`, t, i, t.count)),
  };
}

const settings: Settings = {
  theme: "system",
  accent: "#2a737b",
  composeMode: "inline",
  signature: "Best,\nAlex",
  undoSeconds: 5,
  displayName: "Alex",
  notifications: true,
  launchAtStartup: true,
  htmlCacheMb: 150,
  pollSeconds: 5,
  emailDarkMode: true,
  sidebarOpen: false,
  zoom: 1,
  notifyPeopleOnly: false,
  quietHours: false,
  quietStart: 22,
  quietEnd: 7,
  templates: [{ name: "Thanks, will review", body: "Thanks! I'll take a look and get back to you by end of week." }],
  globalShortcut: true,
  aiEnabled: false,
  aiCapUsd: 5,
  homeLayout: [],
  listWidth: 0,
  remoteImages: true,
  imageSenders: [],
  senderViews: [],
  sendCheck: true,
  mood: "classic",
};

const mockMembers = new Set<string>();
/** Open the preview with ?signedout to walk through sign-in and the first-run extras. */
let mockSignedIn = !new URLSearchParams(location.search).has("signedout") && !new URLSearchParams(location.search).has("firstrun");
/** ?firstrun starts before the Google client is set up (the whole onboarding). */
let mockConfigured = !new URLSearchParams(location.search).has("firstrun");

export function installMock() {
  mockWindows("main");
  mockIPC(((cmd: string, args?: unknown): unknown => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "set_client":
        mockConfigured = true;
        return null;
      case "sign_in":
        mockSignedIn = true;
        return null;
      case "set_ai_key":
        return null;
      case "get_app_state":
        return {
          configured: mockConfigured,
          signedIn: mockSignedIn,
          // A first launch has no account yet (an address here means "reconnect").
          email: mockSignedIn ? me : "",
          settings,
          status: {
            phase: "backfill",
            backfilled: 41200,
            total: 80312,
            lastSync: now,
            online: true,
            error: null,
            rate: 96,
            spacingMs: 626,
          },
          unread: 4,
          counts: { INBOX: 4, DRAFT: 2, SNOOZED: 1 },
        };
      case "ask_inbox":
        return {
          answer: "Daniel suggested dinner Saturday at 7:30 at the Ethiopian place on 5th [1]. Priya's reply about the API contract is unrelated [2].",
          sources: threads.slice(2, 4).map((t, i) => ({ n: i + 1, threadId: t.threadId, subject: t.subject, from: t.participants[0]?.name ?? "", date: t.date })),
        };
      case "tone_check":
        return /idiot|ridiculous|!!!/i.test(a.text as string)
          ? { flag: true, note: "“This is ridiculous” may read as harsher than you intend." }
          : { flag: false, note: "" };
      case "ai_describe_category":
        return { name: "Dinner Plans", description: "Invitations and plans to get dinner or drinks with friends." };
      case "category_mark":
        for (const id of a.threadIds as string[]) (a.member ? mockMembers.add(id) : mockMembers.delete(id));
        return null;
      case "category_classify":
        return null;
      case "save_settings":
        Object.assign(settings, a.settings);
        return null;
      case "list_threads": {
        const f = a.folder as string;
        const sec = f.startsWith("sec:") ? settings.senderViews.find((v) => (v.id || v.email.toLowerCase()) === f.slice(4)) : null;
        const inSec = (t: (typeof threads)[number]) => {
          if (!sec) return false;
          if (sec.kind === "ai") return mockMembers.has(t.threadId);
          const who = t.participants.map((p) => p.email.toLowerCase());
          const senders = [sec.email, ...sec.senders].filter(Boolean).map((s) => s.toLowerCase());
          return (
            who.some((e) => senders.includes(e) || sec.domains.some((d) => e.endsWith(`@${d}`))) ||
            sec.subjects.some((w) => t.subject.toLowerCase().includes(w))
          );
        };
        const list = f.startsWith("sec:")
          ? threads.filter(inSec)
          : f === "INBOX"
            ? threads
            : f === "SENT"
              ? threads.slice(0, 8)
              : [];
        const off = a.offset as number;
        return { threads: list.slice(off, off + (a.limit as number)), total: list.length };
      }
      case "get_thread":
        return detail(a.threadId as string);
      case "search_local": {
        const q = String(a.query).toLowerCase();
        return threads.filter((t) => (t.subject + t.snippet + t.participants[0].name).toLowerCase().includes(q)).slice(0, 10);
      }
      case "search_remote":
        return new Promise<ThreadSummary[]>((r) => setTimeout(() => r([]), 800));
      case "list_outbox":
        return [];
      case "suggest_contacts": {
        const q = String(a.query).toLowerCase();
        return people.filter(([n, e]) => n.toLowerCase().includes(q) || e.includes(q)).map(([name, email]) => ({ name, email }));
      }
      case "queue_send":
        return { id: 1, sendAt: Date.now() + 5000, kind: (a.sendAt as number) ? "scheduled" : "undo" };
      case "save_draft":
        return { draftId: "d1", messageId: "m1" };
      case "list_send_as":
        return [
          { email: me, name: "Alex", isDefault: true },
          { email: "alex@work.example.com", name: "Alex (Work)", isDefault: false },
        ];
      case "rsvp_status":
        return {};
      case "rsvp":
        return null;
      case "mark_all_read":
        return 4;
      case "get_raw":
        return `Received: from mail.example.com\r\nFrom: Maya Chen <maya@studio-north.co>\r\nTo: ${me}\r\nSubject: Sketches\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nAttached a few directions...`;
      case "home_summary": {
        const it = (i: number, tag: string | null = null) => ({
          threadId: threads[i].threadId,
          messageId: `${threads[i].threadId}m0`,
          name: threads[i].participants[0].name,
          email: threads[i].participants[0].email,
          subject: threads[i].subject,
          snippet: threads[i].snippet,
          date: threads[i].date,
          tag,
        });
        return {
          receivedToday: 12,
          peopleToday: 3,
          unread: 4,
          waiting: [it(2), it(6)],
          waitingAi: true,
          noReply: [{ ...it(8), name: "Lena Fischer", email: "lena@fischer.design", subject: "Re: Invoice for October" }],
          pinned: [it(0)],
          packages: [
            { ...it(5, "Out for delivery"), name: "Amazon", email: "ship@amazon.com", subject: "Out for delivery: Desk lamp" },
            { ...it(9, "Shipped"), name: "Amazon", email: "ship@amazon.com", subject: "Shipped: USB-C cable (2-pack)" },
          ],
          trips: [{ ...it(5), subject: "Your trip to Lisbon is confirmed" }],
          invites: [{ threadId: "t2", messageId: "t2m0", subject: "Post design review", ics: inviteIcs }],
          attachments: [
            { threadId: "t0", messageId: "t0m0", from: "Maya Chen", date: now, filename: "spring-direction-02.png", mimeType: "image/png", size: 482113, attachmentId: "a", partId: "2", contentId: null, inline: false, url: "https://picsum.photos/seed/post/300/200" },
            { threadId: "t7", messageId: "t7m0", from: "Lena Fischer", date: now, filename: "Invoice-October.pdf", mimeType: "application/pdf", size: 88213, attachmentId: "b", partId: "2", contentId: null, inline: false, url: "" },
          ],
        };
      }
      case "calendar_upcoming": {
        const at = (d: number, h: number, m = 0) => {
          const x = new Date();
          x.setDate(x.getDate() + d);
          x.setHours(h, m, 0, 0);
          return x.toISOString();
        };
        return {
          status: "ok",
          message: "",
          enableUrl: null,
          events: [
            { id: "e1", title: "Coffee with Ava", start: at(0, 15), end: at(0, 16), allDay: false, location: "Blue Bottle, 5th Ave", link: "" },
            { id: "e0", title: "Design sync", start: at(0, 11), end: at(0, 11, 30), allDay: false, location: "https://us02web.zoom.us/j/853734", link: "https://calendar.google.com", meeting: "https://us02web.zoom.us/j/853734", calendar: "Work", color: "#4f8a6e" },
            { id: "e2", title: "Dentist", start: at(1, 9, 30), end: at(1, 10, 30), allDay: false, location: "", link: "", calendar: "Family", color: "#c0507a" },
            { id: "e3", title: "Dinner with Daniel", start: at(4, 19, 30), end: at(4, 21), allDay: false, location: "Ethiopian place on 5th", link: "" },
          ],
        };
      }
      case "is_pinned":
        return false;
      case "ai_status":
        return { hasKey: true, keyHint: "…a1B2", enabled: false, model: "claude-haiku-5-5", monthSpend: 0.0031, monthCalls: 4, cap: 5, capped: false };
      case "test_ai":
        return "OK";
      case "cancel_send":
        return null;
      case "plugin:event|listen":
        return Math.floor(Math.random() * 1e6);
      case "plugin:window|is_maximized":
        return false;
      default:
        return null;
    }
  }) as never);
}
