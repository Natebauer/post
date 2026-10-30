/**
 * The list spreading out for a search, and coming back in. Nothing is resized frame by frame
 * (that re-lays out every row on every frame, and they switch layouts partway): the list takes
 * its new size at once and only a clip moves.
 *   - Spreading out: the list is already full width, and its clip opens from where its edge was.
 *   - Coming back (search closed, or an email opened beside it): a still copy of the wide list
 *     stays on top and its clip closes to the new edge, over the list already in its new place.
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

/** The still copy closes to `width` from its left edge, clearing its frost and fading out over its
 *  second half, so it never leaves a milky blur of the list underneath behind it. */
export function shrinkStill(copy: HTMLElement, width: number) {
  const right = copy.getBoundingClientRect().width - width;
  const r = getComputedStyle(copy).borderTopLeftRadius;
  const frost = getComputedStyle(copy).backdropFilter;
  const clear = frost && frost !== "none" ? "blur(0px) saturate(1)" : "none";
  copy
    .animate(
      [
        { clipPath: clip(0, r), opacity: 1, backdropFilter: frost },
        // Halfway, it's mostly over the list itself: its frost clears and it fades from there, so
        // its extra veil never sits on the list as a pale sheet.
        { opacity: 1, backdropFilter: clear, offset: 0.5 },
        { clipPath: clip(right, r), opacity: 0, backdropFilter: clear },
      ],
      { ...timing(), fill: "forwards" },
    )
    .finished.finally(() => copy.remove());
}

/** The list, already at its new width, opens out from the edge it had at `from`. */
export function revealList(list: HTMLElement, from: number) {
  const r = getComputedStyle(list).borderTopLeftRadius;
  list.animate([{ clipPath: clip(list.getBoundingClientRect().width - from, r) }, { clipPath: clip(0, r) }], timing());
}
