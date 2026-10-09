import { PluginError, type RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { COLORS, ORDER, ORPHANS_PATH, parseIds, type Color, type Highlight } from "../model";
import { collect, docFileOf, type Collection, type DocHighlights } from "./collect";

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

export function filterDocs(docs: readonly DocHighlights[], filter: Filter): DocHighlights[] {
  const f = { ...filter, query: filter.query.trim().toLowerCase() };
  return docs.flatMap((d) => {
    const highlights = d.highlights.filter((h) => matches(h, f));
    return highlights.length ? [{ ...d, highlights }] : [];
  });
}

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
      setLoad((l) =>
        l.kind === "ready" ? { ...l, collection: { ...l.collection, docs: l.collection.docs.map((d) => (d.fileKey === fileKey ? { ...d, orphans } : d)) } } : l,
      );
    },
    [rooms],
  );

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = rooms.storage.onChange((path) => {
      if (!path.startsWith("docs/")) return;
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
  }, [rooms, refresh, refreshOrphans]);

  const listed = useRef(false);
  useLayoutEffect(() => {
    if (load.kind !== "ready" || listed.current) return;
    listed.current = true;
    performance.mark("rooms-highlight:listed");
    requestAnimationFrame(() => setTimeout(() => performance.mark("rooms-highlight:painted")));
  }, [load]);

  const docs = load.kind === "ready" ? load.collection.docs : [];
  const shown = useMemo(() => filterDocs(docs, { color, query: deferredQuery }), [docs, color, deferredQuery]);
  const counts = useMemo(() => {
    const c = new Map<Color, number>(ORDER.map((k) => [k, 0]));
    for (const d of docs) for (const h of d.highlights) c.set(h.color, c.get(h.color)! + 1);
    return c;
  }, [docs]);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const open = useCallback(
    async (fileKey: string, highlightId?: string) => {
      setNotice(null);
      try {
        await rooms.open(highlightId ? { fileKey, anchor: { highlightId } } : { fileKey });
      } catch (e) {
        console.warn("[highlights] could not open the document", e);
        if (e instanceof PluginError && e.code === "not_found") {
          setNotice("That document is no longer in a room.");
          void refresh();
        } else {
          setNotice("That document could not be opened. Try again.");
        }
      }
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
        {shown.length ? <DocList docs={shown} open={open} scroller={listRef} /> : null}
        {load.kind === "ready" && load.collection.skipped ? (
          <p className="muted pad small-print">{plural(load.collection.skipped, "highlight file")} could not be read.</p>
        ) : null}
      </main>
    </div>
  );
}

type Open = (fileKey: string, highlightId?: string) => void;

/** One line of the windowed list: a document's header, or one of its rows. */
type Item = { kind: "head"; doc: DocHighlights } | { kind: "row"; doc: DocHighlights; h: Highlight; last: boolean };

const itemsOf = (docs: readonly DocHighlights[]): Item[] =>
  docs.flatMap((doc) => [{ kind: "head", doc } as const, ...doc.highlights.map((h, i) => ({ kind: "row", doc, h, last: i === doc.highlights.length - 1 }) as const)]);

/**
 * Renders only the lines near the scroll position: thousands of rows took WebKit over half a
 * second to lay out. The rendered lines keep their sections and lists, so each document stays a
 * region of rows, and a document that is cut off at the top keeps its rows in its region.
 */
function DocList({ docs, open, scroller }: { docs: readonly DocHighlights[]; open: Open; scroller: RefObject<HTMLElement | null> }) {
  const items = useMemo(() => itemsOf(docs), [docs]);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (items[i].kind === "head" ? 30 : 78 + 22 * Math.min(items[i].h.annotations.length, 3)),
    getItemKey: (i) => {
      const it = items[i];
      return it.kind === "head" ? `d:${it.doc.fileKey}` : `h:${it.doc.fileKey}:${it.h.id}`;
    },
    overscan: 10,
  });
  const lines = virtual.getVirtualItems();
  const sections: { doc: DocHighlights; lines: typeof lines }[] = [];
  for (const line of lines) {
    const doc = items[line.index].doc;
    const last = sections[sections.length - 1];
    if (last?.doc === doc) last.lines.push(line);
    else sections.push({ doc, lines: [line] });
  }
  return (
    <div className="window" style={{ height: virtual.getTotalSize() }}>
      <div className="window-slice" style={{ transform: `translateY(${lines[0]?.start ?? 0}px)` }}>
        {sections.map(({ doc, lines }) => {
          const removed = doc.rooms.length === 0;
          const rows = lines.filter((l) => items[l.index].kind === "row");
          return (
            <section key={doc.fileKey} className="doc" aria-label={doc.title}>
              {lines[0] && items[lines[0].index].kind === "head" ? <DocHead doc={doc} open={removed ? undefined : open} index={lines[0].index} measure={virtual.measureElement} /> : null}
              {rows.length ? (
                <ul className="items" role="list">
                  {rows.map((l) => {
                    const { h, last } = items[l.index] as Extract<Item, { kind: "row" }>;
                    return (
                      <li key={l.key} className={last ? "last" : undefined} data-index={l.index} ref={virtual.measureElement}>
                        <Row h={h} orphan={doc.orphans.has(h.id)} fileKey={doc.fileKey} open={removed ? undefined : open} />
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

function DocHead({ doc, open, index, measure }: { doc: DocHighlights; open?: Open; index: number; measure: (el: Element | null) => void }) {
  return (
    <header className="doc-head" data-index={index} ref={measure}>
      {open ? (
        <h2 className="doc-title">
          <button type="button" onClick={() => open(doc.fileKey)}>
            {doc.title}
          </button>
        </h2>
      ) : (
        <h2 className="doc-title">{doc.title}</h2>
      )}
      <span className="doc-where">{open ? doc.rooms.join(" · ") : "Doc removed"}</span>
    </header>
  );
}

const Row = memo(function Row({ h, orphan, fileKey, open }: { h: Highlight; orphan: boolean; fileKey: string; open?: Open }) {
  const c = COLORS[h.color];
  const meta = [c.label, shortDate(h.createdAt), h.annotations.length ? plural(h.annotations.length, "note") : ""].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="quote">{h.text}</span>
      {h.annotations.map((a) => (
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
  return open ? (
    <button type="button" className="hl" style={style} onClick={() => open(fileKey, h.id)}>
      {body}
    </button>
  ) : (
    <div className="hl inert" style={style}>
      {body}
    </div>
  );
});
