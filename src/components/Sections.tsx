import { useEffect, useMemo, useState } from "react";
import { AtSign, Hash, Loader2, Pencil, Sparkles, Trash2, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { errText, type SenderView } from "../api";
import { useStore } from "../store";
import { goFolder } from "../actions";
import { cx } from "../util";
import { usePresence } from "../hooks";
import { dragJustEnded, startSectionDrag } from "../mailDrag";
import { useMark } from "../motion";
import { Avatar } from "./Avatar";
import { Popover } from "./Popover";
import {
  applyGroup,
  findSection,
  groupOptions,
  makeAiCategory,
  describeSection,
  removeSection,
  saveSection,
  sectionFolder,
  sectionKey,
  sectionSenders,
  type GroupOption,
} from "../senders";

/** A section's icon: the sender's picture, two overlapping pictures for a group, or a sparkle for AI. */
function SectionIcon({ v }: { v: SenderView }) {
  if (v.kind === "ai")
    return (
      <span className="sec-icon ai" aria-hidden>
        <Sparkles size={12} />
      </span>
    );
  const senders = sectionSenders(v);
  if (v.kind === "group") {
    if (senders.length >= 2)
      return (
        <span className="sec-stack" aria-hidden>
          <Avatar email={senders[0]} name={senders[0]} size="xs" />
          <Avatar email={senders[1]} name={senders[1]} size="xs" />
        </span>
      );
    return (
      <span className="sec-icon" aria-hidden>
        {v.domains.length ? <AtSign size={12} /> : v.subjects.length ? <Hash size={12} /> : <Users size={12} />}
      </span>
    );
  }
  return <Avatar email={v.email} name={v.name} size="xs" />;
}

export function SectionItem({ v, count, tab }: { v: SenderView; count?: number; tab: number }) {
  const f = sectionFolder(v);
  const key = sectionKey(v);
  const active = useStore((s) => s.folder === f && !s.search);
  const motion = useMark(`sec:${key}`);
  const edit = () => useStore.setState({ sectionEdit: key });
  const what = v.kind === "ai" ? "AI category" : v.kind === "group" ? "Group" : "Mail from";
  return (
    <div
      className={cx("nav-item sender", active && "active", motion && `sec-${motion}`)}
      data-section={key}
      role="button"
      tabIndex={tab}
      onClick={() => !dragJustEnded() && goFolder(f)}
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest(".nav-x")) startSectionDrag(e, key, v.name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goFolder(f);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        edit();
      }}
      aria-current={active ? "page" : undefined}
      aria-label={`${what} ${v.name}${count ? `, ${count} unread` : ""}`}
      title={v.kind === "ai" ? v.description : v.kind === "group" ? undefined : v.email}
    >
      <SectionIcon v={v} />
      <span className="nav-label">{v.name}</span>
      {!!count && <span className="count">{count > 999 ? "999+" : count}</span>}
      <button
        className="nav-x"
        tabIndex={tab}
        title="Edit"
        aria-label={`Edit ${v.name}`}
        onClick={(e) => {
          e.stopPropagation();
          edit();
        }}
      >
        <Pencil size={12} />
      </button>
      <button
        className="nav-x"
        tabIndex={tab}
        title="Remove from sidebar"
        aria-label={`Remove ${v.name} from the sidebar`}
        onClick={(e) => {
          e.stopPropagation();
          void removeSection(key);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

const OPTION_ICON: Record<GroupOption["id"], JSX.Element> = {
  senders: <Users size={15} />,
  domain: <AtSign size={15} />,
  subject: <Hash size={15} />,
  ai: <Sparkles size={15} />,
};

/** After dropping an email on a section: how should they be grouped? */
export function GroupPopover() {
  const drop = useStore((s) => s.groupDrop);
  const aiOn = useStore((s) => !!s.settings?.aiEnabled);
  const [opts, setOpts] = useState<GroupOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const section = drop ? findSection(drop.key) : null;

  // Where to show it: beside the section it was dropped on (measured once per drop).
  const at = useMemo(() => {
    if (!drop) return null;
    const r = document.querySelector<HTMLElement>(`[data-section="${CSS.escape(drop.key)}"]`)?.getBoundingClientRect();
    return r ? { x: r.right + 6, y: r.top } : { x: 220, y: 120 };
  }, [drop]);

  useEffect(() => {
    setOpts(null);
    setErr(null);
    setBusy(false);
    if (!drop || !section) return;
    let live = true;
    groupOptions(section, drop)
      .then((o) => live && setOpts(o))
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop]);

  if (!drop || !section) return null;
  const close = () => useStore.setState({ groupDrop: null });

  const pick = async (o: GroupOption) => {
    if (o.id !== "ai") {
      close();
      await applyGroup(section, drop, o);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await makeAiCategory(section, drop);
      close();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <Popover point={at ?? undefined} onClose={close} className="group-pop">
      <div className="menu-label">
        {sectionSenders(section).includes(drop.email.toLowerCase())
          ? `Expand ${section.name} to include…`
          : `Group ${drop.name || drop.email} with ${section.name}`}
      </div>
      {!opts && !err && (
        <div className="menu-label faint">
          <Loader2 size={12} className="spin" /> Looking for what they share…
        </div>
      )}
      {opts?.map((o) => {
        const disabled = busy || (o.id === "ai" && !aiOn);
        return (
          <button key={o.id} className="menu-item two-line" disabled={disabled} onClick={() => void pick(o)}>
            {busy && o.id === "ai" ? <Loader2 size={15} className="spin" /> : OPTION_ICON[o.id]}
            <span className="ml">
              <span>{busy && o.id === "ai" ? "Asking Claude…" : o.label}</span>
              <small>{o.id === "ai" && !aiOn ? "Turn on AI in Settings → AI" : o.sub}</small>
            </span>
          </button>
        );
      })}
      {err && <div className="menu-label" style={{ color: "var(--danger)" }}>{err}</div>}
    </Popover>
  );
}

/** Plain-words explanation of what a section shows, at the top of its editor. */
function HowItWorks({ v }: { v: SenderView }) {
  const senders = sectionSenders(v);
  let icon: JSX.Element;
  let text: JSX.Element;
  if (v.kind === "ai") {
    icon = <Sparkles size={15} />;
    text = (
      <>
        Claude reads each email in your Inbox and decides whether it fits the description below. It's a judgment
        about what the email is, not a keyword match, so it can catch emails from senders it hasn't seen before.
      </>
    );
  } else if (v.kind === "group") {
    icon = <Users size={15} />;
    text = (
      <>
        A filter, not a search: it shows every email in your Inbox that matches <b>any</b> of the rules below (an exact
        sender address, anyone at a company's domain, or a word in the subject), and updates as new mail arrives.
      </>
    );
  } else {
    icon = <AtSign size={15} />;
    text = (
      <>
        A filter, not a search: it shows every email in your Inbox sent from <b>{senders[0] ?? v.email}</b>, matched
        exactly on the address, and updates as new mail arrives. To widen it, drag another email onto it in the
        sidebar.
      </>
    );
  }
  return (
    <div className="how">
      {icon}
      <p>
        {text} Emails also stay in your Inbox; nothing is moved.
      </p>
    </div>
  );
}

/** Rename a section, adjust its rules, or edit what an AI category collects. */
export function SectionEditor() {
  const key = useStore((s) => s.sectionEdit);
  const { mounted, closing } = usePresence(!!key);
  const [draft, setDraft] = useState<SenderView | null>(null);
  // For a sender or group: what to tell Claude this should collect instead of fixed rules.
  const [describe, setDescribe] = useState("");
  const [busy, setBusy] = useState(false);
  const aiOn = useStore((s) => !!s.settings?.aiEnabled);

  useEffect(() => {
    if (key) setDraft(findSection(key));
    setDescribe("");
    setBusy(false);
  }, [key]);

  if (!mounted || !draft) return null;
  const close = () => useStore.setState({ sectionEdit: null });
  const save = async () => {
    if (!key) return;
    const next = { ...draft, name: draft.name.trim() || draft.name };
    if (draft.kind !== "ai" && describe.trim()) {
      setBusy(true);
      try {
        await describeSection(key, next, describe.trim());
      } finally {
        setBusy(false);
      }
    } else await saveSection(key, next);
    close();
  };
  const drop = (field: "senders" | "domains" | "subjects", value: string) =>
    setDraft({ ...draft, [field]: draft[field].filter((x) => x !== value), email: field === "senders" && draft.email === value ? "" : draft.email });
  const rules: { field: "senders" | "domains" | "subjects"; value: string; label: string }[] =
    draft.kind === "group"
      ? [
          ...sectionSenders(draft).map((s) => ({ field: "senders" as const, value: s, label: s })),
          ...draft.domains.map((d) => ({ field: "domains" as const, value: d, label: `Anyone at @${d}` })),
          ...draft.subjects.map((w) => ({ field: "subjects" as const, value: w, label: `Subject mentions “${w}”` })),
        ]
      : [];

  return createPortal(
    <>
      <div className={cx("scrim", closing && "closing")} onClick={close} />
      <div className={cx("modal section-editor", closing && "closing")} role="dialog" aria-label={`Edit ${draft.name}`}>
        <h3>{draft.kind === "ai" ? "AI category" : draft.kind === "group" ? "Group filter" : "Sender filter"}</h3>
        <HowItWorks v={draft} />
        <label className="field">
          <span>Name</span>
          <input className="input" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        {draft.kind === "ai" && (
          <label className="field">
            <span>What belongs here</span>
            <textarea
              className="input"
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <small className="faint">
              Claude sorts your inbox by this. Drag emails onto the category to add examples; right-click one in it and
              choose “Not in this category” to correct it.
            </small>
          </label>
        )}
        {draft.kind === "group" && (
          <div className="field">
            <span>Includes inbox mail where any of these match</span>
            <div className="rule-chips">
              {rules.map((r) => (
                <span key={r.field + r.value} className="rule-chip">
                  {r.label}
                  {rules.length > 1 && (
                    <button aria-label={`Remove ${r.label}`} onClick={() => drop(r.field, r.value)}>
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <small className="faint">Drag another email onto this group in the sidebar to add to it.</small>
          </div>
        )}
        {draft.kind !== "ai" && (
          <label className="field ai-describe">
            <span>
              <Sparkles size={12} /> Or describe it to Claude
            </span>
            <textarea
              className="input"
              rows={2}
              disabled={!aiOn}
              placeholder={
                aiOn ? "e.g. Order confirmations and shipping updates from any store" : "Turn on AI in Settings → AI to use this"
              }
              value={describe}
              onChange={(e) => setDescribe(e.target.value)}
            />
            <small className="faint">
              Claude will fill this {draft.kind === "group" ? "group" : "section"} with matching emails from now on, and
              keep the ones it has now as examples.
            </small>
          </label>
        )}
        <div className="editor-actions">
          <button
            className="btn ghost danger"
            onClick={() => {
              if (key) void removeSection(key);
              close();
            }}
          >
            <Trash2 size={14} /> Remove
          </button>
          <span className="sp" />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {draft.kind !== "ai" && describe.trim() ? "Save and sort with AI" : "Save"}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

