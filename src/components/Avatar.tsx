import { useState } from "react";
import { Check } from "lucide-react";
import { avatarUrl } from "../api";
import { cx, initials } from "../util";

/** Photos already shown once: they appear at once next time instead of fading in again. */
const loaded = new Set<string>();

/** Neutral initials; color only comes from real photos and brand logos. */
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
    <div className={cx("avatar", size)} aria-hidden>
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
