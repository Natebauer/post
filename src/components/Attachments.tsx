import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { Check, ChevronLeft, ChevronRight, Download, ExternalLink, FileArchive, FileImage, FileSpreadsheet, FileText, File as FileIcon, X } from "lucide-react";
import { api, errText, type Attachment } from "../api";
import { useStore } from "../store";
import { motionMs, reduceMotion } from "../motionTokens";
import { cx, formatBytes } from "../util";
import { Thumb } from "./Thumb";

const isImage = (a: Attachment) => /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(a.mimeType);
const isPdf = (a: Attachment) => a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename);
const isText = (a: Attachment) => /^text\/(plain|csv)$/i.test(a.mimeType);

function iconFor(a: Attachment) {
  if (isImage(a)) return <FileImage size={28} strokeWidth={1.4} />;
  if (/zip|compressed|tar/.test(a.mimeType)) return <FileArchive size={28} strokeWidth={1.4} />;
  if (/sheet|excel|csv/.test(a.mimeType)) return <FileSpreadsheet size={28} strokeWidth={1.4} />;
  if (isPdf(a) || /word|text/.test(a.mimeType)) return <FileText size={28} strokeWidth={1.4} />;
  return <FileIcon size={28} strokeWidth={1.4} />;
}

/** A short type label and a color for it: PDFs red, sheets green, documents blue, and so on. */
function kindOf(a: Attachment): { label: string; color: string } {
  return fileKind(a.filename, a.mimeType);
}

/** The same, from just a file's name (and its type when known), for files being attached. */
export function fileKind(filename: string, mimeType = ""): { label: string; color: string } {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(filename)?.[1] ?? "").toUpperCase();
  if (mimeType === "application/pdf" || ext === "PDF") return { label: "PDF", color: "#d5483c" };
  if (/^image\//i.test(mimeType) || /^(PNG|JPE?G|GIF|WEBP|BMP|SVG|HEIC)$/.test(ext)) return { label: ext || "IMG", color: "#8a5aa8" };
  if (/sheet|excel|csv/.test(mimeType) || /^(XLSX?|CSV|NUMBERS)$/.test(ext)) return { label: ext || "XLS", color: "#2f9e5b" };
  if (/word|document|rtf/.test(mimeType) || /^(DOCX?|RTF|PAGES|ODT)$/.test(ext)) return { label: ext || "DOC", color: "#3e6fd8" };
  if (/presentation|powerpoint/.test(mimeType) || /^(PPTX?|KEY)$/.test(ext)) return { label: ext || "PPT", color: "#d9822b" };
  if (/zip|compressed|tar/.test(mimeType) || /^(ZIP|RAR|7Z|GZ|TAR)$/.test(ext)) return { label: ext || "ZIP", color: "#7a7062" };
  return { label: ext || "FILE", color: "#6c6f77" };
}

