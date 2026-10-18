import { reduceMotion } from "./motionTokens";

// Lucide's paper plane, drawn in the accent.
const PLANE =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>' +
  '<path d="m21.854 2.147-10.94 10.939"/></svg>';

/**
 * The moment of sending: a paper plane lifts off the Send button and sails up and away, trailing
 * two fainter copies. Nothing with reduced motion, and not for a scheduled send.
 */
export function flySend(from: HTMLElement) {
  if (reduceMotion()) return;
  const r = from.getBoundingClientRect();
  const x = r.left + r.width / 2 - 11;
  const y = r.top + r.height / 2 - 11;
  // Toward the top right, but never past the window's edge.
  const dx = Math.min(280, window.innerWidth - x - 40);
  const dy = -Math.min(340, y - 40);
  [0, 70, 140].forEach((delay, i) => {
    const el = document.createElement("div");
    el.className = "send-fly";
    el.innerHTML = PLANE;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.opacity = "0";
    document.body.appendChild(el);
    const peak = i === 0 ? 1 : 0.35 - i * 0.1;
    el.animate(
      [
        { transform: "translate(0, 0) rotate(0deg) scale(0.7)", opacity: 0 },
        { transform: "translate(-6px, 4px) rotate(4deg) scale(1.05)", opacity: peak, offset: 0.18 },
        { transform: `translate(${dx * 0.35}px, ${dy * 0.2}px) rotate(-6deg) scale(1)`, opacity: peak, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) rotate(-14deg) scale(0.55)`, opacity: 0 },
      ],
      { duration: 950, delay, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "forwards" },
    ).finished.finally(() => el.remove());
  });
}
