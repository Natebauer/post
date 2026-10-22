/**
 * A button's keyboard shortcut, shown beside its name while "Show shortcut keys" is on in
 * Settings > Shortcuts (it sets data-show-keys on the root; otherwise these stay hidden).
 */
export function KeyHint({ k }: { k: string }) {
  return (
    <kbd className="key-hint" aria-hidden>
      {k}
    </kbd>
  );
}
