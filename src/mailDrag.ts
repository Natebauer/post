import { api } from "./api";
import { useStore } from "./store";
import { motionMs, reduceMotion } from "./motionTokens";
import { setPin, unpinAnimated } from "./components/Home";
import { addSender, addToCategory, findSection } from "./senders";
import { hueFor } from "./components/Avatar";
import { initials } from "./util";

/**
 * Drag and drop with the pointer (HTML5 drag events don't reach the page in Post's window):
 * - an email onto Home pins it, onto the sidebar adds a section for its sender, and onto a
 *   section groups them (or teaches an AI category);
 * - a pinned email from Home back onto the inbox unpins it;
 * - a sidebar section onto Home adds it there as a module.
 */
let suppressClickUntil = 0;

/** True right after a drag ends, so the dragged item doesn't also treat it as a click. */
export const dragJustEnded = () => Date.now() < suppressClickUntil;

const THRESHOLD = 6;

function pointerDrag(
  e: React.PointerEvent,
  ghostText: [string, string],
  targets: string,
  bodyClass: string,
  onDrop: (target: HTMLElement) => void,
  /** The sender, drawn as their avatar on the ghost. */
  who?: { email: string; name: string },
) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let over: HTMLElement | null = null;

  const dropZone = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    for (const sel of targets.split("|")) {
      const el = hit?.closest<HTMLElement>(sel);
      if (el) return el;
    }
    return null;
  };

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
      ghost = document.createElement("div");
      ghost.className = "mail-ghost";
      const a = document.createElement("b");
      a.textContent = ghostText[0];
      const b = document.createElement("span");
      b.textContent = ghostText[1];
      const text = document.createElement("div");
      text.className = "mg-text";
      text.append(a, b);
      if (who) {
        const av = document.createElement("div");
        av.className = "avatar sm";
        av.style.setProperty("--h", String(hueFor((who.email || who.name).toLowerCase())));
        av.textContent = initials(who.name || who.email);
        ghost.append(av);
      }
      ghost.append(text);
      document.body.appendChild(ghost);
      document.body.classList.add("dragging", bodyClass);
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`;
    const zone = dropZone(ev.clientX, ev.clientY);
    if (zone !== over) {
      over?.classList.remove("drop-over");
      zone?.classList.add("drop-over");
      over = zone;
    }
  };

  /**
   * On a drop, the ghost fades out where it was let go; the target shows where the email went
   * (a pin grows into Pinned, a section tints). Otherwise it just goes.
   */
  const end = (into?: HTMLElement | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    if (!ghost) return false;
    const g = ghost;
    if (into && !reduceMotion()) {
      g.classList.add("landing");
      window.setTimeout(() => g.remove(), motionMs("med-out") + 40);
    } else g.remove();
    document.body.classList.remove("dragging", bodyClass);
    over?.classList.remove("drop-over");
    suppressClickUntil = Date.now() + 300;
    return true;
  };
  const cancel = () => void end();

  const up = () => {
    const target = over;
    if (end(target) && target) onDrop(target);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** A pinned card on Home, dragged back onto the inbox, comes unpinned. */
export function startPinDrag(
  e: React.PointerEvent<HTMLElement>,
  threadId: string,
  from: { email: string; name: string },
  subject: string,
) {
  const card = e.currentTarget;
  pointerDrag(e, [from.name || from.email, subject || "(no subject)"], ".list-pane", "dragging-pin", () => void unpinAnimated(threadId, card), from);
}

export function startMailDrag(
  e: React.PointerEvent,
  threadId: string,
  from: { email: string; name: string },
  subject: string,
) {
  pointerDrag(e, [from.name || from.email, subject || "(no subject)"], "[data-section]|[data-ask]|.read-pane.bare|.sidebar", "dragging-mail", (target) => {
    if (target.dataset.ask !== undefined) {
      useStore.setState({ askOpen: true, askThread: { threadId, subject, summarize: true } });
      return;
    }
    const key = target.dataset.section;
    if (key) {
      const section = findSection(key);
      if (section?.kind === "ai") void addToCategory(section, threadId);
      else if (section) useStore.setState({ groupDrop: { key, threadId, email: from.email, name: from.name, subject } });
      return;
    }
    if (target.classList.contains("sidebar")) {
      void addSender(from.email, from.name);
      return;
    }
    void (async () => {
      if (await api.isPinned(threadId)) {
        useStore.getState().snack({ text: "Already pinned", ms: 1800 });
        return;
      }
      await setPin(threadId, true);
    })();
  }, from);
}
