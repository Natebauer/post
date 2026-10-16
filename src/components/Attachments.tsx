import { useEffect, useState } from "react";
import { Download, ExternalLink, FileArchive, FileImage, FileSpreadsheet, FileText, File as FileIcon, X } from "lucide-react";
import { api, errText, type Attachment } from "../api";
import { useStore } from "../store";
import { motionMs } from "../motionTokens";
import { formatBytes } from "../util";
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

async function saveAs(messageId: string, a: Attachment) {
  try {
    if (await api.saveAttachment(messageId, a.partId)) useStore.getState().snack({ text: `Saved ${a.filename}` });
  } catch (e) {
    useStore.getState().snack({ text: errText(e) });
  }
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

function QuickLook({ messageId, a, onClose: done }: { messageId: string; a: Attachment; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const onClose = () => {
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
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <>
      <div className={closing ? "scrim closing" : "scrim"} onClick={onClose} />
      <div className={closing ? "modal quicklook closing" : "modal quicklook"} role="dialog" aria-label={a.filename}>
        <div className="ql-head">
          <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</strong>
          <span className="faint" style={{ marginRight: 8 }}>{formatBytes(a.size)}</span>
          <button className="btn ghost" onClick={() => void openExternal(messageId, a)}>
            <ExternalLink size={15} /> Open
          </button>
          <button className="btn ghost" onClick={() => void saveAs(messageId, a)}>
            <Download size={15} /> Save
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
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

export function Attachments({ messageId, attachments }: { messageId: string; attachments: Attachment[] }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  const list = attachments.filter((a) => !a.inline);
  if (!list.length) return null;
  return (
    <div className="atts">
      {list.map((a) => {
        const previewable = isImage(a) || isPdf(a) || isText(a);
        return (
          <div
            key={a.partId}
            className="att"
            title={a.filename}
            onClick={() => (previewable ? setPreview(a) : void openExternal(messageId, a))}
          >
            <div className="att-thumb">
              <Thumb a={{ ...a, messageId }} fallback={iconFor(a)} />
            </div>
            <div className="att-info">
              <div className="att-name">{a.filename}</div>
              <div className="faint">{formatBytes(a.size)}</div>
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
      {preview && <QuickLook messageId={messageId} a={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
