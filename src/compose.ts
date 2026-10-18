import { emit } from "@tauri-apps/api/event";
import {
  api,
  errText,
  type Address,
  type ComposeData,
  type ForwardAttachment,
  type LocalAttachment,
  type Message,
  type Settings,
} from "./api";
import { useStore } from "./store";
import { addrHeader, escapeHtml, longDate, messageHtml, whenLabel } from "./util";

export type ComposeKind = "new" | "reply" | "replyAll" | "forward" | "draft";

/** The editable state of a message being written. */
export interface ComposeDraft {
  key: string;
  kind: ComposeKind;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
  quoteHtml: string | null;
  attachments: LocalAttachment[];
  forwardAttachments: ForwardAttachment[];
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
  draftId: string | null;
  from: Address | null;
}

/** The latest state of each open composer, by key. A composer that's remounted (for example when
 *  you switch threads and it moves to the side pane) starts from here instead of the original. */
export const liveDrafts = new Map<string, ComposeDraft>();

let keySeq = 0;
const newKey = () => `c${Date.now()}-${keySeq++}`;

export function signatureHtml(settings: Settings | null): string {
  const sig = settings?.signature?.trim();
  if (!sig) return "";
  return "<p></p><p></p>" + sig.split("\n").map((l) => `<p>${escapeHtml(l) || "<br>"}</p>`).join("");
}

export function newDraft(settings: Settings | null, partial?: Partial<ComposeData>): ComposeDraft {
  return {
    key: newKey(),
    kind: "new",
    to: partial?.to ?? [],
    cc: partial?.cc ?? [],
    bcc: partial?.bcc ?? [],
    subject: partial?.subject ?? "",
    bodyHtml: (partial?.html || "<p></p>") + signatureHtml(settings),
    quoteHtml: null,
    attachments: [],
    forwardAttachments: [],
    inReplyTo: null,
    references: null,
    threadId: null,
    draftId: null,
    from: null,
  };
}

export function fromComposeData(c: ComposeData): ComposeDraft {
  return {
    key: newKey(),
    kind: "draft",
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    bodyHtml: c.html || "<p></p>",
    quoteHtml: null,
    attachments: c.attachments ?? [],
    forwardAttachments: c.forwardAttachments ?? [],
    inReplyTo: c.inReplyTo ?? null,
    references: c.references ?? null,
    threadId: c.threadId ?? null,
    draftId: c.draftId ?? null,
    from: c.from ?? null,
  };
}

