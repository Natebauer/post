import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ThumbSource {
  messageId: string;
  partId: string;
  mimeType: string;
  filename: string;
  size: number;
  url: string;
}

// Rendered thumbnails for this session (data URLs), keyed by message/part.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

const isImage = (a: ThumbSource) => /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(a.mimeType);
const isPdf = (a: ThumbSource) => a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename);

/** First page of a PDF, rendered with PDF.js. */
async function pdfThumb(url: string): Promise<string | null> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    void doc.destroy();
  }
}

async function load(a: ThumbSource): Promise<string | null> {
  const key = `${a.messageId}/${a.partId}`;
  if (cache.has(key)) return cache.get(key)!;
  if (inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    try {
      if (isPdf(a) && a.size < 15 * 1024 * 1024) {
        const t = await pdfThumb(a.url).catch(() => null);
        if (t) return t;
      }
      // Office files, video, etc.: whatever Windows Explorer would show.
      return await invoke<string | null>("attachment_thumbnail", { messageId: a.messageId, partId: a.partId });
    } catch {
      return null;
    }
  })();
  inflight.set(key, p);
  const r = await p;
  inflight.delete(key);
  cache.set(key, r);
  return r;
}

/** A real preview of an attachment when one can be made, else `fallback` (a file icon). */
export function Thumb({ a, fallback }: { a: ThumbSource; fallback: ReactNode }) {
  const key = `${a.messageId}/${a.partId}`;
  const [src, setSrc] = useState<string | null>(isImage(a) ? a.url : cache.get(key) ?? null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isImage(a) || cache.has(key)) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    // Only fetch once it's on screen: thumbnails download the attachment.
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void load(a).then((s) => alive && setSrc(s));
    });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <span ref={ref} className="thumb">
      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : fallback}
    </span>
  );
}
