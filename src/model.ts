/*
 * The record, one file per document. Rooms stores what the content script writes to
 * `highlights.json` at `data/docs/<fileKey>/highlights.json`. The document itself can write that
 * file too, so everything read from it goes through parseDocFile.
 */

/** Hi-Lighter's muted palette: the bar dot (`solid`), the paint (`bg`) and its underline (`line`). */
export const COLORS = {
  important: { label: "Important", solid: "#b8893a", bg: "rgba(199,154,62,0.28)", line: "rgba(150,108,40,0.55)" },
  agree: { label: "Agree", solid: "#6f8f6a", bg: "rgba(122,153,113,0.26)", line: "rgba(86,116,80,0.55)" },
  disagree: { label: "DisAgree", solid: "#be7257", bg: "rgba(190,114,87,0.24)", line: "rgba(150,84,62,0.55)" },
  idk: { label: "IDK", solid: "#8e84a0", bg: "rgba(142,132,160,0.26)", line: "rgba(104,93,124,0.55)" },
} as const;

export type Color = keyof typeof COLORS;
export const ORDER: readonly Color[] = ["important", "agree", "disagree", "idk"];

export const DOC_PATH = "highlights.json";
/** Characters of context kept on each side of a highlight. */
export const CONTEXT = 40;
export const TEXT_MAX = 2000;
const NOTE_MAX = 10_000;
const ID_MAX = 64;
const HIGHLIGHTS_MAX = 2000;

export interface Annotation {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** A quote of the document's text: the text, its context, and where it started (a hint, or -1). */
export interface Quote {
  text: string;
  prefix: string;
  suffix: string;
  start: number;
}

export interface Highlight extends Quote {
  id: string;
  color: Color;
  annotations: Annotation[];
  createdAt: string;
  updatedAt: string;
}

export interface DocFile {
  version: 1;
  title: string;
  highlights: Highlight[];
}

export const emptyDoc = (title = ""): DocFile => ({ version: 1, title, highlights: [] });

export const isColor = (v: unknown): v is Color => typeof v === "string" && Object.hasOwn(COLORS, v);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

function parseAnnotation(v: unknown): Annotation | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, ID_MAX);
  const body = str(o.body, NOTE_MAX);
  const createdAt = str(o.createdAt, 40);
  if (!id || !body?.trim() || !createdAt) return null;
  return { id, body, createdAt, updatedAt: str(o.updatedAt, 40) ?? createdAt };
}

/** Hi-Lighter kept one `note` string before it had `annotations`. */
function legacyNote(o: Record<string, unknown>, createdAt: string, updatedAt: string): Annotation[] {
  const body = str(o.note, NOTE_MAX);
  return body?.trim() ? [{ id: `${o.id}-note`, body, createdAt, updatedAt }] : [];
}

export function parseHighlight(v: unknown): Highlight | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, ID_MAX);
  const text = str(o.text, TEXT_MAX);
  const createdAt = str(o.createdAt, 40);
  if (!id || !text?.trim() || !isColor(o.color) || !createdAt) return null;
  const updatedAt = str(o.updatedAt, 40) ?? createdAt;
  const annotations = Array.isArray(o.annotations)
    ? o.annotations.map(parseAnnotation).filter((a): a is Annotation => a !== null)
    : legacyNote(o, createdAt, updatedAt);
  return {
    id,
    color: o.color,
    text,
    prefix: str(o.prefix, CONTEXT) ?? "",
    suffix: str(o.suffix, CONTEXT) ?? "",
    start: Number.isSafeInteger(o.start) && (o.start as number) >= 0 ? (o.start as number) : -1,
    annotations,
    createdAt,
    updatedAt,
  };
}

/** Reads the stored file. Anything unreadable becomes an empty record; bad entries are dropped. */
export function parseDocFile(raw: string | null): DocFile {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return emptyDoc();
  }
  if (!v || typeof v !== "object") return emptyDoc();
  const o = v as Record<string, unknown>;
  const list = Array.isArray(o.highlights) ? o.highlights.slice(0, HIGHLIGHTS_MAX) : [];
  const byId = new Map<string, Highlight>();
  for (const h of list.map(parseHighlight)) if (h && !byId.has(h.id)) byId.set(h.id, h);
  const highlights = [...byId.values()];
  return { version: 1, title: str(o.title, 500) ?? "", highlights };
}

export const serialize = (doc: DocFile): string => JSON.stringify(doc);

/** Every change a reader of the card or the selection bar can make. */
export type Edit =
  | { kind: "add"; highlight: Highlight }
  | { kind: "recolor"; id: string; color: Color }
  | { kind: "remove"; id: string }
  | { kind: "addNote"; id: string; note: Annotation }
  | { kind: "editNote"; id: string; noteId: string; body: string }
  | { kind: "removeNote"; id: string; noteId: string };

/** Applies an edit at time `now`. An emptied note is removed, as in Hi-Lighter. */
export function applyEdit(doc: DocFile, edit: Edit, now: string): DocFile {
  if (edit.kind === "add") return { ...doc, highlights: [...doc.highlights, edit.highlight] };
  if (edit.kind === "remove") return { ...doc, highlights: doc.highlights.filter((h) => h.id !== edit.id) };
  const touch = (h: Highlight): Highlight => {
    switch (edit.kind) {
      case "recolor":
        return { ...h, color: edit.color, updatedAt: now };
      case "addNote":
        return { ...h, annotations: [...h.annotations, edit.note], updatedAt: now };
      case "editNote": {
        const body = edit.body.trim();
        const annotations = body
          ? h.annotations.map((a) => (a.id === edit.noteId ? { ...a, body, updatedAt: now } : a))
          : h.annotations.filter((a) => a.id !== edit.noteId);
        return { ...h, annotations, updatedAt: now };
      }
      case "removeNote":
        return { ...h, annotations: h.annotations.filter((a) => a.id !== edit.noteId), updatedAt: now };
    }
  };
  return { ...doc, highlights: doc.highlights.map((h) => (h.id === edit.id ? touch(h) : h)) };
}

export function newHighlight(quote: Quote, color: Color, id: string, now: string): Highlight {
  return { id, color, ...quote, annotations: [], createdAt: now, updatedAt: now };
}

export function newNote(body: string, id: string, now: string): Annotation {
  return { id, body: body.trim(), createdAt: now, updatedAt: now };
}
