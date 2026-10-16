import { api } from "./api";

let last = -1;

/** Unread red, like other Windows apps' badges, so it stands out on any taskbar or wallpaper. */
const BADGE_RED = "#e0282e";

/**
 * Draw the unread count as a Windows taskbar overlay icon: a bold red badge with a white ring,
 * which separates it from Post's icon and any taskbar color.
 */
export async function updateBadge(count: number) {
  if (count === last) return;
  last = count;
  if (count <= 0) {
    await api.setBadge(null).catch(() => {});
    return;
  }
  const size = 32;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  const label = count > 99 ? "99+" : String(count);

  // One digit: a circle. More: a pill, so the number stays big.
  const shape = (inset: number) => {
    g.beginPath();
    if (label.length === 1) {
      g.arc(size / 2, size / 2, size / 2 - inset, 0, Math.PI * 2);
    } else {
      const h = 26 - inset * 2;
      g.roundRect(inset, (size - h) / 2, size - inset * 2, h, h / 2);
    }
  };
  g.fillStyle = "#ffffff";
  shape(0);
  g.fill();
  g.fillStyle = BADGE_RED;
  shape(2.5);
  g.fill();

  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const fs = label.length === 1 ? 22 : label.length === 2 ? 19 : 14;
  g.font = `800 ${fs}px "Inter Variable", "Segoe UI", sans-serif`;
  g.fillText(label, size / 2, size / 2 + 1.5);

  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await api.setBadge(bytes).catch(() => {});
}

export function resetBadgeCache() {
  last = -1;
}
