import { useEffect, useRef, useState } from "react";
import type React from "react";
import { AtSign, Clock, Paperclip, Search, Type, X } from "lucide-react";
import { api, type Contact } from "../api";
import { useStore } from "../store";
import { cx } from "../util";
import { Avatar } from "./Avatar";

/** The search field, in the list's header: it opens there in place of the folder's name, and the
    list below filters as you type. `extra` sits inside it (the found count); `onDone` is called
    when it's left empty, to fold it back to the folder's name. */
export function SearchBox({ extra, onDone }: { extra?: React.ReactNode; onDone?: () => void }) {
  const search = useStore((s) => s.search);
  const recent = useStore((s) => s.recentSearches);
  const setSearch = useStore((s) => s.setSearch);
  const runRemote = useStore((s) => s.runRemoteSearch);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [people, setPeople] = useState<Contact[]>([]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
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
  const showPop = focused;
  // Quick filters: a complete one runs straight away; one that needs a value waits for it.
  const addFilter = (token: string) => {
    const next = `${q.trim()}${q.trim() ? " " : ""}${token}`;
    if (token.endsWith(":")) setQ(next);
    else onChange(next);
    input.current?.focus();
  };

  return (
    <div className="search-wrap">
      <label className="search">
        <Search size={15} />
        <input
          ref={input}
          value={q}
          placeholder="Search mail"
          spellCheck={false}
          aria-label="Search mail"
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => {
            window.setTimeout(() => setFocused(false), 120);
            // Left with nothing in it: back to the folder's name.
            if (!input.current?.value.trim()) window.setTimeout(() => onDone?.(), 140);
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
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
