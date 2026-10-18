import { useEffect, useRef, useState } from "react";
import { reduceMotion } from "../motionTokens";

/**
 * A number that rolls when it changes: the old value slides out and the new one slides in, up
 * when it grows (new mail) and down when it shrinks. With reduced motion it simply changes.
 */
export function RollingCount({ value, format = String }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const [prev, setPrev] = useState<number | null>(null);
  const timer = useRef<number>();
  useEffect(() => {
    if (value === shown) return;
    if (reduceMotion()) {
      setShown(value);
      return;
    }
    setPrev(shown);
    setShown(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPrev(null), 420);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const dir = prev !== null && value < prev ? "down" : "up";
  return (
    <span className={prev !== null ? `roll rolling ${dir}` : "roll"}>
      {prev !== null && (
        <span className="roll-out" aria-hidden>
          {format(prev)}
        </span>
      )}
      <span className="roll-in">{format(shown)}</span>
    </span>
  );
}
