import { useEffect, useRef, useState } from "react";
import type React from "react";
import { reduceMotion } from "../motionTokens";

/**
 * A small burst of stamp-shaped confetti in the accent's shades, for clearing the inbox. It rises
 * from the middle of the list and drifts down, gone in under two seconds. Nothing with reduced
 * motion.
 */
export function InboxZeroConfetti({ fire }: { fire: number }) {
  const [burst, setBurst] = useState<number | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!fire || reduceMotion()) return;
    setBurst(fire);
    const t = window.setTimeout(() => setBurst(null), 2000);
    return () => window.clearTimeout(t);
  }, [fire]);
  if (burst === null) return null;
  const pieces = Array.from({ length: 28 }, (_, i) => {
    // A spread of directions upward, distances and turns; fixed per piece so it looks scattered.
    const seed = Math.sin(i * 12.9898 + burst) * 43758.5453;
    const r = seed - Math.floor(seed);
    const angle = -90 + (i / 27 - 0.5) * 150 + (r - 0.5) * 20;
    const dist = 90 + r * 110;
    return {
      x: Math.cos((angle * Math.PI) / 180) * dist,
      y: Math.sin((angle * Math.PI) / 180) * dist,
      spin: (r - 0.5) * 540,
      tone: i % 3,
      size: 6 + Math.round(r * 5),
      delay: Math.round(r * 120),
    };
  });
  return (
    <div className="confetti" aria-hidden key={burst}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`confetti-bit t${p.tone}`}
          style={
            {
              "--x": `${p.x}px`,
              "--y": `${p.y}px`,
              "--spin": `${p.spin}deg`,
              "--s": `${p.size}px`,
              animationDelay: `${p.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
