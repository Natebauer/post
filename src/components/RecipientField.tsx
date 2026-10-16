import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type Address, type Contact } from "../api";
import { cx, isValidEmail, parseAddressList } from "../util";
import { Avatar } from "./Avatar";

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [sugs, setSugs] = useState<Contact[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setSugs([]);
      return;
    }
    const my = ++seq.current;
    const t = window.setTimeout(() => {
      api
        .suggestContacts(q)
        .then((r) => {
          if (my !== seq.current) return;
          const have = new Set(value.map((a) => a.email.toLowerCase()));
          setSugs(r.filter((c) => !have.has(c.email.toLowerCase())));
          setActive(0);
        })
        .catch(() => {});
    }, 90);
    return () => window.clearTimeout(t);
  }, [text, value]);

  const add = (as: Address[]) => {
    const have = new Set(value.map((a) => a.email.toLowerCase()));
    const fresh = as.filter((a) => a.email && !have.has(a.email.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
    setText("");
    setSugs([]);
  };

  const commitText = () => {
    const t = text.trim().replace(/[,;]$/, "");
    if (!t) return false;
    const parsed = parseAddressList(t);
    add(parsed.length ? parsed : [{ name: "", email: t }]);
    return true;
  };

  return (
    <div className="c-field" onClick={() => input.current?.focus()}>
      <label>{label}</label>
      <div className="chips">
        {value.map((a, i) => (
          <span key={a.email + i} className={cx("chip", !isValidEmail(a.email) && "bad")} title={a.email}>
            <span>{a.name || a.email}</span>
            <button
              tabIndex={-1}
              aria-label={`Remove ${a.email}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v) && isValidEmail(v.replace(/[,;]\s*$/, ""))) {
              add(parseAddressList(v));
            } else setText(v);
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            const parsed = parseAddressList(t);
            if (parsed.length > 1 || (parsed.length === 1 && /[,;\n]/.test(t))) {
              e.preventDefault();
              add(parsed);
            }
          }}
          onKeyDown={(e) => {
            if (sugs.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : sugs.length - 1)) % sugs.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && sugs.length && text.trim()) {
              e.preventDefault();
              add([sugs[active]]);
            } else if (e.key === "Enter" || (e.key === "Tab" && text.trim())) {
              if (commitText()) e.preventDefault();
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === "Escape" && sugs.length) {
              e.stopPropagation();
              setSugs([]);
            }
          }}
          onBlur={() => {
            window.setTimeout(() => {
              commitText();
              setSugs([]);
            }, 120);
          }}
        />
        {sugs.length > 0 && (
          <div className="suggest">
            {sugs.map((c, i) => (
              <button
                key={c.email}
                className={cx("menu-item", i === active && "active")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add([c]);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <Avatar email={c.email} name={c.name || c.email} size="sm" />
                <span className="who">
                  <span>{c.name || c.email}</span>
                  {c.name && <small>{c.email}</small>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}
