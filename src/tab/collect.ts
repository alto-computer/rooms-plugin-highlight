/*
 * Gathers every highlight for the tab: the files the content script keeps under
 * `docs/<fileKey>/`, joined by fileKey with the documents the user's rooms link, and the files the
 * background page keeps under `answer/`, grouped by the thread they belong to. A document's chat
 * answers join the document's own highlights. Each document can write its own files, so
 * everything read here is untrusted and goes through the model's parsers.
 */
import type { AnswerScope, RoomsPlugin, SurfaceId } from "@alto-rooms/plugin-sdk";
import { answerOrphansPath, ANSWERS, surfaceOf } from "../answers";
import { DOC_PATH, ORPHANS_PATH, parseIds, readDocFile, type DocFile, type Highlight } from "../model";

/** Where a highlight lives: in a document's text, or in one chat answer. */
export type Place = { kind: "doc"; fileKey: string } | { kind: "answer"; surface: SurfaceId; path: string };

export interface Found {
  h: Highlight;
  place: Place;
}

export interface Group {
  /** `doc:<fileKey>`, `room:<roomId>`, `day:<date>` or `conversation:<agent>/<session>`. */
  key: string;
  title: string;
  /** A document's rooms, or the kind of thread; says when the document or room is gone. */
  where: string;
  /** What the title opens; null for a thread no room or document holds. */
  target: { fileKey: string } | { roomId: string } | null;
  /** The document or room is gone, so nothing in it can be opened. */
  removed: boolean;
  /** Newest first. */
  found: Found[];
  /** Row keys of highlights whose text the document or answer no longer has, as its script last saw. */
  orphans: ReadonlySet<string>;
}

export interface Collection {
  /** Newest highlight first. */
  groups: Group[];
  /** Highlight files that are not a record at all. */
  skipped: number;
}

export type CollectContext = Pick<RoomsPlugin, "storage" | "rooms" | "artifacts">;

/** A row's key, unique across the tab: the same highlight id can be in a document and an answer. */
export const rowKey = ({ h, place }: Found): string => (place.kind === "doc" ? docRowKey(place.fileKey, h.id) : answerRowKey(place.path, h.id));
export const docRowKey = (fileKey: string, id: string): string => `doc:${fileKey}#${id}`;
export const answerRowKey = (path: string, id: string): string => `${path}#${id}`;

const FILE = /^docs\/([A-Za-z0-9._-]+)\/([^/]+)$/;

/** The document and file name of a path under `docs/`, or null for any other path. */
export function docFileOf(path: string): { fileKey: string; name: string } | null {
  const m = FILE.exec(path);
  return m ? { fileKey: m[1], name: m[2] } : null;
}

const newestFirst = (a: Found, b: Found) => (a.h.createdAt < b.h.createdAt ? 1 : a.h.createdAt > b.h.createdAt ? -1 : 0);

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
function dayTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  return Number.isNaN(t.getTime()) ? date : dayFormat.format(t);
}

interface Linked {
  docs: Map<string, { title: string; rooms: string[] }>;
  rooms: Map<string, string>;
}

async function linked(ctx: CollectContext): Promise<Linked> {
  const rooms = await ctx.rooms.list();
  const lists = await Promise.all(rooms.map(async (r) => ({ room: r.name, artifacts: await ctx.artifacts.list(r.id) })));
  const docs = new Map<string, { title: string; rooms: string[] }>();
  for (const { room, artifacts } of lists) {
    for (const a of artifacts) {
      const doc = docs.get(a.fileKey);
      if (!doc) docs.set(a.fileKey, { title: a.title, rooms: [room] });
      else if (!doc.rooms.includes(room)) doc.rooms.push(room);
    }
  }
  return { docs, rooms: new Map(rooms.map((r) => [r.id, r.name])) };
}

