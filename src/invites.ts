import { api, type Message, type ThreadDetail } from "./api";
import { sameAddr } from "./compose";
import { parseInvite, type Invite } from "./components/Invite";

/** A calendar invitation the user hasn't answered yet. */
export interface PendingInvite {
  m: Message;
  ics: string;
  inv: Invite;
}

/**
 * Invitations in a conversation still waiting for an answer: the latest request for each event,
 * minus events already answered (from Post, or a reply of yours in the thread) or already over.
 */
export async function pendingInvites(t: ThreadDetail, me: string): Promise<PendingInvite[]> {
  const found = await Promise.all(
    t.messages
      .filter((m) => !m.isDraft)
      .map(async (m) => {
        if (m.ics) return { m, ics: m.ics };
        const att = m.attachments.find((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename));
        const ics = att ? await fetch(att.url).then((r) => r.text()).catch(() => null) : null;
        return { m, ics };
      }),
  );
  const answered = new Set<string>();
  const requests = new Map<string, PendingInvite>();
  for (const { m, ics } of found) {
    const inv = ics ? parseInvite(ics) : null;
    if (!ics || !inv) continue;
    const method = inv.method.toUpperCase();
    if (method === "REPLY" && sameAddr(m.from, me)) answered.add(inv.uid);
    else if (method === "REQUEST" && !sameAddr(m.from, me)) requests.set(inv.uid || m.id, { m, ics, inv });
  }
  const list = [...requests.values()].filter((p) => !(p.inv.uid && answered.has(p.inv.uid)));
  const status = list.length ? await api.rsvpStatus(list.map((p) => p.m.id)).catch(() => ({}) as Record<string, string>) : {};
  const now = Date.now();
  return list
    .filter((p) => !status[p.m.id] && !(p.inv.start && p.inv.start.getTime() < now))
    .sort((a, b) => (a.inv.start?.getTime() ?? 0) - (b.inv.start?.getTime() ?? 0));
}

export const RSVP_VERB = { yes: "Accept", maybe: "Answer maybe to", no: "Decline" } as const;
export const RSVP_DONE = { yes: "Accepted", maybe: "Answered maybe to", no: "Declined" } as const;
export const RSVP_DOING = { yes: "Accepting", maybe: "Answering", no: "Declining" } as const;
export const invitations = (n: number) => `${n} invitation${n === 1 ? "" : "s"}`;
