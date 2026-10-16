import { useEffect } from "react";
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

/** Every keyboard shortcut, grouped (shown in Settings and on ?). */
export function ShortcutList() {
  return (
    <>
      {GROUPS.map(([g, rows]) => (
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
                    <span className="kbd" style={{ fontSize: 12, padding: "1px 6px" }}>
                      {k}
                    </span>
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
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
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
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <ShortcutList />
      </div>
    </>,
    document.body,
  );
}
