import { useStore } from "../store";

// Narrow enough for the photo-only inbox layout.
const MIN_LIST = 76;
const MIN_READ = 380;

/** Drag handle between the inbox list and the reading pane. Width is saved; double-click resets. */
export function Splitter() {
  const listWidth = useStore((s) => s.settings?.listWidth ?? 0);

  const sheetOf = (el: HTMLElement) => el.closest<HTMLElement>(".sheet")!;
  const clamp = (sheet: HTMLElement, w: number) =>
    Math.round(Math.max(MIN_LIST, Math.min(w, sheet.getBoundingClientRect().width - MIN_READ)));
  const apply = (sheet: HTMLElement, w: number | null) => {
    if (w === null) sheet.style.removeProperty("--list-w");
    else sheet.style.setProperty("--list-w", `${w}px`);
  };
  const save = (w: number) => void useStore.getState().saveSettings({ listWidth: w });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const sheet = sheetOf(handle);
    const list = sheet.querySelector<HTMLElement>(".list-pane");
    if (!list) return;
    const left = list.getBoundingClientRect().left;
    let w = list.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      w = clamp(sheet, ev.clientX - left);
      apply(sheet, w);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      save(w);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const sheet = sheetOf(e.currentTarget);
    const list = sheet.querySelector<HTMLElement>(".list-pane");
    if (!list) return;
    const w = clamp(sheet, list.getBoundingClientRect().width + (e.key === "ArrowRight" ? 24 : -24));
    apply(sheet, w);
    save(w);
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inbox (double-click to reset)"
      aria-valuenow={listWidth || undefined}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        apply(sheetOf(e.currentTarget), null);
        save(0);
      }}
    />
  );
}
