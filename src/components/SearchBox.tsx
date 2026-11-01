import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type React from "react";
import { AtSign, Check, Clock, Mail, Paperclip, Search, Send, Star, Type, X } from "lucide-react";
import { api, type Contact } from "../api";
import { useStore } from "../store";
import { cx } from "../util";
import { motionEase, motionMs, reduceMotion } from "../motionTokens";
import { Avatar } from "./Avatar";

/** The search field, in the list's header: it opens there in place of the folder's name, and the
    list below filters as you type. `extra` sits inside it (the found count); `onDone` is called
    when it's left empty, to fold it back to the folder's name. */
/** Words that narrow a search (from:, has:…), as typed in the field. */
const FILTER_WORD = /^-?(from|to|cc|subject|has|is|in|label|before|after|older_than|newer_than):/i;

/** Words as typed, with the filter words marked to show in the accent. */
const tinted = (text: string) =>
  text.split(/(\s+)/).map((w, i) =>
    FILTER_WORD.test(w) ? (
      <mark key={i} className="search-tok">
        {w}
      </mark>
    ) : (
      w
    ),
  );

/** "after:" a number of days ago, as Gmail writes dates. */
const since = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};
const WHEN: [string, number | null][] = [
  ["Any time", null],
  ["Past week", 7],
  ["Past month", 30],
  ["Past year", 365],
];
const WHERE: [string, string | null][] = [
  ["All mail", null],
  ["Inbox", "inbox"],
  ["Sent", "sent"],
  ["With spam & trash", "anywhere"],
];

/** One of a few (where, when), whose highlight slides to the chosen option as in Settings. */
function SlideSeg({ label, value, children }: { label: string; value: string | null; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const on = ref.current?.querySelector<HTMLElement>(".sp-seg.on");
    if (on) setPill({ x: on.offsetLeft, w: on.offsetWidth });
  }, [value]);
  return (
    <div className="sp-group seg slide" role="radiogroup" aria-label={label} ref={ref}>
      {pill && <span className="sp-seg-pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden />}
      {children}
    </div>
  );
}

