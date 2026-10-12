/*
 * Answer files saved before plugin 0.4.0. SDK 0.5 named two answer scopes `doc` and
 * `conversation`; 0.6 names them `artifact` and `session`, and `surfacePath` follows, so a file
 * at `answer/doc/<fileKey>/<turnId>.json` now belongs at `answer/artifact/<fileKey>/<turnId>.json`
 * and `answer/conversation/<agent>/<id>/…` at `answer/session/<agent>/<id>/…`. The ids in the path
 * did not change. The background page moves every such file once on start.
 */
import type { RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { readDocFile, serialize } from "./model";
import type { Serial } from "./surfaces";

const RENAMED: Record<string, string> = { doc: "artifact", conversation: "session" };
const OLD = /^answer\/(doc|conversation)\/(.+)$/;

/** Where a pre-0.4.0 answer file belongs now, or null for any other path. */
export function movedPath(path: string): string | null {
  const m = OLD.exec(path);
  return m ? `answer/${RENAMED[m[1]]}/${m[2]}` : null;
}

/**
 * Moves every pre-0.4.0 answer file to its current path, each under its new path's queue. When the
 * new path already has a highlights file, the old one's highlights it lacks are added to it; when
 * either of the two is not a record, both stay as they are. Any other file defers to one already
 * at the new path. The old file goes only once the new one is written, so a run that stopped part
 * way is finished by the next. Returns how many files it found to move.
 */
export async function moveLegacyAnswers(storage: RoomsPlugin["storage"], queues: Serial): Promise<number> {
  const moves = (await storage.list("answer/")).flatMap((from) => {
    const to = movedPath(from);
    return to ? [{ from, to }] : [];
  });
  await Promise.all(
    moves.map(({ from, to }) =>
      queues.run(to, async () => {
        const [old, now] = await Promise.all([storage.read(from), storage.read(to)]);
        if (old === null) return;
        if (now === null) await storage.write(to, old);
        else if (to.endsWith(".json")) {
          const merged = merge(old, now);
          if (merged === null) return;
          if (merged !== now) await storage.write(to, merged);
        }
        await storage.delete(from);
      }),
    ),
  );
  return moves.length;
}

/** `now` with every highlight of `old` it lacks, or null when either is not a record. */
function merge(old: string, now: string): string | null {
  const a = readDocFile(old);
  const b = readDocFile(now);
  if (!a || !b) return null;
  const have = new Set(b.highlights.map((h) => h.id));
  const missing = a.highlights.filter((h) => !have.has(h.id));
  return missing.length ? serialize({ ...b, title: b.title || a.title, highlights: [...b.highlights, ...missing] }) : now;
}
