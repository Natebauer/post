/**
 * The list changing its layout: spreading out for a search, coming back in, or dragged across
 * the width where its rows switch between two lines and one. Nothing is resized frame by frame
 * (that re-lays out every row on every frame, and they switch layouts partway): the list takes
 * its new size at once, a still copy of how it looked lies over it, and inside that copy every
 * email in both layouts travels piece by piece (photo, sender, subject line, date) to its new
 * place, its text narrowing or widening as it goes; what's only in one of them fades. When it
 * lands it looks exactly like the list underneath, which takes over.
 *   - Spreading out: the list is already full width and its clip opens from where its edge was;
 *     the copy's pieces travel out with it.
 *   - Coming back (search closed, or an email opened beside it): the copy carries the wide card
 *     and its clip closes to the new edge.
 *   - Dragged across a layout width: the card stays put and only what's in it moves.
 * An email open beside the list keeps its edge the same distance from the list's: uncovered by the
 * list's card as that closes, or drawn out to meet it as it opens.
 */

import { motionEase, motionMs } from "./motionTokens";
import { sizeFor } from "./components/ThreadList";

// Negative reaches past the right edge: a copy narrower than what's moving out of it.
const clip = (right: number, r: string) => `inset(0 ${right}px 0 0 round ${r})`;

/** The pieces of a row that find their own way to their new places. */
const PARTS = [".dot", ".avatar", ".row-from", ".row-sub", ".row-icons", ".row-date"];

type Box = { x: number; y: number; w: number; h: number };
const boxIn = (el: Element, base: DOMRect): Box => {
  const b = el.getBoundingClientRect();
  return { x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height };
};
const within = (b: Box, o: Box): Box => ({ x: b.x - o.x, y: b.y - o.y, w: b.w, h: b.h });
const place = (b: Box) => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
const inView = (el: Element, scroller: Element) => {
  const a = el.getBoundingClientRect();
  const v = scroller.getBoundingClientRect();
  return a.bottom > v.top && a.top < v.bottom;
};

/** A copy of the list, ids set aside (as data-still), typed text kept. */
function copyOf(list: HTMLElement): HTMLElement {
  const copy = list.cloneNode(true) as HTMLElement;
  copy.setAttribute("aria-hidden", "true");
  copy.removeAttribute("aria-label");
  copy.querySelectorAll<HTMLElement>("[id]").forEach((el) => {
    el.dataset.still = el.id;
    el.removeAttribute("id");
  });
  const inputs = list.querySelectorAll("input");
  copy.querySelectorAll("input").forEach((el, i) => (el.value = inputs[i]?.value ?? ""));
  return copy;
}
/** Scroll positions don't come with a copy; once it's in the page, give them back. */
function keepScroll(list: HTMLElement, copy: HTMLElement) {
  const scrolled = list.querySelectorAll<HTMLElement>("*");
  copy.querySelectorAll<HTMLElement>("*").forEach((el, i) => scrolled[i]?.scrollTop && (el.scrollTop = scrolled[i].scrollTop));
}

/** A still copy of the list as shown, laid exactly over it in the sheet. Take it before the layout
 *  changes. Without its `card`, it's only what's in the list, over the list's own card. */