function scopeKey(scope: AnswerScope): string {
  switch (scope.kind) {
    case "doc":
      return `doc:${scope.fileKey}`;
    case "room":
      return `room:${scope.roomId}`;
    case "day":
      return `day:${scope.date}`;
    case "conversation":
      return `conversation:${scope.agent}/${scope.session}`;
  }
}

function newGroup(scope: AnswerScope, link: Linked, storedTitle = ""): Group {
  const base = { key: scopeKey(scope), found: [], orphans: new Set<string>() };
  switch (scope.kind) {
    case "doc": {
      const doc = link.docs.get(scope.fileKey);
      return { ...base, title: doc?.title || storedTitle || "Untitled", where: doc ? doc.rooms.join(" · ") : "Doc removed", target: { fileKey: scope.fileKey }, removed: !doc };
    }
    case "room": {
      const name = link.rooms.get(scope.roomId);
      return { ...base, title: name ?? "Removed room", where: name ? "Room chat" : "Room removed", target: { roomId: scope.roomId }, removed: !name };
    }
    case "day":
      return { ...base, title: dayTitle(scope.date), where: "Journal", target: null, removed: false };
    case "conversation":
      return { ...base, title: scope.agent, where: "Agent chat", target: null, removed: false };
  }
}

export async function collect(ctx: CollectContext): Promise<Collection> {
  const [docPaths, answerPaths, link] = await Promise.all([ctx.storage.list("docs/"), ctx.storage.list(ANSWERS), linked(ctx)]);
  const listed = new Set([...docPaths, ...answerPaths]);
  const docKeys = docPaths.flatMap((p) => {
    const f = docFileOf(p);
    return f?.name === DOC_PATH ? [f.fileKey] : [];
  });
  const [docs, answers] = await Promise.all([
    Promise.all(
      docKeys.map(async (fileKey) => {
        const orphansPath = `docs/${fileKey}/${ORPHANS_PATH}`;
        const [raw, orphans] = await Promise.all([ctx.storage.read(`docs/${fileKey}/${DOC_PATH}`), listed.has(orphansPath) ? ctx.storage.read(orphansPath) : null]);
        return { fileKey, raw, orphans };
      }),
    ),
    Promise.all(
      answerPaths
        .filter((p) => surfaceOf(p))
        .map(async (path) => {
          const orphansPath = answerOrphansPath(path);
          const [raw, orphans] = await Promise.all([ctx.storage.read(path), listed.has(orphansPath) ? ctx.storage.read(orphansPath) : null]);
          return { path, raw, orphans };
        }),
    ),
  ]);

  let skipped = 0;
  const groups = new Map<string, Group>();
  const parse = (raw: string | null): DocFile | null => {
    if (raw === null) return null;
    const file = readDocFile(raw);
    if (!file) skipped++;
    return file?.highlights.length ? file : null;
  };

  for (const { fileKey, raw, orphans } of docs) {
    const file = parse(raw);
    if (!file) continue;
    const group = newGroup({ kind: "doc", fileKey }, link, file.title);
    group.orphans = new Set(parseIds(orphans).map((id) => docRowKey(fileKey, id)));
    group.found = file.highlights.map((h) => ({ h, place: { kind: "doc", fileKey } }));
    groups.set(group.key, group);
  }
  for (const { path, raw, orphans } of answers) {
    const file = parse(raw);
    const surface = surfaceOf(path)!;
    if (!file) continue;
    const key = scopeKey(surface.scope);
    const group = groups.get(key) ?? newGroup(surface.scope, link);
    groups.set(key, group);
    const place: Place = { kind: "answer", surface, path };
    for (const h of file.highlights) group.found.push({ h, place });
    const lost = parseIds(orphans).map((id) => answerRowKey(path, id));
    if (lost.length) group.orphans = new Set([...group.orphans, ...lost]);
  }

  const sorted = [...groups.values()];
  for (const g of sorted) g.found.sort(newestFirst);
  sorted.sort((a, b) => newestFirst(a.found[0], b.found[0]));
  return { groups: sorted, skipped };
}
