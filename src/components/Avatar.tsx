import { useState } from "react";
import type React from "react";
import { Check } from "lucide-react";
import { avatarUrl } from "../api";
import { cx, initials } from "../util";

/** Photos already shown once: they appear at once next time instead of fading in again. */
const loaded = new Set<string>();

/** A hue from 0–359 that stays the same for an address, so each sender keeps their color. */
function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Initials on a soft color of their own; real photos and brand logos cover them when found. */
export function Avatar({
  email,
  name,
  size,
  checked,
}: {
  email: string;
  name: string;
  size?: "xs" | "sm" | "lg";
  checked?: boolean;
}) {
  const src = email ? avatarUrl(email) : "";
  const known = loaded.has(src);
  const [ok, setOk] = useState(known);
  const [failed, setFailed] = useState(false);
  if (checked) {
    return (
      <div className={cx("avatar check", size)} aria-hidden>
        <Check size={18} strokeWidth={2.5} />
      </div>
    );
  }
  return (
    <div
      className={cx("avatar", size)}
      style={{ "--h": hueFor((email || name).toLowerCase()) } as React.CSSProperties}
      aria-hidden
    >
      {initials(name || email)}
      {email && !failed && (
        <img
          src={src}
          className={ok ? (known ? "ok instant" : "ok") : undefined}
          onLoad={() => {
            loaded.add(src);
            setOk(true);
          }}
          onError={() => setFailed(true)}
          draggable={false}
          alt=""
        />
      )}
    </div>
  );
}
