import { PluginError, type RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ANSWERS, CHAT_LABEL, editAnswer, FOCUS_PATH, parseFocus } from "../answers";
import { COLORS, newId, newNote, ORDER, ORPHANS_PATH, parseIds, type Color, type Edit, type Highlight } from "../model";
import { collect, docFileOf, type Collection, type Found, type Group, type Place } from "./collect";

/** Writes from a document come in bursts (a save, then its orphan report); read once they settle. */
const REFRESH_DELAY_MS = 150;

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; collection: Collection };

export interface Filter {
  color: Color | null;
  query: string;
}

const matches = (h: Highlight, { color, query }: Filter) => {
  if (color && h.color !== color) return false;
  if (!query) return true;
  return h.text.toLowerCase().includes(query) || h.annotations.some((a) => a.body.toLowerCase().includes(query));
};

export function filterGroups(groups: readonly Group[], filter: Filter): Group[] {
  const f = { ...filter, query: filter.query.trim().toLowerCase() };
  return groups.flatMap((g) => {
    const found = g.found.filter(({ h }) => matches(h, f));
    return found.length ? [{ ...g, found }] : [];
  });
}

/** A row's key, unique across the tab: the same highlight id can be in a document and an answer. */
const rowKey = ({ h, place }: Found) => (place.kind === "doc" ? `doc:${place.fileKey}#${h.id}` : `${place.path}#${h.id}`);

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : dateFormat.format(t);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function HighlightList({ rooms }: { rooms: RoomsPlugin }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [color, setColor] = useState<Color | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [notice, setNotice] = useState<string | null>(null);
  /** Answer rows whose notes are open, by row key. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** The row the range menu over an answer asked to show. */
  const [focus, setFocus] = useState<string | null>(null);

  const latest = useRef(0);
  const collecting = useRef(false);
  const refresh = useCallback(async () => {
    const run = ++latest.current;
    collecting.current = true;
    try {
      const collection = await collect(rooms);
      performance.mark("rooms-highlight:collected");
      if (run === latest.current) setLoad({ kind: "ready", collection });
    } catch (e) {
      console.warn("[highlights] could not list highlights", e);
      if (run === latest.current) setLoad((l) => (l.kind === "ready" ? l : { kind: "failed" }));
    } finally {
      if (run === latest.current) collecting.current = false;
    }
  }, [rooms]);

  /** The newest orphan read per document; an older one that lands later is dropped. */
  const orphanReads = useRef(new Map<string, number>());
  const refreshOrphans = useCallback(
    async (fileKey: string) => {
      const run = latest.current;
      const read = (orphanReads.current.get(fileKey) ?? 0) + 1;
      orphanReads.current.set(fileKey, read);
      let raw: string | null;
      try {
        raw = await rooms.storage.read(`docs/${fileKey}/${ORPHANS_PATH}`);
      } catch (e) {
        console.warn("[highlights] could not read lost text", e);
        return;
      }
      if (run !== latest.current || orphanReads.current.get(fileKey) !== read) return;
      const orphans = new Set(parseIds(raw));
      const key = `doc:${fileKey}`;
      setLoad((l) =>
        l.kind === "ready" ? { ...l, collection: { ...l.collection, groups: l.collection.groups.map((g) => (g.key === key ? { ...g, orphans } : g)) } } : l,
      );
    },
    [rooms],
  );

  const readFocus = useCallback(async () => {
    let raw: string | null;
    try {
      raw = await rooms.storage.read(FOCUS_PATH);
    } catch {
      return;
    }
    const f = parseFocus(raw, Date.now());
    if (!f) return;
    rooms.storage.delete(FOCUS_PATH).catch(() => {});
    const key = `${f.path}#${f.id}`;
    setColor(null);
    setQuery("");
    setExpanded((s) => new Set(s).add(key));
    setFocus(key);
  }, [rooms]);

  useEffect(() => {
    void refresh();
    void readFocus();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = rooms.storage.onChange((path) => {
      if (path === FOCUS_PATH) return void readFocus();
      if (!path.startsWith("docs/") && !path.startsWith(ANSWERS)) return;
      const file = docFileOf(path);
      // A listing in flight or about to start may have read this file before it changed, so it
      // lists again; otherwise only this document's lost text is read.
      if (file?.name === ORPHANS_PATH && !timer && !collecting.current) return void refreshOrphans(file.fileKey);
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [rooms, refresh, refreshOrphans, readFocus]);

  const listed = useRef(false);
  useLayoutEffect(() => {
    if (load.kind !== "ready" || listed.current) return;
    listed.current = true;
    performance.mark("rooms-highlight:listed");
    requestAnimationFrame(() => setTimeout(() => performance.mark("rooms-highlight:painted")));
  }, [load]);

  const groups = load.kind === "ready" ? load.collection.groups : [];
  const shown = useMemo(() => filterGroups(groups, { color, query: deferredQuery }), [groups, color, deferredQuery]);
  const counts = useMemo(() => {
    const c = new Map<Color, number>(ORDER.map((k) => [k, 0]));
    for (const g of groups) for (const { h } of g.found) c.set(h.color, c.get(h.color)! + 1);
    return c;
  }, [groups]);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const open = useCallback<Open>(
    async (target) => {
      setNotice(null);
      const answer = "place" in target && target.place.kind === "answer";
      try {
        if (!("place" in target)) await rooms.open(target.group);
        else if (target.place.kind === "doc") await rooms.open({ fileKey: target.place.fileKey, anchor: { highlightId: target.id } });
        else await rooms.open({ surface: target.place.surface, rangeId: target.id });
      } catch (e) {
        console.warn("[highlights] could not open", e);
        if (e instanceof PluginError && e.code === "not_found") {
          setNotice(answer ? "That answer is no longer in its chat." : "That document is no longer in a room.");
          void refresh();
        } else {
          setNotice(answer ? "That answer could not be opened. Try again." : "That document could not be opened. Try again.");
        }
      }
    },
    [rooms, refresh],
  );
  const toggle = useCallback((key: string) => {
    setFocus(null);
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const editNote = useCallback(
    async (path: string, edit: Edit) => {
      try {
        await editAnswer(rooms.storage, path, edit, new Date().toISOString());
      } catch (e) {
        console.warn("[highlights] could not save the note", e);
        setNotice("That note could not be saved. Try again.");
      }
      await refresh();
    },
    [rooms, refresh],
  );
  const listRef = useRef<HTMLElement>(null);

  return (
    <div className="app">
      <header className="top">
        <h1>Highlights</h1>
        {total > 0 ? <span className="total">{total}</span> : null}
      </header>
      {total > 0 ? (
        <div className="filters">
          <input
            type="search"
            className="line"
            aria-label="Search highlights"
            placeholder="Search quotes and notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="colors" role="group" aria-label="Filter by color">
            <button type="button" className="chip" aria-pressed={color === null} onClick={() => setColor(null)}>
              All
            </button>
            {ORDER.map((c) => (
              <button
                key={c}
                type="button"
                className="chip"
                aria-pressed={color === c}
                onClick={() => setColor(color === c ? null : c)}
                style={{ "--hl-solid": COLORS[c].solid } as CSSProperties}
              >
                <span className="dot" aria-hidden />
                {COLORS[c].label}
                <span className="chip-count">{counts.get(c)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <main className="list" ref={listRef}>
        {load.kind === "loading" ? <p className="muted pad">Loading…</p> : null}
        {load.kind === "failed" ? (
          <div className="message">
            <p>Highlights could not be listed.</p>
            <button type="button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : null}
        {load.kind === "ready" && !total ? (
          <div className="message">
            <p>No highlights yet</p>
            <p className="muted">Select text in a document and pick a color. Every highlight shows up here.</p>
          </div>
        ) : null}
        {total > 0 && !shown.length ? <p className="muted pad">No highlights match.</p> : null}
        {shown.length ? <GroupList groups={shown} open={open} scroller={listRef} expanded={expanded} toggle={toggle} editNote={editNote} focus={focus} /> : null}
        {load.kind === "ready" && load.collection.skipped ? (
          <p className="muted pad small-print">{plural(load.collection.skipped, "highlight file")} could not be read.</p>
        ) : null}
      </main>
    </div>
  );
}

type Open = (target: { group: { fileKey: string } | { roomId: string } } | { place: Place; id: string }) => void;
type EditNote = (path: string, edit: Edit) => Promise<void>;

/** One line of the windowed list: a group's header, or one of its rows. */
type Item = { kind: "head"; group: Group } | { kind: "row"; group: Group; found: Found; key: string; last: boolean };

const itemsOf = (groups: readonly Group[]): Item[] =>
  groups.flatMap((group) => [
    { kind: "head", group } as const,
    ...group.found.map((found, i) => ({ kind: "row", group, found, key: rowKey(found), last: i === group.found.length - 1 }) as const),
  ]);

interface GroupListProps {
  groups: readonly Group[];
  open: Open;
  scroller: RefObject<HTMLElement | null>;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  editNote: EditNote;
  focus: string | null;
}

/**
 * Renders only the lines near the scroll position: thousands of rows took WebKit over half a
 * second to lay out. The rendered lines keep their sections and lists, so each group stays a
 * region of rows, and a group that is cut off at the top keeps its rows in its region.
 */
function GroupList({ groups, open, scroller, expanded, toggle, editNote, focus }: GroupListProps) {
  const items = useMemo(() => itemsOf(groups), [groups]);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => {
      const it = items[i];
      return it.kind === "head" ? 30 : 78 + 22 * Math.min(it.found.h.annotations.length, 3) + (expanded.has(it.key) ? 120 : 0);
    },
    getItemKey: (i) => {
      const it = items[i];
      return it.kind === "head" ? `g:${it.group.key}` : `h:${it.key}`;
    },
    overscan: 10,
  });
  const focusAt = focus ? items.findIndex((it) => it.kind === "row" && it.key === focus) : -1;
  /** Scrolls to a focused row once, so a later listing does not pull the list back to it. */
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!focus) scrolledTo.current = null;
    if (focusAt < 0 || scrolledTo.current === focus) return;
    scrolledTo.current = focus;
    virtual.scrollToIndex(focusAt, { align: "center" });
  }, [focus, focusAt, virtual]);

  const lines = virtual.getVirtualItems();
  const sections: { group: Group; lines: typeof lines }[] = [];
  for (const line of lines) {
    const group = items[line.index].group;
    const last = sections[sections.length - 1];
    if (last?.group === group) last.lines.push(line);
    else sections.push({ group, lines: [line] });
  }
  return (
    <div className="window" style={{ height: virtual.getTotalSize() }}>
      <div className="window-slice" style={{ transform: `translateY(${lines[0]?.start ?? 0}px)` }}>
        {sections.map(({ group, lines }) => {
          const rows = lines.filter((l) => items[l.index].kind === "row");
          return (
            <section key={group.key} className="doc" aria-label={group.title}>
              {lines[0] && items[lines[0].index].kind === "head" ? <GroupHead group={group} open={open} index={lines[0].index} measure={virtual.measureElement} /> : null}
              {rows.length ? (
                <ul className="items" role="list">
                  {rows.map((l) => {
                    const { found, key, last } = items[l.index] as Extract<Item, { kind: "row" }>;
                    return (
                      <li key={l.key} className={last ? "last" : undefined} data-index={l.index} ref={virtual.measureElement}>
                        <Row
                          found={found}
                          rowKey={key}
                          orphan={found.place.kind === "doc" && group.orphans.has(found.h.id)}
                          open={group.removed ? undefined : open}
                          expanded={expanded.has(key)}
                          focused={focus === key}
                          toggle={toggle}
                          editNote={editNote}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GroupHead({ group, open, index, measure }: { group: Group; open: Open; index: number; measure: (el: Element | null) => void }) {
  const target = group.removed ? null : group.target;
  return (
    <header className="doc-head" data-index={index} ref={measure}>
      {target ? (
        <h2 className="doc-title">
          <button type="button" onClick={() => open({ group: target })}>
            {group.title}
          </button>
        </h2>
      ) : (
        <h2 className="doc-title">{group.title}</h2>
      )}
      <span className="doc-where">{group.where}</span>
    </header>
  );
}

interface RowProps {
  found: Found;
  rowKey: string;
  orphan: boolean;
  open?: Open;
  expanded: boolean;
  focused: boolean;
  toggle: (key: string) => void;
  editNote: EditNote;
}

const Row = memo(function Row({ found, rowKey, orphan, open, expanded, focused, toggle, editNote }: RowProps) {
  const { h, place } = found;
  const c = COLORS[h.color];
  const chat = place.kind === "answer" ? CHAT_LABEL[place.surface.scope.kind] : "";
  const meta = [c.label, chat, shortDate(h.createdAt), h.annotations.length ? plural(h.annotations.length, "note") : ""].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="quote">{h.text}</span>
      {expanded
        ? null
        : h.annotations.map((a) => (
            <span key={a.id} className="note">
              {a.body}
            </span>
          ))}
      <span className="meta">
        <span className="dot" aria-hidden />
        <span>
          {meta}
          {orphan ? (
            <>
              {" · "}
              <span className="orphan">Text not found</span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );
  const style = { "--hl-solid": c.solid, "--hl-bg": c.bg } as CSSProperties;
  const card = open ? (
    <button type="button" className="hl" style={style} onClick={() => open({ place, id: h.id })}>
      {body}
    </button>
  ) : (
    <div className="hl inert" style={style}>
      {body}
    </div>
  );
  if (place.kind !== "answer") return card;
  // Notes on answer highlights are edited here: the app draws only buttons and menus over answers.
  return (
    <div className="answer-row">
      {card}
      <button type="button" className="notes-toggle" aria-expanded={expanded} onClick={() => toggle(rowKey)}>
        {expanded ? "Hide notes" : h.annotations.length ? `Edit ${plural(h.annotations.length, "note")}` : "Add a note"}
      </button>
      {expanded ? <Notes h={h} path={place.path} editNote={editNote} autoFocus={focused} /> : null}
    </div>
  );
});

function Notes({ h, path, editNote, autoFocus }: { h: Highlight; path: string; editNote: EditNote; autoFocus: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    void editNote(path, { kind: "addNote", id: h.id, note: newNote(draft, newId(), new Date().toISOString()) });
    setDraft("");
  };
  return (
    <div className="notes">
      {h.annotations.map((a) => (
        <div key={`${a.id}:${a.updatedAt}`} className="note-edit">
          <textarea
            aria-label="Note"
            defaultValue={a.body}
            rows={2}
            onBlur={(e) => {
              if (e.target.value.trim() !== a.body) void editNote(path, { kind: "editNote", id: h.id, noteId: a.id, body: e.target.value });
            }}
          />
          <button type="button" onClick={() => void editNote(path, { kind: "removeNote", id: h.id, noteId: a.id })}>
            Delete
          </button>
        </div>
      ))}
      <div className="note-edit">
        <textarea
          aria-label="New note"
          placeholder="Add a note"
          rows={2}
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
          }}
        />
        <button type="button" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