export function SearchBox({
  extra,
  onDone,
  panel,
}: {
  extra?: React.ReactNode;
  onDone?: () => void;
  /** Where to lay the search's controls out in full (the list spread wide), instead of a dropdown. */
  panel?: HTMLElement | null;
}) {
  const search = useStore((s) => s.search);
  const recent = useStore((s) => s.recentSearches);
  const setSearch = useStore((s) => s.setSearch);
  const runRemote = useStore((s) => s.runRemoteSearch);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [people, setPeople] = useState<Contact[]>([]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLSpanElement>(null);
  const remoteTimer = useRef<number>();
  const localTimer = useRef<number>();

  useEffect(() => {
    if (!search) setQ("");
    else if (search.query !== q) setQ(search.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.query]);

  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("post:focus-search", focus);
    return () => window.removeEventListener("post:focus-search", focus);
  }, []);

  // People suggestions for the last typed word (skip operators).
  useEffect(() => {
    const word = q.trim().split(/\s+/).pop() ?? "";
    if (word.length < 2 || word.includes(":")) {
      setPeople([]);
      return;
    }
    const t = window.setTimeout(() => {
      api.suggestContacts(word).then((r) => setPeople(r.slice(0, 4))).catch(() => {});
    }, 120);
    return () => window.clearTimeout(t);
  }, [q]);

  const run = (v: string) => {
    window.clearTimeout(localTimer.current);
    window.clearTimeout(remoteTimer.current);
    setQ(v);
    setSearch(v);
    void runRemote();
    setFocused(false);
    input.current?.blur();
  };

  const onChange = (v: string) => {
    setQ(v);
    setActive(-1);
    window.clearTimeout(localTimer.current);
    window.clearTimeout(remoteTimer.current);
    if (!v.trim()) {
      setSearch(null);
      return;
    }
    localTimer.current = window.setTimeout(() => setSearch(v), 120);
    remoteTimer.current = window.setTimeout(() => void runRemote(), 900);
  };

  const items: { kind: "recent" | "person"; label: string; value: string; c?: Contact }[] = q.trim()
    ? people.map((c) => {
        const words = q.trim().split(/\s+/);
        words[words.length - 1] = `from:${c.email}`;
        return { kind: "person" as const, label: c.name || c.email, value: words.join(" "), c };
      })
    : recent.map((r) => ({ kind: "recent" as const, label: r, value: r }));
  const showPop = focused && !panel;
  // Quick filters: a complete one runs straight away; one that needs a value waits for it.
  const addFilter = (token: string) => {
    const next = `${q.trim()}${q.trim() ? " " : ""}${token}`;
    if (token.endsWith(":")) setQ(next);
    else onChange(next);
    input.current?.focus();
  };

  // The wide controls read and write the same words you'd type, so the two never disagree.
  const words = q.trim() ? q.trim().split(/\s+/) : [];
  const hasWord = (w: string) => words.some((x) => x.toLowerCase() === w);
  const valueOf = (key: string) => words.find((x) => x.toLowerCase().startsWith(`${key}:`))?.slice(key.length + 1) ?? null;
  const withWords = (rest: string[]) => {
    onChange(rest.join(" "));
    input.current?.focus();
  };
  const toggleWord = (w: string) => withWords(hasWord(w) ? words.filter((x) => x.toLowerCase() !== w) : [...words, w]);
  const setKey = (key: string, v: string | null) =>
    withWords([...words.filter((x) => !x.toLowerCase().startsWith(`${key}:`)), ...(v ? [`${key}:${v}`] : [])]);
  const after = valueOf("after");
  // The words the controls above set (not the From/To/Subject ones, which carry what you typed).
  const isFilter = (w: string) => /^(is:(unread|starred)|has:attachment|in:|after:)/i.test(w);
  const filtered = words.some(isFilter);
  const where = valueOf("in")?.toLowerCase() ?? null;
  const keep = (e: React.MouseEvent) => e.preventDefault();

  // The controls unfold under the field as the list spreads out, one group after another.
  useLayoutEffect(() => {
    if (!panel || reduceMotion()) return;
    const ease = motionEase("ease");
    panel.animate([{ height: "0px" }, { height: `${panel.scrollHeight}px` }], { duration: motionMs("slow"), easing: ease });
    panel.querySelectorAll(".sp-group, .sp-suggest").forEach((g, i) =>
      g.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
        duration: motionMs("slow"),
        delay: 40 + i * 30,
        easing: ease,
        fill: "backwards",
      }),
    );
  }, [panel]);

  // A recent search let go of folds its pill away, and the ones after it close the gap.
  const forgetPill = (value: string, pill: HTMLElement | null) => {
    if (!pill || reduceMotion()) return forget(value);
    pill.style.overflow = "hidden";
    pill
      .animate([{ opacity: 1, width: `${pill.offsetWidth}px` }, { opacity: 0, width: "0px", marginRight: "-6px" }], {
        duration: motionMs("slow"),
        easing: motionEase("ease"),
        fill: "forwards",
      })
      .finished.then(() => forget(value), () => forget(value));
  };
  const forget = (value: string) => {
    const rest = useStore.getState().recentSearches.filter((r) => r !== value);
    useStore.setState({ recentSearches: rest });
    try {
      localStorage.setItem("post.recentSearches", JSON.stringify(rest));
    } catch {
      /* storage unavailable */
    }
  };

  const wideControls = panel && (
    <div className="sp" aria-label="Search filters">
      <div className="sp-group" role="group" aria-label="Show only">
        {(
          [
            ["is:unread", "Unread", <Mail size={13} key="u" />],
            ["is:starred", "Starred", <Star size={13} key="s" />],
            ["has:attachment", "Has attachment", <Paperclip size={13} key="a" />],
          ] as const
        ).map(([w, label, icon]) => (
          <button key={w} className={cx("search-chip", hasWord(w) && "on")} aria-pressed={hasWord(w)} title={`${label} (${w})`} onMouseDown={keep} onClick={() => toggleWord(w)}>
            {/* On, it wears a check, so it reads as on rather than just pointed at. */}
            {hasWord(w) ? <Check size={13} strokeWidth={2.5} /> : icon}
            {label}
          </button>
        ))}
      </div>
      <SlideSeg label="Where" value={where}>
        {WHERE.map(([label, v]) => (
          <button key={label} role="radio" aria-checked={where === v} title={v ? `${label} (in:${v})` : undefined} className={cx("sp-seg", where === v && "on", v === null && "default")} onMouseDown={keep} onClick={() => setKey("in", v)}>
            {v === "sent" && <Send size={12} />}
            {label}
          </button>
        ))}
      </SlideSeg>
      <SlideSeg label="When" value={after}>
        {WHEN.map(([label, days]) => {
          const on = days === null ? !after : after === since(days);
          return (
            <button key={label} role="radio" aria-checked={on} className={cx("sp-seg", on && "on", days === null && "default")} onMouseDown={keep} onClick={() => setKey("after", days === null ? null : since(days))}>
              {label}
            </button>
          );
        })}
      </SlideSeg>
      <div className="sp-group" role="group" aria-label="Search by">
        {(
          [
            ["from:", "From…", <AtSign size={13} key="f" />],
            ["to:", "To…", <AtSign size={13} key="t" />],
            ["subject:", "Subject…", <Type size={13} key="s" />],
          ] as const
        ).map(([token, label, icon]) => (
          <button key={token} className="search-chip" title={`${label.replace("…", "")} (${token})`} onMouseDown={keep} onClick={() => addFilter(token)}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      {filtered && (
        <button className="sp-clear" onMouseDown={keep} onClick={() => withWords(words.filter((w) => !isFilter(w)))}>
          <X size={12} />
          Clear filters
        </button>
      )}
      {items.length > 0 && (
        <div className="sp-suggest">
          <span className="sp-label">{q.trim() ? "People" : "Recent"}</span>
          {items.map((it) => (
            <span key={it.value} className={cx("sp-pill", it.kind)}>
              <button onMouseDown={keep} onClick={() => run(it.value)} title={it.c ? it.c.email : undefined}>
                {it.c ? <Avatar email={it.c.email} name={it.label} size="xs" /> : <Clock size={13} />}
                {it.c ? `Mail from ${it.label}` : tinted(it.label)}
              </button>
              {it.kind === "recent" && (
                <button className="sp-forget" aria-label={`Remove ${it.label} from recent searches`} title="Remove from recent searches" onMouseDown={keep} onClick={(e) => forgetPill(it.value, e.currentTarget.closest(".sp-pill"))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="search-wrap">
      <label className="search">
        <Search size={15} />
        {/* The typed words over the field, so filter words (from:, has:…) can show in the accent. */}
        <span className="search-field">
        <span className="search-mirror" ref={mirror} aria-hidden>
          <span>{tinted(q)}</span>
        </span>
        <input
          ref={input}
          onScroll={(e) => mirror.current && (mirror.current.scrollLeft = e.currentTarget.scrollLeft)}
          onSelect={(e) => mirror.current && (mirror.current.scrollLeft = e.currentTarget.scrollLeft)}
          value={q}
          placeholder="Search mail"
          spellCheck={false}
          aria-label="Search mail"
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => {
            window.setTimeout(() => setFocused(false), 120);
            // Left with nothing in it for somewhere else: back to the folder's name. (Checked once
            // a picked suggestion has filled it; and staying within the list, opening an email
            // from it included, keeps the search open.)
            window.setTimeout(() => {
              const st = useStore.getState();
              if (input.current?.value.trim() || st.search || st.selectedId) return;
              if (document.activeElement?.closest(".list-pane")) return;
              onDone?.();
            }, 140);
          }}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(active >= 0 && items[active] ? items[active].value : q);
            else if (e.key === "Escape") {
              e.stopPropagation();
              onChange("");
              input.current?.blur();
              onDone?.();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (showPop) setActive((a) => Math.min(items.length - 1, a + 1));
              else {
                input.current?.blur();
                useStore.getState().move(0, false);
              }
            } else if (e.key === "ArrowUp" && showPop) {
              e.preventDefault();
              setActive((a) => Math.max(-1, a - 1));
            }
          }}
        />
        </span>
        {extra}
        {q ? (
          <button
            className="icon-btn sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              onDone?.();
            }}
            aria-label="Clear search"
            title="Clear search (Esc)"
          >
            <X size={14} />
          </button>
        ) : (
          <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => onDone?.()} aria-label="Close search" title="Close search (Esc)">
            <X size={14} />
          </button>
        )}
      </label>
      {showPop && (
        <div className="search-pop" role="listbox" aria-label="Search suggestions">
          <div className="search-chips" aria-label="Filters">
            {[
              ["has:attachment", "Has attachment", <Paperclip size={13} key="a" />],
              ["from:", "From…", <AtSign size={13} key="f" />],
              ["subject:", "Subject…", <Type size={13} key="s" />],
            ].map(([token, label, icon]) => (
              <button
                key={token as string}
                className="search-chip"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addFilter(token as string);
                }}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          {items.length > 0 && <div className="menu-label">{q.trim() ? "People" : "Recent searches"}</div>}
          {items.map((it, i) => (
            <button
              key={it.value}
              role="option"
              aria-selected={i === active}
              className={cx("menu-item", it.kind === "person" && "person", i === active && "active")}
              onMouseDown={(e) => {
                e.preventDefault();
                run(it.value);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {it.c ? (
                <>
                  <Avatar email={it.c.email} name={it.label} size="sm" />
                  <span className="who">
                    <span>Mail from {it.label}</span>
                    {it.c.name && <small>{it.c.email}</small>}
                  </span>
                </>
              ) : (
                <>
                  <span className="search-ic">
                    <Clock size={14} />
                  </span>
                  {it.label}
                  {/* Forget this one. */}
                  <span
                    className="search-forget"
                    role="button"
                    aria-label={`Remove ${it.label} from recent searches`}
                    title="Remove from recent searches"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      forget(it.value);
                    }}
                  >
                    <X size={13} />
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {wideControls && createPortal(wideControls, panel!)}
    </div>
  );
}
