/*
 * Highlights on host surfaces: chat answers and notes. The background page keeps each surface's
 * highlights in one file at `<surfacePath>.json`, in the same shape as a document's, and the tab
 * reads and edits the same files. Only frames of this plugin can write under `answer/` and `note/`.
 */
import { surfacePath, type AnswerScope, type RoomsPlugin, type SurfaceId, type SurfaceStyles } from "@alto-rooms/plugin-sdk";
import { applyEdit, COLORS, ORDER, readDocFile, serialize, type DocFile, type Edit } from "./model";

/** The folders under `data/` that hold surface files. */
export const SURFACE_DIRS = ["answer/", "note/"] as const;
export const isSurfaceData = (path: string): boolean => SURFACE_DIRS.some((d) => path.startsWith(d));

const TITLE_MAX = 80;

export const surfaceFile = (s: SurfaceId): string => `${surfacePath(s)}.json`;

/**
 * The ids of a surface's highlights whose text the surface no longer has, as the background page
 * last saw, beside the surface's file. No `.json`, so it never reads as a surface's own path.
 */
export const orphansPathOf = (file: string): string => file.replace(/\.json$/, ".orphans");

/**
 * What a stored path says before its file is read: an answer in full; for a note only its date,
 * since the SDK hashes the note's name into the path. The name is the file's `title`.
 */
export type StoredPath = { kind: "answer"; surface: SurfaceId } | { kind: "note"; date: string };

const SCOPED = /^answer\/(artifact|room|day)\/([^/]+)\/([^/]+)\.json$/;
const SESSION = /^answer\/session\/([^/]+)\/([^/]+)\/([^/]+)\.json$/;
const NOTE = /^note\/(\d{4}-\d{2}-\d{2})\/[^/]+\.json$/;

export function parseStoredPath(path: string): StoredPath | null {
  const n = NOTE.exec(path);
  if (n) return { kind: "note", date: n[1] };
  let surface: SurfaceId | null = null;
  const s = SESSION.exec(path);
  const m = SCOPED.exec(path);
  if (s) surface = { kind: "answer", scope: { kind: "session", agent: s[1], id: s[2] }, turnId: s[3] };
  else if (m) {
    const scope: AnswerScope = m[1] === "artifact" ? { kind: "artifact", fileKey: m[2] } : m[1] === "room" ? { kind: "room", roomId: m[2] } : { kind: "day", date: m[2] };
    surface = { kind: "answer", scope, turnId: m[3] };
  }
  return surface && surfaceFile(surface) === path ? { kind: "answer", surface } : null;
}

/** The surface a stored file belongs to, given the file's title; null when the two disagree. */
export function surfaceAt(path: string, title: string): SurfaceId | null {
  const p = parseStoredPath(path);
  if (!p) return null;
  const surface: SurfaceId = p.kind === "answer" ? p.surface : { kind: "note", date: p.date, name: title };
  return surfaceFile(surface) === path ? surface : null;
}

/**
 * The stored title of a surface's file: a note's name, which its path cannot give back, or the
 * start of an answer, since a background page never sees the question.
 */
export const surfaceTitle = (s: SurfaceId, text: string): string => (s.kind === "note" ? s.name : text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX));

/** The four document colors as surface paint, so a highlight in an answer or a note reads like a document one. */
export const PAINT_STYLES: SurfaceStyles = Object.fromEntries(ORDER.map((c) => [c, COLORS[c].bg]));

export const CHAT_LABEL: Record<AnswerScope["kind"], string> = {
  artifact: "Doc chat",
  room: "Room chat",
  day: "Day chat",
  session: "Agent chat",
};

/**
 * Reads the surface's file, applies `edit`, and writes it back, or deletes it once no highlight is
 * left. `title` replaces the stored one when given. Returns the new record, or null when the
 * stored file is not a record, which is left alone.
 */
export async function editSurface(storage: RoomsPlugin["storage"], path: string, edit: Edit, now: string, title?: string): Promise<DocFile | null> {
  const raw = await storage.read(path);
  const current = raw === null ? { version: 1 as const, title: "", highlights: [] } : readDocFile(raw);
  if (!current) return null;
  const next = { ...applyEdit(current, edit, now), title: title ?? current.title };
  if (next.highlights.length) await storage.write(path, serialize(next));
  else if (raw !== null) await storage.delete(path);
  return next;
}

/**
 * Runs each key's tasks one after another, so no edit reads a file another is about to write, and
 * forgets a key once its last task settles. A task's failure reaches its caller, not the next task.
 */
export class Serial {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail: Promise<void> = result.then(
      () => this.forget(key, tail),
      () => this.forget(key, tail),
    );
    this.tails.set(key, tail);
    return result;
  }

  private forget(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) this.tails.delete(key);
  }
}

/** Asks the tab to show one surface highlight's notes; written by the range menu, read once by the tab. */
export const FOCUS_PATH = "focus.json";
export const FOCUS_TTL_MS = 5 * 60_000;

export interface Focus {
  path: string;
  id: string;
  at: number;
}

export function parseFocus(raw: string | null, now: number): Focus | null {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { path, id, at } = v as Record<string, unknown>;
  if (typeof path !== "string" || !parseStoredPath(path) || typeof id !== "string" || typeof at !== "number") return null;
  return now - at >= 0 && now - at < FOCUS_TTL_MS ? { path, id, at } : null;
}
