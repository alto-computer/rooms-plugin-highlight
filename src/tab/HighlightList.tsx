import type { RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { COLORS, ORDER, type Color, type Highlight } from "../model";
import { collect, type Collection, type DocHighlights } from "./collect";

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
  const refresh = useCallback(async () => {
    const run = ++latest.current;
    try {
      const collection = await collect(rooms);
      if (run === latest.current) setLoad({ kind: "ready", collection });
    } catch (e) {
      console.warn("[highlights] could not list highlights", e);
      if (run === latest.current) setLoad((l) => (l.kind === "ready" ? l : { kind: "failed" }));
    }
  }, [rooms]);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = rooms.storage.onChange((path) => {
      if (!path.startsWith("docs/")) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [rooms, refresh]);

  const docs = load.kind === "ready" ? load.collection.docs : [];
  const shown = useMemo(() => filterDocs(docs, { color, query: deferredQuery }), [docs, color, deferredQuery]);
  const counts = useMemo(() => {
    const c = new Map<Color, number>(ORDER.map((k) => [k, 0]));
    for (const d of docs) for (const h of d.highlights) c.set(h.color, c.get(h.color)! + 1);
    return c;
  }, [docs]);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const open = async (fileKey: string, highlightId?: string) => {
    setNotice(null);
    try {
      await rooms.open(highlightId ? { fileKey, anchor: { highlightId } } : { fileKey });
    } catch (e) {
      console.warn("[highlights] could not open the document", e);
      setNotice("That document is no longer in a room.");
      void refresh();
    }
  };

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
      <main className="list">
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
        {shown.map((d) => (
          <DocSection key={d.fileKey} doc={d} open={open} />
        ))}
        {load.kind === "ready" && load.collection.skipped ? (
          <p className="muted pad small-print">{plural(load.collection.skipped, "highlight file")} could not be read.</p>
        ) : null}
      </main>
    </div>
  );
}

function DocSection({ doc, open }: { doc: DocHighlights; open: (fileKey: string, highlightId?: string) => void }) {
  const removed = doc.rooms.length === 0;
  return (
    <section className="doc" aria-label={doc.title}>
      <header className="doc-head">
        {removed ? (
          <h2 className="doc-title">{doc.title}</h2>
        ) : (
          <h2 className="doc-title">
            <button type="button" onClick={() => open(doc.fileKey)}>
              {doc.title}
            </button>
          </h2>
        )}
        <span className="doc-where">{removed ? "Doc removed" : doc.rooms.join(" · ")}</span>
      </header>
      <ul className="items">
        {doc.highlights.map((h) => (
          <li key={h.id}>
            <Row h={h} orphan={doc.orphans.has(h.id)} onOpen={removed ? undefined : () => open(doc.fileKey, h.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ h, orphan, onOpen }: { h: Highlight; orphan: boolean; onOpen?: () => void }) {
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
  return onOpen ? (
    <button type="button" className="hl" style={style} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="hl inert" style={style}>
      {body}
    </div>
  );
}
