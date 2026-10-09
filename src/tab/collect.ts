/*
 * Gathers every document's highlights for the tab: the files the content script keeps under
 * `docs/<fileKey>/`, joined by fileKey with the documents the user's rooms link. Each document
 * can write its own files, so everything read here is untrusted and goes through the model's
 * parsers.
 */
import type { RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { DOC_PATH, ORPHANS_PATH, parseIds, readDocFile, type Highlight } from "../model";

export interface DocHighlights {
  fileKey: string;
  title: string;
  /** Names of the rooms that link the document; empty when no room does any more. */
  rooms: string[];
  /** Newest first. */
  highlights: Highlight[];
  /** Ids of highlights whose text the document no longer has, as the content script last saw. */
  orphans: ReadonlySet<string>;
}

export interface Collection {
  /** Newest highlight first. */
  docs: DocHighlights[];
  /** Highlight files that are not a record at all. */
  skipped: number;
}

export type CollectContext = Pick<RoomsPlugin, "storage" | "rooms" | "artifacts">;

const FILE = /^docs\/([A-Za-z0-9._-]+)\/([^/]+)$/;

const newestFirst = (a: Highlight, b: Highlight) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

async function linkedDocs(ctx: CollectContext): Promise<Map<string, { title: string; rooms: string[] }>> {
  const rooms = await ctx.rooms.list();
  const lists = await Promise.all(rooms.map(async (r) => ({ room: r.name, artifacts: await ctx.artifacts.list(r.id) })));
  const byKey = new Map<string, { title: string; rooms: string[] }>();
  for (const { room, artifacts } of lists) {
    for (const a of artifacts) {
      const doc = byKey.get(a.fileKey);
      if (!doc) byKey.set(a.fileKey, { title: a.title, rooms: [room] });
      else if (!doc.rooms.includes(room)) doc.rooms.push(room);
    }
  }
  return byKey;
}

export async function collect(ctx: CollectContext): Promise<Collection> {
  const [paths, linked] = await Promise.all([ctx.storage.list("docs/"), linkedDocs(ctx)]);
  const listed = new Set(paths);
  const keys = paths.flatMap((p) => {
    const m = FILE.exec(p);
    return m && m[2] === DOC_PATH ? [m[1]] : [];
  });
  const read = await Promise.all(
    keys.map(async (fileKey) => {
      const orphansPath = `docs/${fileKey}/${ORPHANS_PATH}`;
      const [raw, orphans] = await Promise.all([ctx.storage.read(`docs/${fileKey}/${DOC_PATH}`), listed.has(orphansPath) ? ctx.storage.read(orphansPath) : null]);
      return { fileKey, raw, orphans };
    }),
  );
  let skipped = 0;
  const docs: DocHighlights[] = [];
  for (const { fileKey, raw, orphans } of read) {
    if (raw === null) continue;
    const file = readDocFile(raw);
    if (!file) {
      skipped++;
      continue;
    }
    if (!file.highlights.length) continue;
    const link = linked.get(fileKey);
    docs.push({
      fileKey,
      title: link?.title || file.title || "Untitled",
      rooms: link?.rooms ?? [],
      highlights: [...file.highlights].sort(newestFirst),
      orphans: new Set(parseIds(orphans)),
    });
  }
  docs.sort((a, b) => newestFirst(a.highlights[0], b.highlights[0]));
  return { docs, skipped };
}
