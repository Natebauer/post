import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Bold,
  ChevronDown,
  ExternalLink,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Quote,
  FileText,
  Trash2,
  X,
} from "lucide-react";
import { api, errText, type SendAs } from "../api";
import { announceSent, broadcastSent, liveDrafts, openCompose, toComposeData, type ComposeDraft } from "../compose";
import { useStore } from "../store";
import { Typography } from "../typography";
import { motionMs, scrollBehavior } from "../motionTokens";
import { checkBeforeSend, type SendIssue } from "../sendCheck";
import { cx, escapeHtml, formatBytes, isValidEmail, sanitizeHtml } from "../util";
import { flySend } from "../sendFly";
import { RecipientField } from "./RecipientField";
import { fileKind } from "./Attachments";
import { Avatar } from "./Avatar";
import { KeyHint } from "./KeyHint";
import { TimePicker } from "./TimePicker";
import { WindowControls } from "./TitleBar";
import { Popover } from "./Popover";

export type ComposerMode = "inline" | "pane" | "floating" | "fullscreen" | "window";

const TITLES: Record<ComposeDraft["kind"], string> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
  draft: "Draft",
};

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

const isEmptyBody = (html: string) => html.replace(/<p><\/p>|<br\s*\/?>|\s/g, "") === "";

export function Composer({ draft: original, mode: initialMode }: { draft: ComposeDraft; mode: ComposerMode }) {
  // Resume from the live copy if this composer was open a moment ago somewhere else in the window.
  const [initial] = useState<ComposeDraft>(() => liveDrafts.get(original.key) ?? original);
  const [d, setD] = useState<ComposeDraft>(initial);
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [showQuote, setShowQuote] = useState(false);
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** What the last look before sending found (send anyway, or keep editing). */
  const [issues, setIssues] = useState<{ list: SendIssue[]; sendAt: number | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [scheduleAnchor, setScheduleAnchor] = useState<HTMLElement | null>(null);
  const minimized = useStore((s) => s.composeMinimized);
  const dRef = useRef(d);
  const dirty = useRef(false);
  const saveTimer = useRef<number>();
  const savePromise = useRef<Promise<boolean> | null>(null);
  const closed = useRef(false);
  const imgInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sendBtn = useRef<HTMLButtonElement>(null);
  /** Whether you've typed, pasted or attached anything since this composer opened. */
  const touched = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [aliases, setAliases] = useState<SendAs[]>([]);
  const [tplAnchor, setTplAnchor] = useState<HTMLElement | null>(null);
  const templates = useStore((s) => s.settings?.templates ?? []);

  useEffect(() => {
    const root = rootRef.current;
    const onInput = () => (touched.current = true);
    root?.addEventListener("beforeinput", onInput, true);
    return () => root?.removeEventListener("beforeinput", onInput, true);
  }, []);

  useEffect(() => {
    if (initialMode === "inline") rootRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
    void useStore.getState().loadSendAs().then(setAliases);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Animate out, then remove from the store (in-window modes). */
  const dismiss = () => {
    liveDrafts.delete(dRef.current.key);
    setLeaving(true);
    window.setTimeout(() => useStore.setState({ compose: null, composeMinimized: false }), motionMs("slow-out"));
  };
  dRef.current = d;
  if (!closed.current) liveDrafts.set(d.key, d);

  const update = (patch: Partial<ComposeDraft>) => {
    dirty.current = true;
    if (patch.attachments) touched.current = true;
    dRef.current = { ...dRef.current, ...patch };
    liveDrafts.set(dRef.current.key, dRef.current);
    setD((prev) => ({ ...prev, ...patch }));
  };

  // ---------- autosave to Gmail drafts ----------
  /** Save to Gmail drafts now. Resolves true when everything typed so far is safely saved. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(saveTimer.current);
    if (closed.current) return true;
    if (!dirty.current) return savePromise.current ? savePromise.current : true;
    const cur = dRef.current;
    if (!cur.to.length && !cur.cc.length && !cur.subject.trim() && isEmptyBody(cur.bodyHtml) && !cur.attachments.length)
      return true;
    dirty.current = false;
    setSaveState("saving");
    const p = (async () => {
      try {
        if (savePromise.current) await savePromise.current.catch(() => false);
        const r = await api.saveDraft(toComposeData(dRef.current));
        dRef.current = { ...dRef.current, draftId: r.draftId };
        liveDrafts.set(dRef.current.key, dRef.current);
        setD((prev) => ({ ...prev, draftId: r.draftId }));
        setSaveState("saved");
        return !dirty.current;
      } catch {
        dirty.current = true;
        setSaveState("error");
        return false;
      }
    })();
    savePromise.current = p;
    const ok = await p;
    if (savePromise.current === p) savePromise.current = null;
    return ok;
  }, []);

  const scheduleSave = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveNow(), 2500);
  };

  useEffect(() => {
    if (dirty.current) scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.to, d.cc, d.bcc, d.subject, d.bodyHtml, d.attachments]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      if (!closed.current && dirty.current) void saveNow();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---------- editor ----------
  const insertImageFiles = async (files: File[]) => {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const src = await readAsDataUrl(f);
      editor?.chain().focus().setImage({ src }).run();
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, code: false, horizontalRule: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image.configure({ inline: true, allowBase64: true }),
      // On the first line whenever it's empty, even with a signature below it.
      Placeholder.configure({ placeholder: ({ pos }) => (pos === 0 ? "Write your message…" : ""), showOnlyCurrent: false }),
      Typography,
    ],
    content: initial.bodyHtml,
    autofocus: initial.kind === "new" && initial.to.length === 0 ? false : "start",
    onUpdate: ({ editor }) => update({ bodyHtml: editor.getHTML() }),
    editorProps: {
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (files.length) {
          void insertImageFiles(files);
          return true;
        }
        return false;
      },
    },
  });

  // Files dragged in from Explorer become attachments (Post copies them first; see files.rs).
  useEffect(() => {
    const un = getCurrentWebviewWindow().listen<{ path: string; name: string }[]>("files-staged", (e) => {
      if (e.payload.length) update({ attachments: [...dRef.current.attachments, ...e.payload] });
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- close / discard / send ----------
  const closeComposer = () => {
    closed.current = true;
    liveDrafts.delete(dRef.current.key);
    if (mode === "window") void getCurrentWindow().close();
    else dismiss();
  };

  const close = async () => {
    const hadContent = dirty.current || dRef.current.draftId;
    const ok = await saveNow();
    if (!ok) {
      // Don't pretend: keep the message open so nothing is lost.
      setErr("Couldn't save this draft to Gmail. It's still here; try closing again once you're back online.");
      if (mode !== "window")
        useStore.getState().snack({ text: "Draft not saved", action: { label: "Close anyway", run: closeComposer }, ms: 8000 });
      return;
    }
    if (hadContent && dRef.current.draftId && mode !== "window") useStore.getState().snack({ text: "Draft saved" });
    closeComposer();
  };

  const discard = async () => {
    window.clearTimeout(saveTimer.current);
    closed.current = true;
    if (savePromise.current) await savePromise.current.catch(() => false);
    const kept = dRef.current;
    closeComposer();
    if (mode === "window") {
      if (kept.draftId) await api.deleteDraft(kept.draftId).catch(() => {});
      return;
    }
    // Gmail deletes drafts for good, so wait a moment: Undo brings the message right back.
    let undone = false;
    const timer = window.setTimeout(() => {
      if (!undone && kept.draftId) void api.deleteDraft(kept.draftId).catch(() => {});
    }, 8500);
    useStore.getState().snack({
      text: "Draft discarded",
      action: {
        label: "Undo",
        run: () => {
          undone = true;
          window.clearTimeout(timer);
          void openCompose({ ...kept, key: `${kept.key}-r` });
        },
      },
    });
  };

  const send = async (sendAt: number | null, skipCheck = false) => {
    setErr(null);
    setIssues(null);
    const cur = dRef.current;
    const all = [...cur.to, ...cur.cc, ...cur.bcc];
    if (!all.length) return setErr("Add at least one recipient.");
    const bad = all.find((a) => !isValidEmail(a.email));
    if (bad) return setErr(`"${bad.email}" isn't a valid email address.`);
    if (!cur.subject.trim() && !window.confirm("Send this message without a subject?")) return;
    const st = useStore.getState().settings;
    if (!skipCheck && (st?.sendCheck ?? true)) {
      setChecking(true);
      const found = await checkBeforeSend(dRef.current, !!st?.aiEnabled);
      setChecking(false);
      if (found.length) return setIssues({ list: found, sendAt });
    }
    setBusy(true);
    window.clearTimeout(saveTimer.current);
    try {
      if (savePromise.current) await savePromise.current.catch(() => {});
      const latest = dRef.current;
      const r = await api.queueSend(toComposeData(latest), sendAt);
      closed.current = true;
      const info = { id: r.id, sendAt: r.sendAt, kind: r.kind, draft: latest };
      if (mode === "window") {
        await broadcastSent(info);
        await getCurrentWindow().close();
      } else {
        if (sendBtn.current && !sendAt) flySend(sendBtn.current);
        dismiss();
        announceSent(info);
      }
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const popOut = async () => {
    await saveNow();
    const st = useStore.getState();
    closed.current = true;
    await api.openComposeWindow({ draft: dRef.current, settings: st.settings, email: st.info?.email ?? "" });
    useStore.setState({ compose: null });
  };

  const attach = async () => {
    const files = await api.pickAttachments().catch(() => []);
    if (files.length) update({ attachments: [...dRef.current.attachments, ...files] });
  };

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev || "https://");
    if (url === null) return;
    if (url === "" || url === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send(null);
    } else if (e.key === "Escape" && mode !== "inline" && !scheduleAnchor) {
      e.preventDefault();
      void close();
    }
    e.stopPropagation();
  };

  const isMin = mode === "floating" && minimized;
  // Once there's someone to write to, the title says who (and shows them) until there's a subject.
  const people = [...d.to, ...d.cc];
  const toLine = people.length
    ? `To ${people[0].name || people[0].email}${people.length > 1 ? ` and ${people.length - 1} other${people.length > 2 ? "s" : ""}` : ""}`
    : "";
  const title = d.subject.trim() || (d.kind === "new" && toLine) || TITLES[d.kind];

  return (
    <>
      {mode === "fullscreen" && (
        <div
          className="scrim"
          // Clicking away keeps a message you've started (as a floating panel); an untouched one
          // just closes, leaving nothing behind (an existing draft is kept as it was).
          onClick={() => (touched.current ? setMode("floating") : closeComposer())}
        />
      )}
      <div
        ref={rootRef}
        className={cx("composer", mode, isMin && "min", leaving && "leaving")}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label={title}
      >
        {mode !== "inline" && (
          <div
            className="c-head"
            data-tauri-drag-region={mode === "window" ? true : undefined}
            onClick={() => isMin && useStore.setState({ composeMinimized: false })}
          >
            {people.length > 0 && (
              <span className="c-head-people" aria-hidden>
                {people.slice(0, 3).map((a) => (
                  <Avatar key={a.email} email={a.email} name={a.name || a.email} size="xs" />
                ))}
              </span>
            )}
            <span className="title" data-tauri-drag-region={mode === "window" ? true : undefined}>
              {title}
            </span>
            {mode === "floating" && (
              <button
                className="icon-btn sm"
                title={isMin ? "Restore" : "Minimize"}
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.setState({ composeMinimized: !isMin });
                }}
              >
                <Minus size={15} />
              </button>
            )}
            {(mode === "floating" || mode === "fullscreen") && (
              <button
                className="icon-btn sm"
                title={mode === "fullscreen" ? "Exit full screen" : "Full screen"}
                onClick={() => setMode(mode === "fullscreen" ? "floating" : "fullscreen")}
              >
                {mode === "fullscreen" ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
            {mode !== "window" && (
              <button className="icon-btn sm" title="Open in new window" onClick={() => void popOut()}>
                <ExternalLink size={14} />
              </button>
            )}
            {mode === "window" ? (
              <WindowControls />
            ) : (
              <button className="icon-btn sm" title="Save & close (Esc)" onClick={() => void close()}>
                <X size={16} />
              </button>
            )}
          </div>
        )}
        {!isMin && (
          <>
            {aliases.length > 1 && (
              <div className="c-field">
                <label htmlFor={`from-${d.key}`}>From</label>
                {/* You, as the recipients will see you: your avatar beside the address. */}
                {(() => {
                  const me = d.from ?? aliases.find((a) => a.isDefault) ?? aliases[0];
                  return me ? <Avatar email={me.email} name={me.name || me.email} size="xs" /> : null;
                })()}
                <select
                  id={`from-${d.key}`}
                  className="plain"
                  value={(d.from?.email ?? aliases.find((a) => a.isDefault)?.email ?? "").toLowerCase()}
                  onChange={(e) => {
                    const a = aliases.find((x) => x.email.toLowerCase() === e.target.value);
                    update({ from: a ? { name: a.name, email: a.email } : null });
                  }}
                >
                  {aliases.map((a) => (
                    <option key={a.email} value={a.email.toLowerCase()}>
                      {a.name ? `${a.name} <${a.email}>` : a.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <RecipientField
              label="To"
              value={d.to}
              onChange={(to) => update({ to })}
              autoFocus={d.kind === "new" && d.to.length === 0 || d.kind === "forward"}
              trailing={
                !showCc && (
                  <div className="c-toggles">
                    <button className="link-btn" tabIndex={-1} onClick={() => setShowCc(true)}>
                      Cc Bcc
                    </button>
                  </div>
                )
              }
            />
            {showCc && <RecipientField label="Cc" value={d.cc} onChange={(cc) => update({ cc })} />}
            {showCc && <RecipientField label="Bcc" value={d.bcc} onChange={(bcc) => update({ bcc })} />}
            {(d.kind === "new" || d.kind === "draft" || d.kind === "forward" || mode !== "inline") && (
              <div className="c-field">
                <label>Subject</label>
                <input
                  className="plain c-subject"
                  value={d.subject}
                  onChange={(e) => update({ subject: e.target.value })}
                  spellCheck
                />
              </div>
            )}
            <div className="c-editor" onClick={() => editor?.commands.focus()}>
              <EditorContent editor={editor} spellCheck />
              {/* Selecting text raises a small bar of formatting just above it. */}
              {editor && (
                <BubbleMenu
                  editor={editor}
                  className="fmt-bubble"
                  tippyOptions={{ duration: [140, 100], placement: "top", offset: [0, 8], moveTransition: "transform 0.15s ease-out" }}
                >
                  <button
                    type="button"
                    className={cx(editor.isActive("bold") && "on")}
                    title="Bold (Ctrl+B)"
                    onClick={() => editor.chain().focus().toggleBold().run()}
                  >
                    <Bold size={14} />
                  </button>
                  <button
                    type="button"
                    className={cx(editor.isActive("italic") && "on")}
                    title="Italic (Ctrl+I)"
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                  >
                    <Italic size={14} />
                  </button>
                  <span className="fmt-sep" />
                  <button
                    type="button"
                    className={cx(editor.isActive("bulletList") && "on")}
                    title="Bulleted list"
                    onClick={() => editor.chain().focus().toggleBulletList().run()}
                  >
                    <List size={14} />
                  </button>
                  <button type="button" className={cx(editor.isActive("link") && "on")} title="Link" onClick={setLink}>
                    <Link2 size={14} />
                  </button>
                </BubbleMenu>
              )}
              {d.quoteHtml && (
                <div className="quote-toggle" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="quote-pill" aria-expanded={showQuote} onClick={() => setShowQuote((s) => !s)}>
                    <span className="dots">•••</span>
                    {showQuote ? "Hide quoted text" : "Show quoted text"}
                  </button>
                  {showQuote && (
                    <div className="quote-preview" dangerouslySetInnerHTML={{ __html: sanitizeHtml(d.quoteHtml) }} />
                  )}
                </div>
              )}
            </div>
            {(d.attachments.length > 0 || d.forwardAttachments.length > 0) && (
              <div className="c-atts">
                {d.forwardAttachments.map((a, i) => (
                  <span key={`f${i}`} className="c-att" title={a.filename}>
                    <TypeTile name={a.filename} mime={a.mimeType} />
                    <span>{a.filename}</span>
                    <span className="faint">{formatBytes(a.size)}</span>
                    <button
                      className="icon-btn sm"
                      onClick={() => update({ forwardAttachments: d.forwardAttachments.filter((_, j) => j !== i) })}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
                {d.attachments.map((a, i) => (
                  <span key={`a${i}`} className="c-att" title={a.path}>
                    <TypeTile name={a.name} />
                    <span>{a.name}</span>
                    <button
                      className="icon-btn sm"
                      onClick={() => update({ attachments: d.attachments.filter((_, j) => j !== i) })}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {err && <div className="error" style={{ padding: "0 16px" }}>{err}</div>}
            {issues && (
              <div className="send-check" role="alert">
                <div className="send-check-title">Before you send</div>
                <ul>
                  {issues.list.map((i, k) => (
                    <li key={k} className={i.kind}>
                      {i.text}
                    </li>
                  ))}
                </ul>
                <div className="send-check-actions">
                  {issues.list.some((i) => i.kind === "attach") && (
                    <button className="btn outline" onClick={() => void attach().then(() => setIssues(null))}>
                      <Paperclip size={14} /> Attach a file
                    </button>
                  )}
                  <span className="sp" />
                  <button className="btn ghost" onClick={() => setIssues(null)}>
                    Keep editing
                  </button>
                  <button className="btn primary" onClick={() => void send(issues.sendAt, true)}>
                    {issues.sendAt ? "Schedule anyway" : "Send anyway"}
                  </button>
                </div>
              </div>
            )}
            <div className="c-foot">
              <div className="split-btn">
                <button ref={sendBtn} className="btn primary" disabled={busy || checking} onClick={() => void send(null)} title="Send (Ctrl+Enter)">
                  {checking ? <Loader2 size={14} className="spin" /> : null}
                  {checking ? "Checking…" : "Send"}
                  <KeyHint k="Ctrl Enter" />
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  title="Schedule send"
                  onClick={(e) => setScheduleAnchor(e.currentTarget)}
                >
                  <ChevronDown size={15} />
                </button>
              </div>
              <span className="sep" />
              <button
                className={cx("icon-btn sm", editor?.isActive("bold") && "on")}
                title="Bold (Ctrl+B)"
                onClick={() => editor?.chain().focus().toggleBold().run()}
              >
                <Bold size={15} />
              </button>
              <button
                className={cx("icon-btn sm", editor?.isActive("italic") && "on")}
                title="Italic (Ctrl+I)"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
              >
                <Italic size={15} />
              </button>
              <button className={cx("icon-btn sm", editor?.isActive("link") && "on")} title="Link" onClick={setLink}>
                <Link2 size={15} />
              </button>
              <button
                className={cx("icon-btn sm", editor?.isActive("bulletList") && "on")}
                title="Bulleted list"
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
              >
                <List size={15} />
              </button>
              <button
                className={cx("icon-btn sm", editor?.isActive("orderedList") && "on")}
                title="Numbered list"
                onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              >
                <ListOrdered size={15} />
              </button>
              <button
                className={cx("icon-btn sm", editor?.isActive("blockquote") && "on")}
                title="Quote"
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              >
                <Quote size={15} />
              </button>
              <button className="icon-btn sm" title="Insert image" onClick={() => imgInput.current?.click()}>
                <ImagePlus size={15} />
              </button>
              <button className="icon-btn sm" title="Insert template" aria-label="Insert template" onClick={(e) => setTplAnchor(e.currentTarget)}>
                <FileText size={15} />
              </button>
              <button className="icon-btn sm" title="Attach files" onClick={() => void attach()}>
                <Paperclip size={15} />
              </button>
              <input
                ref={imgInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void insertImageFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <span className={cx("status", saveState)} key={saveState}>
                {/* Saved: a check draws itself in the accent, then the line settles back to gray. */}
                {saveState === "saved" && (
                  <svg className="saved-tick" viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                    <path d="m3.5 8.4 2.9 2.9 6.1-6.6" pathLength={1} />
                  </svg>
                )}
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Couldn't save draft" : ""}
              </span>
              <button className="icon-btn sm" title="Discard draft" onClick={() => void discard()}>
                <Trash2 size={15} />
              </button>
            </div>
          </>
        )}
      </div>
      {tplAnchor && (
        <Popover anchor={tplAnchor} onClose={() => setTplAnchor(null)} placement="above">
          <div className="menu-label">Templates</div>
          {templates.length === 0 && (
            <div className="menu-label" style={{ fontWeight: 400, maxWidth: 240 }}>
              No templates yet. Add them in Settings, under Writing.
            </div>
          )}
          {templates.map((t, i) => (
            <button
              key={i}
              className="menu-item"
              onClick={() => {
                setTplAnchor(null);
                const html = t.body
                  .split("\n")
                  .map((l) => `<p>${escapeHtml(l) || "<br>"}</p>`)
                  .join("");
                editor?.chain().focus().insertContent(html).run();
              }}
            >
              <FileText size={14} /> {t.name || "Untitled"}
            </button>
          ))}
        </Popover>
      )}
      {scheduleAnchor && (
        <TimePicker
          anchor={scheduleAnchor}
          kind="schedule"
          placement="above"
          onClose={() => setScheduleAnchor(null)}
          onPick={(ms) => {
            setScheduleAnchor(null);
            void send(ms);
          }}
        />
      )}
    </>
  );
}

/** An attached file's type as a small colored tile (PDF red, images purple…), as in emails. */
function TypeTile({ name, mime }: { name: string; mime?: string }) {
  const k = fileKind(name, mime);
  return (
    <span className="c-att-type" style={{ "--k": k.color } as React.CSSProperties}>
      {k.label.slice(0, 4)}
    </span>
  );
}