/** Open what Post just saved; a file that can run programs needs a second, deliberate click. */
export async function openSaved(path: string, name: string) {
  try {
    if ((await api.openSaved(path)) === "confirm")
      useStore.getState().snack({
        text: `${name} can run programs on your computer. Only open it if you trust the sender.`,
        ms: 9000,
        action: { label: "Open anyway", run: () => void api.openSaved(path, true).catch(() => {}) },
      });
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
}

async function saveAs(messageId: string, a: Attachment): Promise<boolean> {
  try {
    const path = await api.saveAttachment(messageId, a.partId);
    if (path) {
      useStore.getState().snack({
        text: `Saved ${a.filename}`,
        action: { label: "Open", run: () => void openSaved(path, a.filename) },
        action2: {
          label: "Show in folder",
          run: () => void api.showSaved(path).catch((e) => useStore.getState().snack({ text: errText(e) })),
        },
      });
      return true;
    }
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
  return false;
}

async function openExternal(messageId: string, a: Attachment) {
  try {
    // Files that can run code (an .exe, a script, a shortcut) need a second, deliberate click.
    if ((await api.openAttachment(messageId, a.partId)) === "confirm")
      useStore.getState().snack({
        text: `${a.filename} can run programs on your computer. Only open it if you trust the sender.`,
        ms: 9000,
        action: { label: "Open anyway", run: () => void api.openAttachment(messageId, a.partId, true).catch(() => {}) },
      });
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
}

/** The transform that puts the preview `box` over the card it came from (`from`), for growing out of it. */
function fromCard(box: DOMRect, from: DOMRect) {
  const dx = from.left + from.width / 2 - (box.left + box.width / 2);
  const dy = from.top + from.height / 2 - (box.top + box.height / 2);
  return `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${from.width / box.width}, ${from.height / box.height})`;
}

function QuickLook({
  messageId,
  a,
  from,
  onClose: done,
  all = [a],
  onStep,
}: {
  messageId: string;
  a: Attachment;
  from?: DOMRect | null;
  onClose: () => void;
  /** The email's other files you can look at, to step through with ← and →. */
  all?: Attachment[];
  onStep?: (a: Attachment) => void;
}) {
  const at = all.indexOf(a);
  const step = (d: number) => {
    const next = all[(at + d + all.length) % all.length];
    if (next && next !== a) onStep?.(next);
  };
  const [closing, setClosing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The preview grows out of the attachment card that was clicked, and shrinks back into it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !from || reduceMotion()) return;
    // (Measured without any earlier run of this, so the start is always the card.)
    el.getAnimations().forEach((x) => x.cancel());
    el.animate(
      [
        { transform: fromCard(el.getBoundingClientRect(), from), opacity: 0.3, borderRadius: "24px" },
        { transform: "translate(-50%, -50%)", opacity: 1 },
      ],
      { duration: 340, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onClose = () => {
    const el = box.current;
    if (el && from && !reduceMotion()) {
      el.animate([{ transform: "translate(-50%, -50%)", opacity: 1 }, { transform: fromCard(el.getBoundingClientRect(), from), opacity: 0 }], {
        duration: 240,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      });
    }
    setClosing(true);
    window.setTimeout(done, motionMs("med-out"));
  };
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (isText(a)) void fetch(a.url).then((r) => r.text()).then(setText).catch(() => setText("(couldn't load)"));
  }, [a]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && all.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, a, all]);
  return (
    <>
      <div className={closing ? "scrim closing" : "scrim"} onClick={onClose} />
      <div ref={box} className={cx("modal quicklook", closing && "closing", from && "grown")} role="dialog" aria-label={a.filename}>
        <div className="ql-head">
          <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</strong>
          {all.length > 1 && (
            <span className="ql-step">
              <button className="icon-btn sm" onClick={() => step(-1)} aria-label="Previous file" title="Previous file (←)">
                <ChevronLeft size={16} />
              </button>
              <span className="faint tnum">
                {at + 1} of {all.length}
              </span>
              <button className="icon-btn sm" onClick={() => step(1)} aria-label="Next file" title="Next file (→)">
                <ChevronRight size={16} />
              </button>
            </span>
          )}
          <span className="faint" style={{ marginRight: 8 }}>{formatBytes(a.size)}</span>
          <button className="btn ghost" onClick={() => void openExternal(messageId, a)}>
            <ExternalLink size={15} /> Open
          </button>
          <SaveButton messageId={messageId} a={a} />
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        </div>
        <div className="ql-body">
          {isImage(a) && <img src={a.url} alt={a.filename} />}
          {isPdf(a) && <iframe src={a.url} title={a.filename} />}
          {isText(a) && (
            <pre style={{ alignSelf: "start", justifySelf: "stretch", margin: 0, padding: 20, whiteSpace: "pre-wrap", userSelect: "text" }}>
              {text ?? "Loading…"}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}

/** Quick Look's Save: once the file is saved it turns into a check for a moment. */
function SaveButton({ messageId, a }: { messageId: string; a: Attachment }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(t);
  }, [saved]);
  return (
    <button
      className={cx("btn ghost ql-save", saved && "saved")}
      onClick={() => void saveAs(messageId, a).then((ok) => ok && setSaved(true))}
    >
      {saved ? <Check size={15} key="c" /> : <Download size={15} key="d" />} {saved ? "Saved" : "Save"}
    </button>
  );
}

export function Attachments({ messageId, attachments }: { messageId: string; attachments: Attachment[] }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [from, setFrom] = useState<DOMRect | null>(null);
  const list = attachments.filter((a) => !a.inline);
  if (!list.length) return null;
  return (
    <div className="atts">
      {list.map((a) => {
        const previewable = isImage(a) || isPdf(a) || isText(a);
        const kind = kindOf(a);
        return (
          <div
            key={a.partId}
            className="att"
            title={a.filename}
            style={{ "--k": kind.color } as React.CSSProperties}
            onClick={(e) => {
              if (!previewable) return void openExternal(messageId, a);
              setFrom(e.currentTarget.getBoundingClientRect());
              setPreview(a);
            }}
          >
            <div className="att-thumb">
              <Thumb a={{ ...a, messageId }} fallback={iconFor(a)} />
            </div>
            <div className="att-info">
              <div className="att-name">{a.filename}</div>
              <div className="att-meta">
                <span className="att-kind">{kind.label}</span>
                <span className="faint">{formatBytes(a.size)}</span>
              </div>
            </div>
            <div className="att-actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn sm" title="Open with default app" onClick={() => void openExternal(messageId, a)}>
                <ExternalLink size={14} />
              </button>
              <button className="icon-btn sm" title="Save as…" onClick={() => void saveAs(messageId, a)}>
                <Download size={14} />
              </button>
            </div>
          </div>
        );
      })}
      {preview && (
        <QuickLook
          messageId={messageId}
          a={preview}
          from={from}
          onClose={() => setPreview(null)}
          all={list.filter((x) => isImage(x) || isPdf(x) || isText(x))}
          onStep={setPreview}
        />
      )}
    </div>
  );
}
