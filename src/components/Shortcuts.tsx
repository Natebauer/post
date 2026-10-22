import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useStore } from "../store";
import { usePresence } from "../hooks";
import { cx } from "../util";

const GROUPS: [string, [string, string][]][] = [
  [
    "Navigate",
    [
      ["Open next / previous conversation", "J / K"],
      ["Move without opening, then open", "↑ ↓ then Enter"],
      ["Close conversation", "U"],
      ["Search", "/"],
      ["Command palette", "Ctrl K"],
      ["AI assistant", "Ctrl J"],
      ["Collapse / expand sidebar", "Ctrl B"],
      ["Go to Inbox / Sent / Drafts / Snoozed / Spam", "G then I / T / D / B / !"],
      ["Settings", "Ctrl ,"],
      ["Text size", "Ctrl + / Ctrl − / Ctrl 0"],
      ["New message from anywhere in Windows", "Ctrl Alt M"],
    ],
  ],
  [
    "Act",
    [
      ["Compose", "C"],
      ["Reply / Reply all / Forward", "R / A / F"],
      ["Delete", "#  or  Delete"],
      ["Report spam", "!"],
      ["Snooze", "B"],
      ["Pin to Home / unpin", "P"],
      ["Mark read / unread", "Shift I / Shift U"],
      ["Select / add to selection", "X  or  Ctrl+click"],
      ["Select a range", "Shift+click"],
      ["Clear selection", "Esc"],
      ["Print", "Ctrl P"],
      ["More actions", "Right-click a conversation"],
    ],
  ],
  [
    "Write",
    [
      ["Send", "Ctrl Enter"],
      ["Bold / Italic", "Ctrl B / Ctrl I"],
      ["Save & close", "Esc"],
    ],
  ],
];

/** Words in a shortcut that join keys rather than being keys themselves. */
const JOINERS = new Set(["/", "then", "or"]);

/** "Shift I / Shift U" as key caps: each key in a cap, the words between them as plain text. */
function Keys({ k }: { k: string }) {
  if (/click|conversation/i.test(k) && !/[+]/.test(k)) return <span className="sk-text">{k}</span>;
  const tokens = k.split(/\s+/).filter(Boolean);
  return (
    <span className="sk-keys">
      {tokens.map((t, i) =>
          // A lone "/" is the search key itself, not a separator.
          JOINERS.has(t) && tokens.length > 1 ? (
            <span key={i} className="sk-join">
              {t}
            </span>
          ) : /\+click$/i.test(t) ? (
            <span key={i} className="sk-combo">
              <kbd>{t.replace(/\+click$/i, "")}</kbd>
              <span className="sk-join">+ click</span>
            </span>
          ) : (
            <kbd key={i}>{t}</kbd>
          ),
        )}
    </span>
  );
}

/** Every keyboard shortcut, grouped (shown in Settings and on ?). */
export function ShortcutList({ filter = "" }: { filter?: string }) {
  // Typing in the sheet's filter keeps the shortcuts whose name or keys match.
  const f = filter.trim().toLowerCase();
  const shown = GROUPS.map(([g, rows]) => [g, rows.filter(([a, k]) => !f || a.toLowerCase().includes(f) || k.toLowerCase().includes(f))] as const).filter(
    ([, rows]) => rows.length,
  );
  return (
    <>
      {f && !shown.length && <p className="faint">No shortcut matches "{filter.trim()}".</p>}
      {shown.map(([g, rows]) => (
        <div key={g} className="shortcut-group">
          <div className="menu-label" style={{ padding: "0 0 4px" }}>
            {g}
          </div>
          <table>
            <tbody>
              {rows.map(([a, k]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>
                    <Keys k={k} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

export function Shortcuts() {
  const open = useStore((s) => s.shortcutsOpen);
  const { mounted, closing } = usePresence(open);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!open) return;
    setFilter("");
    const k = (e: KeyboardEvent) => {
      // A "?" typed into the filter is just a character.
      if (e.key === "?" && (e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === "Escape" || e.key === "?") {
        e.stopPropagation();
        e.preventDefault();
        useStore.setState({ shortcutsOpen: false });
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  if (!mounted) return null;
  const close = () => useStore.setState({ shortcutsOpen: false });
  return createPortal(
    <>
      <div className={cx("scrim", closing && "closing")} onClick={close} />
      <div className={cx("modal shortcuts", closing && "closing")} role="dialog" aria-label="Keyboard shortcuts">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <h4 style={{ margin: 0, flex: 1, fontSize: 16 }}>Keyboard shortcuts</h4>
          <input className="input sk-filter" placeholder="Filter" aria-label="Filter shortcuts" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <ShortcutList filter={filter} />
      </div>
    </>,
    document.body,
  );
}
