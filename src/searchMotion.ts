/**
 * The list spreading out for a search, and coming back in. Nothing is resized frame by frame
 * (that re-lays out every row on every frame, and they switch layouts partway): the list takes
 * its new size at once and only a clip moves.
 *   - Spreading out: the list is already full width, and its clip opens from where its edge was.
 *   - Coming back (search closed, or an email opened beside it): a still copy of the wide list
 *     stays on top and its clip closes to the new edge, where the list in its new place takes over.
 */

import { motionEase, motionMs } from "./motionTokens";

const clip = (right: number, r: string) => `inset(0 ${Math.max(0, right)}px 0 0 round ${r})`;

/** A still copy of the list as shown, laid exactly over it in the sheet. Take it before the layout changes. */
export function stillList(list: HTMLElement): HTMLElement | null {
  const sheet = list.parentElement;
  if (!sheet) return null;
  const s = sheet.getBoundingClientRect();
  const r = list.getBoundingClientRect();
  const cs = getComputedStyle(list);
  const copy = list.cloneNode(true) as HTMLElement;
  copy.setAttribute("aria-hidden", "true");
  copy.removeAttribute("aria-label");
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  Object.assign(copy.style, {
    position: "absolute",
    left: `${r.left - s.left}px`,
    top: `${r.top - s.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: "0",
    zIndex: "5",
    pointerEvents: "none",
    background: cs.background,
    boxShadow: cs.boxShadow,
    backdropFilter: cs.backdropFilter,
  });
  copy.style.setProperty("-webkit-backdrop-filter", cs.backdropFilter);
  // What a copy doesn't carry over: typed text and scroll positions.
  const inputs = list.querySelectorAll("input");
  copy.querySelectorAll("input").forEach((el, i) => (el.value = inputs[i]?.value ?? ""));
  sheet.appendChild(copy);
  const scrolled = list.querySelectorAll<HTMLElement>("*");
  copy.querySelectorAll<HTMLElement>("*").forEach((el, i) => scrolled[i]?.scrollTop && (el.scrollTop = scrolled[i].scrollTop));
  return copy;
}

const timing = () => ({ duration: motionMs("emphasis"), easing: motionEase("ease-move") });

/** The still copy closes to `width` from its left edge as one solid card, with the list under it
 *  hidden so the two never stack into a pale double veil. As it lands, the copy lets go of its card
 *  and the list's own card is there in the same spot, its contents crossfading with the copy's: one
 *  card that shrinks and then changes what it shows, not one card fading out over another. */
export function shrinkStill(copy: HTMLElement, width: number, list: HTMLElement) {
  const right = copy.getBoundingClientRect().width - width;
  const r = getComputedStyle(copy).borderTopLeftRadius;
  const t = timing();
  const swap = { duration: motionMs("med"), easing: motionEase("ease") };
  list.animate([{ opacity: 0 }, { opacity: 0 }], { duration: t.duration });
  for (const part of list.children) part.animate([{ opacity: 0 }, { opacity: 1 }], { ...swap, delay: t.duration, fill: "backwards" });
  copy
    .animate([{ clipPath: clip(0, r) }, { clipPath: clip(right, r) }], { ...t, fill: "forwards" })
    .finished.then(() => {
      Object.assign(copy.style, { background: "transparent", boxShadow: "none", backdropFilter: "none" });
      copy.style.setProperty("-webkit-backdrop-filter", "none");
      return copy.animate([{ opacity: 1 }, { opacity: 0 }], { ...swap, fill: "forwards" }).finished;
    })
    .finally(() => copy.remove());
}

/** The list, already at its new width, opens out from the edge it had at `from`. */
export function revealList(list: HTMLElement, from: number) {
  const r = getComputedStyle(list).borderTopLeftRadius;
  list.animate([{ clipPath: clip(list.getBoundingClientRect().width - from, r) }, { clipPath: clip(0, r) }], timing());
}