function prefixed(subject: string, prefix: "Re" | "Fwd"): string {
  const re = new RegExp(`^\\s*${prefix}:`, "i");
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

export const sameAddr = (a: Address, b: string) => a.email.toLowerCase() === b.toLowerCase();

/** Plain text as editor paragraphs (blank lines split paragraphs; single newlines become breaks). */
function textToParagraphs(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function replyDraft(m: Message, all: boolean, me: string, settings: Settings | null, text?: string): ComposeDraft {
  const fromMe = sameAddr(m.from, me);
  let to: Address[];
  let cc: Address[] = [];
  if (fromMe) {
    // Replying to your own message continues to its recipients.
    to = m.to;
    if (all) cc = m.cc;
  } else {
    to = m.replyTo.length ? m.replyTo : [m.from];
    if (all) {
      const seen = new Set([me.toLowerCase(), ...to.map((a) => a.email.toLowerCase())]);
      for (const a of [...m.to, ...m.cc]) {
        const e = a.email.toLowerCase();
        if (!seen.has(e)) {
          seen.add(e);
          cc.push(a);
        }
      }
    }
  }
  const refs = [m.references, m.messageIdHeader ? `<${m.messageIdHeader}>` : ""].filter(Boolean).join(" ");
  const quote =
    `<div class="gmail_quote"><div>On ${escapeHtml(longDate(m.date))}, ${addrHeader(m.from)} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
    `${messageHtml(m)}</blockquote></div>`;
  return {
    key: newKey(),
    kind: all ? "replyAll" : "reply",
    to,
    cc,
    bcc: [],
    subject: prefixed(m.subject, "Re"),
    bodyHtml: (text ? textToParagraphs(text) : "<p></p>") + signatureHtml(settings),
    quoteHtml: quote,
    attachments: [],
    forwardAttachments: [],
    inReplyTo: m.messageIdHeader ? `<${m.messageIdHeader}>` : null,
    references: refs || null,
    threadId: m.threadId,
    draftId: null,
    from: null,
  };
}

export function forwardDraft(m: Message, settings: Settings | null): ComposeDraft {
  const list = (as: Address[]) => as.map(addrHeader).join(", ");
  const quote =
    `<div class="gmail_quote">---------- Forwarded message ---------<br>` +
    `From: ${addrHeader(m.from)}<br>Date: ${escapeHtml(longDate(m.date))}<br>` +
    `Subject: ${escapeHtml(m.subject)}<br>To: ${list(m.to)}<br>` +
    (m.cc.length ? `Cc: ${list(m.cc)}<br>` : "") +
    `<br>${messageHtml(m)}</div>`;
  return {
    key: newKey(),
    kind: "forward",
    to: [],
    cc: [],
    bcc: [],
    subject: prefixed(m.subject, "Fwd"),
    bodyHtml: "<p></p>" + signatureHtml(settings),
    quoteHtml: quote,
    attachments: [],
    forwardAttachments: m.attachments
      .filter((a) => !a.inline)
      .map((a) => ({ messageId: m.id, partId: a.partId, filename: a.filename, mimeType: a.mimeType, size: a.size })),
    inReplyTo: null,
    references: null,
    threadId: m.threadId,
    draftId: null,
    from: null,
  };
}

export function toComposeData(d: ComposeDraft): ComposeData {
  return {
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    html: d.bodyHtml + (d.quoteHtml ? `<br>${d.quoteHtml}` : ""),
    attachments: d.attachments,
    forwardAttachments: d.forwardAttachments,
    inReplyTo: d.inReplyTo,
    references: d.references,
    threadId: d.threadId,
    draftId: d.draftId,
    from: d.from,
  };
}

/** Open a composer using the user's preferred compose mode. */
export async function openCompose(d: ComposeDraft) {
  const st = useStore.getState();
  if (st.settings?.composeMode === "window") {
    await api.openComposeWindow({ draft: d, settings: st.settings, email: st.info?.email ?? "" });
    return;
  }
  useStore.setState({ compose: d, composeMinimized: false, composeForcedMode: null });
}

export interface SentInfo {
  id: number;
  sendAt: number;
  kind: "undo" | "scheduled";
  draft: ComposeDraft;
}

/** Called after queue_send succeeds (in any window). Shows the undo snackbar in the main window. */
export function announceSent(info: SentInfo) {
  const st = useStore.getState();
  const snackId = st.snack({
    text: info.kind === "scheduled" ? `Scheduled for ${whenLabel(info.sendAt)}` : "Sending…",
    ms: info.kind === "scheduled" ? 8000 : Math.max(3000, info.sendAt - Date.now() + 500),
    icon: info.kind === "undo" ? "sending" : undefined,
    action: {
      label: "Undo",
      run: async () => {
        try {
          const back = await api.cancelSend(info.id);
          useStore.getState().dropSnack(snackId);
          if (back) {
            const d: ComposeDraft = { ...info.draft, key: newKey() };
            await openCompose(d);
            useStore.getState().snack({ text: info.kind === "scheduled" ? "Scheduled send canceled" : "Sending undone" });
          } else {
            useStore.getState().snack({ text: "Too late, it's already sent" });
          }
        } catch (e) {
          useStore.getState().snack({ text: errText(e) });
        }
      },
    },
  });
  if (info.kind === "scheduled") void useStore.getState().refreshInfo();
}

/** From a compose window, hand the sent info to the main window. */
export async function broadcastSent(info: SentInfo) {
  await emit("compose-sent", info);
}
