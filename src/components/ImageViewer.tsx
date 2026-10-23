import { useEffect } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, X } from "lucide-react";

/** A picture from an email, by itself and as large as fits (right-click it, then View image). */
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  const web = /^https?:/i.test(src);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal quicklook image-viewer" role="dialog" aria-label={name}>
        <div className="ql-head">
          <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
          {web && (
            <button className="btn ghost" onClick={() => void openUrl(src)}>
              <ExternalLink size={15} /> Open in browser
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        </div>
        <div className="ql-body" onClick={onClose}>
          <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A name for a picture: its alt text, else the file name at the end of its address. */
export function imageName(src: string, alt?: string | null): string {
  if (alt?.trim()) return alt.trim();
  if (src.startsWith("data:")) return "Image";
  try {
    const last = decodeURIComponent(new URL(src, location.href).pathname.split("/").pop() || "");
    return last && /\.\w{2,5}$/.test(last) ? last : "Image";
  } catch {
    return "Image";
  }
}