export function stillList(list: HTMLElement, card = true): HTMLElement | null {
  const sheet = list.parentElement;
  if (!sheet) return null;
  const s = sheet.getBoundingClientRect();
  const r = list.getBoundingClientRect();
  const cs = getComputedStyle(list);
  const copy = copyOf(list);
  Object.assign(copy.style, {
    position: "absolute",
    left: `${r.left - s.left}px`,
    top: `${r.top - s.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: "0",
    zIndex: "5",
    pointerEvents: "none",
    background: card ? cs.background : "none",
    borderColor: card ? cs.borderColor : "transparent",
    boxShadow: card ? cs.boxShadow : "none",
    backdropFilter: card ? cs.backdropFilter : "none",
  });
  copy.style.setProperty("-webkit-backdrop-filter", copy.style.backdropFilter);
  copy.dataset.stillList = "";
  sheet.appendChild(copy);
  keepScroll(list, copy);
  return copy;
}

const timing = () => ({ duration: motionMs("search-move"), easing: motionEase("ease-move") });

/** The still copy closes to `width` from its left edge as one card, while what's inside it moves
 *  to where it sits in the list underneath (hidden until then, so the two never stack). An email
 *  opening `beside` it is uncovered by that edge rather than showing through the frosted card. */
export function shrinkStill(copy: HTMLElement, width: number, list: HTMLElement, beside?: HTMLElement | null) {
  const t = timing();
  const c = copy.getBoundingClientRect();
  const right = c.width - width;
  const r = getComputedStyle(copy).borderTopLeftRadius;
  const card = copy.animate([{ clipPath: clip(0, r) }, { clipPath: clip(right, r) }], { ...t, fill: "forwards" });
  const moves = [card, list.animate([{ opacity: 0 }, { opacity: 0 }], { duration: t.duration })];
  if (beside) {
    const p = beside.getBoundingClientRect();
    const gap = Math.max(0, p.left - (c.left + width));
    const pr = getComputedStyle(beside).borderTopLeftRadius;
    const under = (edge: number) => `inset(0 0 0 ${Math.max(0, edge + gap - p.left)}px round ${pr})`;
    moves.push(beside.animate([{ clipPath: under(c.right) }, { clipPath: under(c.left + width) }], t));
  }
  together(copy, list, card, moves, t.duration);
}

/** The email beside a list that's opening out has already narrowed to its new place; a stand-in
 *  of its card fills from where its edge was, and gives way as the list's edge comes across. */
function drawOut(beside: HTMLElement, list: HTMLElement, from: number, t: KeyframeAnimationOptions): Animation[] {
  const sheet = beside.parentElement;
  const cs = getComputedStyle(beside);
  if (!sheet || beside.classList.contains("bare")) return [];
  const s = sheet.getBoundingClientRect();
  const p = beside.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  const was = l.left + from + (p.left - l.right);
  const dx = p.left - was;
  if (dx < 1) return [];
  // It reaches just past the email's rounded corners, which it ends up matching.
  const r = parseFloat(cs.borderTopLeftRadius) || 0;
  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "absolute",
    left: `${was - s.left}px`,
    top: `${p.top - s.top}px`,
    width: `${dx + r + 2}px`,
    height: `${p.height}px`,
    background: cs.background,
    border: cs.border,
    borderRight: "none",
    borderRadius: `${cs.borderTopLeftRadius} 0 0 ${cs.borderBottomLeftRadius}`,
    boxShadow: cs.boxShadow,
    zIndex: "3",
    pointerEvents: "none",
  });
  sheet.appendChild(card);
  const edge = (x: number) => `inset(-24px 0 -24px ${x === 0 ? -24 : x}px round ${cs.borderTopLeftRadius} 0 0 ${cs.borderBottomLeftRadius})`;
  const a = card.animate([{ clipPath: edge(0) }, { clipPath: edge(dx) }], { ...t, fill: "forwards" });
  a.finished.finally(() => card.remove());
  return [a];
}

/** The list picks its row layout from its width a render or two later, and only then can its
 *  pieces be measured; until they are, everything waits at its first frame, so the card and what's
 *  in it start (and land) together as one motion. `card` ends it, taking the copy away. */
function together(copy: HTMLElement, list: HTMLElement, card: Animation, moves: Animation[], D: number, keep?: string) {
  moves.forEach((a) => a.pause());
  card.finished.finally(() => copy.remove());
  whenSettled(
    list,
    () => keepPlace(copy, list),
    () => {
      if (copy.isConnected) morph(copy, list, 0, D, keep);
      moves.forEach((a) => a.play());
    },
  );
}

/** The list, already full width for a search, opens out from the edge it had at `from`, and what
 *  was in it travels out to its one-line places as it does. Its header and filters are its own
 *  from the start (the field takes typing at once, the filters unfold themselves). */
export function growList(copy: HTMLElement, list: HTMLElement, from: number, beside?: HTMLElement | null, under?: HTMLElement | null) {
  const t = timing();
  const r = getComputedStyle(list).borderTopLeftRadius;
  const out = copy.getBoundingClientRect().width - list.getBoundingClientRect().width;
  // The list's own card opens out; the copy only carries what's in it.
  Object.assign(copy.style, { overflow: "visible", background: "none", borderColor: "transparent", boxShadow: "none", backdropFilter: "none" });
  copy.style.setProperty("-webkit-backdrop-filter", "none");
  const card = copy.animate([{ clipPath: clip(0, r) }, { clipPath: clip(out, r) }], { ...t, fill: "forwards" });
  const moves = [card, revealList(list, from)];
  // Already searching (beside an email), the field and filters it has travel with the rest;
  // otherwise the list's own come in, so typing shows at once and the filters unfold themselves.
  const searching = !!copy.querySelector(":scope > .search-panel");
  for (const el of list.children)
    if (el.matches(".list-head") && !searching) moves.push(el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: t.duration }));
    else if (searching || !el.matches(".search-panel")) moves.push(el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: t.duration }));
  if (beside) moves.push(...drawOut(beside, list, from, t));
  // An email closing as the list spreads over it fades, in step; the edge cuts it off rather than
  // passing over it, or the frosted card would blur it into a white haze.
  if (under) {
    const u = under.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const ur = getComputedStyle(under).borderTopLeftRadius;
    const cut = (edge: number) => `inset(0 0 0 ${Math.max(0, edge - u.left)}px round ${ur})`;
    const gone = under.animate(
      [{ opacity: 1, clipPath: cut(l.left + from) }, { opacity: 0, clipPath: cut(l.right) }],
      { ...t, fill: "forwards" },
    );
    gone.finished.finally(() => under.remove());
    moves.push(gone);
  }
  together(copy, list, card, moves, t.duration, searching ? undefined : ".list-head, .search-panel");
}

/** The list was dragged across the width where its rows change layout: what's in it moves to its
 *  new places over its own card, quicker than a search spreading out. */
export function relayoutList(copy: HTMLElement, list: HTMLElement) {
  const d = motionMs("search-move") * 0.8;
  const card = copy.animate([{ opacity: 1 }, { opacity: 1 }], { duration: d });
  const moves = [card, ...[...list.children].map((el) => el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: d }))];
  together(copy, list, card, moves, d);
}

/** Once the list is in its new layout. Usually that's straight away (the list takes it in the same
 *  render), so things move from the very frame they were asked to; otherwise once it has looked the
 *  same for a few frames. `laidOut` runs once the new layout is in, and may scroll, so the wait
 *  starts over after it (newly scrolled-to rows render a frame later). */
function whenSettled(list: HTMLElement, laidOut: () => void, go: () => void) {
  const scroller = list.querySelector<HTMLElement>(":scope > .list-scroll");
  const laid = () => list.classList.contains(`size-${sizeFor(list.getBoundingClientRect().width)}`);
  // React finishes the layout's renders before this task ends.
  queueMicrotask(() => {
    if (!laid()) return wait(list, laidOut, go);
    const top = scroller?.scrollTop;
    laidOut();
    if (scroller?.scrollTop === top) go();
    else wait(list, () => {}, go);
  });
}

function wait(list: HTMLElement, laidOut: () => void, go: () => void) {
  let last = "";
  let same = 0;
  let frames = 0;
  let ready = false;
  const shape = () =>
    list.className + [...list.querySelectorAll<HTMLElement>(".row, .list-group")].map((el) => el.id + el.style.transform).join();
  const tick = () => {
    if (!ready && list.classList.contains(`size-${sizeFor(list.getBoundingClientRect().width)}`)) {
      ready = true;
      laidOut();
      last = "";
    }
    const now = shape();
    same = now === last ? same + 1 : 0;
    last = now;
    if ((ready && same >= 2) || ++frames > 14) return go();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Taller rows push everything down, so the same scroll offset would show other emails: scroll
 *  the list so the top email in view stays at the top. */
function keepPlace(copy: HTMLElement, list: HTMLElement) {
  const was = copy.querySelector<HTMLElement>(":scope > .list-scroll");
  const now = list.querySelector<HTMLElement>(":scope > .list-scroll");
  if (!was?.scrollTop || !now) return;
  const top = was.getBoundingClientRect().top;
  const first = [...was.querySelectorAll<HTMLElement>(".row")].find((row) => row.getBoundingClientRect().bottom > top + 1);
  const same = first && document.getElementById(first.dataset.still ?? "");
  if (!first || !same || !now.contains(same)) return;
  now.scrollTop += same.getBoundingClientRect().top - now.getBoundingClientRect().top - (first.getBoundingClientRect().top - top);
}

/** Two copies of the same piece, laid out differently. */
const sameShape = (a: Element, b: Element) =>
  a.className === b.className && a.querySelectorAll("*").length === b.querySelectorAll("*").length;

/** Moves `el` and everything in it to where the same parts sit in `to`: each part travels only as
 *  far as it moves within its parent, so together they all land in their own places. A search
 *  field also takes its new width. */
function travel(el: HTMLElement, to: HTMLElement, base: DOMRect, move: KeyframeAnimationOptions) {
  const from = [el, ...el.querySelectorAll("*")];
  const into = [to, ...to.querySelectorAll("*")];
  const shift = new Map<Element, { x: number; y: number }>();
  let sized: HTMLElement | null = null;
  from.forEach((part, i) => {
    // Inside a field that's narrowing, things already follow its width.
    if (!(part instanceof HTMLElement) || sized?.contains(part)) return;
    const a = boxIn(part, base);
    const b = boxIn(into[i], base);
    const d = { x: b.x - a.x, y: b.y - a.y };
    shift.set(part, d);
    let up = part.parentElement;
    while (up && !shift.has(up)) up = up.parentElement;
    const p = (up && shift.get(up)) || { x: 0, y: 0 };
    const x = d.x - p.x;
    const y = d.y - p.y;
    const frames: Keyframe[] = [{ translate: "0 0" }, { translate: `${x}px ${y}px` }];
    if (part.matches(".search") && Math.abs(a.w - b.w) > 0.5) {
      Object.assign(frames[0], { width: `${a.w}px` });
      Object.assign(frames[1], { width: `${b.w}px` });
      sized = part;
    }
    if (Math.abs(x) + Math.abs(y) > 0.5 || frames[0].width) part.animate(frames, move);
  });
}

/** `keep`: what above the rows the list shows itself, rather than the copy. */
function morph(copy: HTMLElement, list: HTMLElement, delay: number, D: number, keep?: string) {
  // Rows sliding to new heights would be measured mid-slide; and where the list is still
  // unfolding (its filters, say), measure where things will end up, then let it carry on.
  for (const a of list.getAnimations({ subtree: true })) if (a instanceof CSSTransition) a.finish();
  const held = list.getAnimations({ subtree: true }).flatMap((a) => {
    const t = a.currentTime;
    const end = Number(a.effect?.getComputedTiming().endTime);
    if (t === null || !Number.isFinite(end)) return [];
    try {
      a.currentTime = end;
      return [() => (a.currentTime = t)];
    } catch {
      return []; // tied to scrolling, not time
    }
  });
  try {
    pieces(copy, list, delay, D, keep);
  } finally {
    held.forEach((back) => back());
  }
}

function pieces(copy: HTMLElement, list: HTMLElement, delay: number, D: number, keep?: string) {
  const move: KeyframeAnimationOptions = { duration: D, delay, easing: motionEase("ease-move"), fill: "both" };
  const fade: KeyframeAnimationOptions = { duration: D, delay, easing: "linear", fill: "both" };
  const fadeOut = [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }];
  const fadeIn = [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1, offset: 0.75 }, { opacity: 1 }];
  const base = copy.getBoundingClientRect();

  const was = {
    scroll: copy.querySelector<HTMLElement>(":scope > .list-scroll"),
    // The header, the filters, the note on where results come from.
    above: [...copy.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.matches(".list-scroll")),
  };
  const listScroll = list.querySelector<HTMLElement>(":scope > .list-scroll");
  if (!was.scroll || !listScroll) return;

  // The list as it'll look, without a card of its own, behind what moves: the pieces with
  // nowhere to travel from fade in from it.
  const next = copyOf(list);
  Object.assign(next.style, {
    position: "absolute",
    ...place(boxIn(list, base)),
    margin: "0",
    background: "none",
    borderColor: "transparent",
    boxShadow: "none",
    backdropFilter: "none",
    zIndex: "auto",
  });
  next.style.setProperty("-webkit-backdrop-filter", "none");
  copy.appendChild(next);
  keepScroll(list, next);
  const stage = document.createElement("div");
  Object.assign(stage.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  copy.appendChild(stage);
  const nextPieces = [...next.querySelectorAll<HTMLElement>(":scope > .list-scroll :is(.row, .list-group)")];
  const listPieces = [...listScroll.querySelectorAll<HTMLElement>(".row, .list-group")];
  const twin = (el: HTMLElement) => nextPieces[listPieces.indexOf(el)];
  const pairs: { i: number; a: Box; b: Box }[] = [];

  // Emails in both: each piece goes its own way, inside a row that reshapes around them.
  // Rows just past the bottom count too: the ones that slide out of sight go on sliding, not fading.
  const landing = new Map(listPieces.filter((el) => el.classList.contains("row")).map((el) => [el.id, el]));
  for (const row of was.scroll.querySelectorAll<HTMLElement>(".row")) {
    const to = landing.get(row.dataset.still ?? "");
    if (!to || !inView(row, was.scroll)) continue;
    const a = boxIn(row, base);
    const b = boxIn(to, base);
    // A piece only the new layout has (the compact one leaves out the sender and date) comes
    // as a copy of the new one.
    const parts = PARTS.flatMap((s): { x: HTMLElement; from: Box | null; to: Box | null; sizes: string[] }[] => {
      const x = row.querySelector<HTMLElement>(s);
      const y = to.querySelector<HTMLElement>(s);
      if (!y) return x ? [{ x, from: within(boxIn(x, base), a), to: null, sizes: [getComputedStyle(x).fontSize, ""] }] : [];
      const size = getComputedStyle(y).fontSize;
      if (!x) return [{ x: y.cloneNode(true) as HTMLElement, from: null, to: within(boxIn(y, base), b), sizes: [size, size] }];
      return [{ x, from: within(boxIn(x, base), a), to: within(boxIn(y, base), b), sizes: [getComputedStyle(x).fontSize, size] }];
    });
    const shown = (b: Box | null): b is Box => !!b && b.w > 0 && b.h > 0;
    pairs.push({ i: listPieces.indexOf(to), a, b });
    twin(to)?.style.setProperty("visibility", "hidden");
    row.querySelector(".row-actions")?.remove();
    stage.appendChild(row);
    Object.assign(row.style, { ...place(a), right: "auto", margin: "0", transform: "none", display: "block", transition: "none" });
    row.animate([place(a), place(b)], move);
    for (const p of parts) {
      if (!p.x.isConnected) row.appendChild(p.x);
      Object.assign(p.x.style, { position: "absolute", margin: "0", display: "block" });
      // A piece one layout leaves out fades where it is (or where it will be).
      if (!shown(p.to)) {
        if (p.from) Object.assign(p.x.style, place(p.from));
        p.x.animate(fadeOut, fade);
      } else if (!shown(p.from)) {
        Object.assign(p.x.style, place(p.to), { fontSize: p.sizes[1] });
        p.x.animate(fadeIn, fade);
      } else p.x.animate([{ ...place(p.from), fontSize: p.sizes[0] }, { ...place(p.to), fontSize: p.sizes[1] }], move);
    }
  }

  // Date labels ("Today") in both glide to their new places too.
  const labels = listPieces.filter((el) => el.classList.contains("list-group") && inView(el, listScroll));
  for (const g of was.scroll.querySelectorAll<HTMLElement>(".list-group")) {
    const i = labels.findIndex((el) => el.textContent === g.textContent);
    if (i < 0 || !inView(g, was.scroll)) continue;
    const [to] = labels.splice(i, 1);
    const a = boxIn(g, base);
    const b = boxIn(to, base);
    pairs.push({ i: listPieces.indexOf(to), a, b });
    twin(to)?.style.setProperty("visibility", "hidden");
    stage.appendChild(g);
    Object.assign(g.style, { ...place(a), right: "auto", margin: "0", transform: "none" });
    g.animate([place(a), place(b)], move);
  }

  // Emails that only come into view now (more fit, a line each) slide in from where they'd have
  // been, keeping pace with the ones above, so the whole list moves as one.
  const entering = new Set<HTMLElement>();
  pairs.sort((p, q) => p.i - q.i);
  const [first, last] = [pairs[0], pairs.at(-1)];
  if (first && last) {
    const k = last.b.y - first.b.y > 1 ? (last.a.y - first.a.y) / (last.b.y - first.b.y) : 1;
    listPieces.forEach((el, i) => {
      const t = nextPieces[i];
      const near = i < first.i ? first : i > last.i ? last : null;
      if (!t || !near || t.style.visibility === "hidden" || !inView(el, listScroll)) return;
      const b = boxIn(el, base);
      entering.add(t);
      t.animate([{ translate: `0 ${near.a.y + (b.y - near.b.y) * k - b.y}px` }, { translate: "0 0" }], move);
    });
  }

  // Above the rows: a piece in both lists built the same way (the search field and its filters,
  // say) moves as a whole, each part inside it to its own new spot, and the two cross over at the
  // very end; one that changes (the field giving way to the folder's name) or goes, fades.
  const above = (l: Element) => [...l.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.matches(".list-scroll"));
  const listAbove = above(list);
  const nextAbove = above(next);
  if (keep)
    for (let i = listAbove.length - 1; i >= 0; i--)
      if (listAbove[i].matches(keep)) {
        nextAbove[i].style.visibility = "hidden";
        listAbove.splice(i, 1);
        nextAbove.splice(i, 1);
      }
  const late = [{ opacity: 1 }, { opacity: 1, offset: 0.92 }, { opacity: 0 }];
  for (const el of was.above) {
    const i = listAbove.findIndex((to, j) => to.classList[0] === el.classList[0] && !nextAbove[j].dataset.paired);
    const to = listAbove[i];
    if (!to) {
      el.animate(fadeOut, fade);
      continue;
    }
    nextAbove[i].dataset.paired = "1";
    if (sameShape(el, to)) {
      el.style.overflow = "visible";
      travel(el, to, base, move);
      el.animate(late, fade);
      nextAbove[i].animate([{ opacity: 0 }, { opacity: 0, offset: 0.92 }, { opacity: 1 }], fade);
    } else {
      el.animate(fadeOut, fade);
      nextAbove[i].animate(fadeIn, fade);
    }
  }
  for (const el of nextAbove) if (!el.dataset.paired) el.animate(fadeIn, fade);

  // Whatever is left behind in the old list fades; whatever else is new in this one appears.
  was.scroll.animate(fadeOut, fade);
  for (const el of next.querySelectorAll<HTMLElement>(":scope > .list-scroll > *"))
    for (const p of el.querySelector(".row, .list-group") ? el.children : [el])
      if (p instanceof HTMLElement && p.style.visibility !== "hidden" && !entering.has(p)) p.animate(fadeIn, fade);
}

/** The list, already at its new width, opens out from the edge it had at `from`. */
export function revealList(list: HTMLElement, from: number): Animation {
  const r = getComputedStyle(list).borderTopLeftRadius;
  return list.animate([{ clipPath: clip(list.getBoundingClientRect().width - from, r) }, { clipPath: clip(0, r) }], timing());
}
