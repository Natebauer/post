import { useStore } from "./store";
import { motionMs, reduceMotion } from "./motionTokens";

/**
 * Short-lived motion marks for things that just appeared, changed or are about to leave, so
 * components can animate them. Ids: "sec:<key>" for a sidebar section, "home:<module id>" for a
 * module on Home.
 */
export type Mark = "new" | "new-quiet" | "changed" | "leaving";

/**
 * Only one soft highlight plays at a time. One sync can bring a new email, change its section
 * and update a Home card at once; the first to claim the highlight gets it. The inbox list always
 * may (`force`), since that's where the new mail is.
 */
let highlightUntil = 0;
export function claimHighlight(force = false): boolean {
  const now = performance.now();
  if (!force && now < highlightUntil) return false;
  highlightUntil = now + motionMs("highlight");
  return true;
}

/** How long exit animations run before the item is actually removed (--slow-out). */
const leaveMs = () => motionMs("slow-out");

const timers = new Map<string, number>();

export function mark(id: string, kind: Mark, ms = kind === "leaving" ? leaveMs() + 200 : motionMs("highlight") + 100) {
  // Sections and Home modules tint when they arrive or change; pins only grow in.
  if ((kind === "new" || kind === "changed") && !id.startsWith("pin:") && !claimHighlight()) {
    if (kind === "changed") return;
    kind = "new-quiet";
  }
  useStore.setState((s) => ({ marks: { ...s.marks, [id]: kind } }));
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => {
      useStore.setState((s) => {
        const { [id]: _, ...rest } = s.marks;
        return { marks: rest };
      });
    }, ms),
  );
}

/** Play an exit animation on these ids, then resolve so the caller can remove them. */
export function leave(ids: string[]): Promise<void> {
  if (reduceMotion()) return Promise.resolve();
  ids.forEach((id) => mark(id, "leaving"));
  return new Promise((r) => window.setTimeout(r, leaveMs()));
}

export const useMark = (id: string): Mark | undefined => useStore((s) => s.marks[id]);
