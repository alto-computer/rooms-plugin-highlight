/*
 * Highlights in chat answers. The background page keeps each answer's highlights in one file at
 * `answer/<scope kind>/<scope id>/<turnId>.json`, in the same shape as a document's, and the tab
 * reads and edits the same files. Only frames of this plugin can write under `answer/`.
 */
import { surfacePath, type AnswerScope, type RoomsPlugin, type SurfaceId, type SurfaceStyles } from "@alto-rooms/plugin-sdk";
import { applyEdit, COLORS, ORDER, readDocFile, serialize, type DocFile, type Edit } from "./model";

export const ANSWERS = "answer/";
const TITLE_MAX = 80;

export const answerPath = (s: SurfaceId): string => `${surfacePath(s)}.json`;

const SCOPED = /^answer\/(doc|room|day)\/([^/]+)\/([^/]+)\.json$/;
const CONVERSATION = /^answer\/conversation\/([^/]+)\/([^/]+)\/([^/]+)\.json$/;

/** The answer a stored path names, or null for any other path. */
export function surfaceOf(path: string): SurfaceId | null {
  let surface: SurfaceId | null = null;
  const c = CONVERSATION.exec(path);
  const m = SCOPED.exec(path);
  if (c) surface = { kind: "answer", scope: { kind: "conversation", agent: c[1], session: c[2] }, turnId: c[3] };
  else if (m) {
    const scope: AnswerScope = m[1] === "doc" ? { kind: "doc", fileKey: m[2] } : m[1] === "room" ? { kind: "room", roomId: m[2] } : { kind: "day", date: m[2] };
    surface = { kind: "answer", scope, turnId: m[3] };
  }
  return surface && answerPath(surface) === path ? surface : null;
}

/** The stored title of an answer's file: the start of the answer, since a background page never sees the question. */
export const answerTitle = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/** The four document colors as answer paint, so an answer highlight reads like a document one. */
export const PAINT_STYLES: SurfaceStyles = Object.fromEntries(ORDER.map((c) => [c, COLORS[c].bg]));

export const CHAT_LABEL: Record<AnswerScope["kind"], string> = {
  doc: "Doc chat",
  room: "Room chat",
  day: "Day chat",
  conversation: "Agent chat",
};

/**
 * Reads the answer's file, applies `edit`, and writes it back, or deletes it once no highlight is
 * left. Returns the new record, or null when the stored file is not a record, which is left alone.
 */
export async function editAnswer(storage: RoomsPlugin["storage"], path: string, edit: Edit, now: string, title?: string): Promise<DocFile | null> {
  const raw = await storage.read(path);
  const current = raw === null ? { version: 1 as const, title: "", highlights: [] } : readDocFile(raw);
  if (!current) return null;
  const next = { ...applyEdit(current, edit, now), title: current.title || title || "" };
  if (next.highlights.length) await storage.write(path, serialize(next));
  else if (raw !== null) await storage.delete(path);
  return next;
}

/** Asks the tab to show one answer highlight's notes; written by the range menu, read once by the tab. */
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
  if (typeof path !== "string" || !surfaceOf(path) || typeof id !== "string" || typeof at !== "number") return null;
  return now - at >= 0 && now - at < FOCUS_TTL_MS ? { path, id, at } : null;
}
