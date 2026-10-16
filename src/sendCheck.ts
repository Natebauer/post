import { api } from "./api";
import type { ComposeDraft } from "./compose";

/**
 * A last look before sending: a mentioned attachment that isn't attached, a weekday that doesn't
 * match its date ("Tuesday the 14th" when the 14th is a Wednesday), and, with AI on, a tone that
 * reads sharper than intended. Only your own text is checked, not the quoted email below it.
 */
export interface SendIssue {
  kind: "attach" | "date" | "tone";
  text: string;
}

function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("blockquote").forEach((b) => b.remove());
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

const ATTACH = /\b(attach(ed|ing|ment|ments)?|enclosed|see the (file|pdf|doc|document|spreadsheet)|I'?ve included)\b/i;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_DATE =
  /\b(mon|tues|wednes|thurs|fri|satur|sun)day,?\s+(?:the\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/gi;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "Tuesday the 14th" etc.: does the weekday match the date it most likely means? */
function dateIssues(text: string, now = new Date()): SendIssue[] {
  const out: SendIssue[] = [];
  for (const m of text.matchAll(WEEKDAY_DATE)) {
    const day = DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase()));
    const dom = Number(m[3]);
    if (day < 0 || dom < 1 || dom > 31) continue;
    let date: Date;
    if (m[2]) {
      const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      date = new Date(now.getFullYear(), month, dom);
      // A month well in the past means next year.
      if (date.getTime() < now.getTime() - 60 * 86_400_000) date = new Date(now.getFullYear() + 1, month, dom);
    } else {
      // Just a day of the month: the next time that date comes around.
      date = new Date(now.getFullYear(), now.getMonth(), dom);
      if (dom < now.getDate()) date = new Date(now.getFullYear(), now.getMonth() + 1, dom);
    }
    if (date.getDate() !== dom || date.getDay() === day) continue;
    const real = DAYS[date.getDay()];
    out.push({
      kind: "date",
      text: `“${m[0].trim()}”: the ${ordinal(dom)}${m[2] ? ` of ${date.toLocaleDateString(undefined, { month: "long" })}` : ""} is a ${real[0].toUpperCase()}${real.slice(1)}.`,
    });
  }
  return out;
}

export async function checkBeforeSend(d: ComposeDraft, aiOn: boolean): Promise<SendIssue[]> {
  const text = plainText(d.bodyHtml);
  const issues: SendIssue[] = [];
  if ((ATTACH.test(text) || ATTACH.test(d.subject)) && d.attachments.length === 0 && d.forwardAttachments.length === 0) {
    issues.push({ kind: "attach", text: "You mention an attachment, but nothing is attached." });
  }
  issues.push(...dateIssues(`${d.subject}. ${text}`));
  if (aiOn && text.length > 30) {
    try {
      const tone = await Promise.race([
        api.toneCheck(text),
        new Promise<null>((r) => window.setTimeout(() => r(null), 8000)),
      ]);
      if (tone?.flag) issues.push({ kind: "tone", text: tone.note || "Parts of this may read as sharper than you intend." });
    } catch {
      /* the check is a courtesy; never block sending on it */
    }
  }
  return issues;
}
