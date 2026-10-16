import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motionMs } from "../motionTokens";
import { cx } from "../util";

/**
 * A floating menu anchored to an element or a point (for context menus).
 * Closes on outside click or Escape, with a short exit animation.
 */
export function Popover({
  anchor,
  point,
  onClose,
  children,
  align = "left",
  placement = "below",
  className,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor?: HTMLElement | null;
  point?: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  placement?: "below" | "above";
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, motionMs("fast-out"));
  }, [onClose]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const m = ref.current.getBoundingClientRect();
    let left: number;
    let top: number;
    if (point) {
      left = point.x;
      top = point.y;
      if (top + m.height > window.innerHeight - 8) top = point.y - m.height;
    } else if (anchor) {
      const a = anchor.getBoundingClientRect();
      left = align === "right" ? a.right - m.width : a.left;
      top = placement === "below" ? a.bottom + 6 : a.top - m.height - 6;
      if (top + m.height > window.innerHeight - 8) top = a.top - m.height - 6;
    } else return;
    if (top < 8) top = 8;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    // Only update when it actually moved, so a caller passing a fresh `point` object each render
    // can't start a render loop.
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [anchor, point?.x, point?.y, align, placement]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      // Arrow keys, Home and End move between the menu's items.
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu-item:not([disabled])") ?? []);
      if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      if (!ref.current?.contains(document.activeElement) && document.activeElement !== anchor) return;
      e.preventDefault();
      e.stopPropagation();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    };
    const blur = () => close();
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [anchor, close]);

  // Menus take keyboard focus (first item) and give it back to what opened them. Hover cards don't.
  const isMenu = !onMouseEnter;
  useEffect(() => {
    if (!isMenu || !ref.current) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current.querySelectorAll(".menu-item").forEach((el) => el.setAttribute("role", "menuitem"));
    ref.current.querySelector<HTMLElement>(".menu-item")?.focus({ preventScroll: true });
    const menu = ref.current;
    return () => {
      const inside = menu.contains(document.activeElement) || document.activeElement === document.body;
      if (inside) (anchor ?? before)?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={ref}
      role={isMenu ? "menu" : "dialog"}
      className={cx("menu", closing && "closing", className)}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body,
  );
}
