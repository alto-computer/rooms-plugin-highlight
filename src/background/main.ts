/*
 * The hidden background page. It adds the four colors to the selection bar over chat answers and
 * notes, stores each surface's highlights, paints them whenever the surface is on screen, and
 * answers a click on one with a menu to recolor it, delete it, or find its notes in the Highlights
 * tab.
 */
import { connect, connectSurfaces, type SurfaceId, type SurfaceRange } from "@alto-rooms/plugin-sdk";
import { locate } from "../content/anchor";
import { moveLegacyAnswers } from "../legacy";
import { COLORS, CONTEXT, emptyDoc, isColor, newHighlight, newId, ORDER, parseIds, readDocFile, serialize, TEXT_MAX, type DocFile, type Edit } from "../model";
import { editSurface, FOCUS_PATH, orphansPathOf, PAINT_STYLES, Serial, surfaceFile, surfaceTitle, type Focus } from "../surfaces";

const DELETE = "delete";
const NOTES = "notes";
/** A rename closes the note under its old name and opens it under the new one at once, with the same text. */
const RENAME_MS = 2000;

interface Open {
  surface: SurfaceId;
  text: string;
  /** The app's number for `text`, which a paint computed on it names. */
  version: number;
  file: DocFile;
  /** The stored orphan ids as JSON, as last read or written; null until read, and nothing is written before. */
  orphans: string | null;
}

const rooms = await connect();
const surfaces = connectSurfaces();
/** Every surface on screen, by its file's path. */
const open = new Map<string, Open>();
const queues = new Serial();
/** The note that last left the screen on each date, while a rename could still bring it back under a new name. */
const closedNotes = new Map<string, { path: string; text: string; at: number }>();

const now = () => new Date().toISOString();

function queued(path: string, run: () => Promise<void>): Promise<void> {
  return queues.run(path, run).catch((e) => console.warn("[highlights] could not save", e));
}

/** Files from before 0.4.0 move before any surface reads its file. */
const moved = moveLegacyAnswers(rooms.storage, queues).catch((e) => console.warn("[highlights] could not move old answer highlights", e));

/** Paints the surface, and tells the tab which highlights' text the surface no longer has. */
function paint(path: string, entry: Open): void {
  const ranges: SurfaceRange[] = [];
  const orphans: string[] = [];
  for (const h of entry.file.highlights) {
    const at = locate(entry.text, h);
    if (at.status === "orphan") orphans.push(h.id);
    else ranges.push({ id: h.id, start: at.start, end: at.end, style: h.color });
  }
  surfaces.paint(entry.surface, ranges, PAINT_STYLES, entry.version);
  const next = JSON.stringify(orphans.sort());
  if (entry.orphans === null || next === entry.orphans) return;
  entry.orphans = next;
  const lost = orphansPathOf(path);
  void queued(lost, () => (orphans.length ? rooms.storage.write(lost, next) : rooms.storage.delete(lost)));
}

/**
 * The stored highlights of a note just renamed to `entry`: the files of the note that closed on
 * the same date a moment ago with the same text, moved to `path`, titled with the new name. Null
 * when no such note closed or it left no record.
 */
async function followRename(path: string, entry: Open): Promise<{ raw: string; orphans: string | null } | null> {
  if (entry.surface.kind !== "note") return null;
  const was = closedNotes.get(entry.surface.date);
  if (!was || was.path === path || was.text !== entry.text || Date.now() - was.at > RENAME_MS) return null;
  closedNotes.delete(entry.surface.date);
  const name = entry.surface.name;
  return queues.run(was.path, async () => {
    const [raw, orphans] = await Promise.all([rooms.storage.read(was.path), rooms.storage.read(orphansPathOf(was.path))]);
    const file = readDocFile(raw);
    if (!file) return null;
    const renamed = serialize({ ...file, title: name });
    await rooms.storage.write(path, renamed);
    if (orphans !== null) await rooms.storage.write(orphansPathOf(path), orphans);
    await rooms.storage.delete(was.path);
    if (orphans !== null) await rooms.storage.delete(orphansPathOf(was.path));
    return { raw: renamed, orphans };
  });
}

/** Reads the surface's file and paints it, unless the surface left the screen meanwhile. */
async function load(path: string): Promise<void> {
  await moved;
  return queued(path, async () => {
    let [raw, orphans] = await Promise.all([rooms.storage.read(path), rooms.storage.read(orphansPathOf(path))]);
    if (raw === null && open.has(path)) ({ raw, orphans } = (await followRename(path, open.get(path)!)) ?? { raw, orphans });
    const entry = open.get(path);
    if (!entry) return;
    entry.file = readDocFile(raw) ?? emptyDoc();
    entry.orphans = JSON.stringify(parseIds(orphans));
    paint(path, entry);
  });
}

function edit(surface: SurfaceId, change: Edit): Promise<void> {
  const path = surfaceFile(surface);
  return queued(path, async () => {
    const text = open.get(path)?.text ?? "";
    const file = await editSurface(rooms.storage, path, change, now(), surfaceTitle(surface, text));
    const entry = open.get(path);
    if (!file || !entry) return;
    entry.file = file;
    paint(path, entry);
  });
}

surfaces.onOpen((surface, text, version) => {
  const path = surfaceFile(surface);
  const entry = open.get(path);
  if (entry) {
    Object.assign(entry, { surface, text, version });
    paint(path, entry);
    return;
  }
  open.set(path, { surface, text, version, file: emptyDoc(), orphans: null });
  void load(path);
});

surfaces.onClose((surface) => {
  const path = surfaceFile(surface);
  const entry = open.get(path);
  open.delete(path);
  if (entry && surface.kind === "note" && entry.file.highlights.length) closedNotes.set(surface.date, { path, text: entry.text, at: Date.now() });
});

surfaces.onAction((actionId, { surface, start, end }) => {
  const entry = open.get(surfaceFile(surface));
  if (!entry || !isColor(actionId) || end <= start || end > entry.text.length) return;
  const text = entry.text.slice(start, end);
  if (!text.trim() || text.length > TEXT_MAX) return;
  const quote = { text, prefix: entry.text.slice(Math.max(0, start - CONTEXT), start), suffix: entry.text.slice(end, end + CONTEXT), start };
  void edit(surface, { kind: "add", highlight: newHighlight(quote, actionId, newId(), now()) });
});

surfaces.onRangeClick((surface, rangeId) => {
  const h = open.get(surfaceFile(surface))?.file.highlights.find((x) => x.id === rangeId);
  if (!h) return;
  const notes = h.annotations.length;
  surfaces.menu(surface, rangeId, [
    ...ORDER.map((c) => ({ id: c, title: COLORS[c].label, color: COLORS[c].solid })),
    { id: DELETE, title: "Delete" },
    { id: NOTES, title: notes ? `${notes} ${notes === 1 ? "note" : "notes"} in Highlights` : "Add a note in Highlights" },
  ]);
});

surfaces.onRangeAction((surface, rangeId, actionId) => {
  const path = surfaceFile(surface);
  if (isColor(actionId)) void edit(surface, { kind: "recolor", id: rangeId, color: actionId });
  else if (actionId === DELETE) void edit(surface, { kind: "remove", id: rangeId });
  else if (actionId === NOTES) {
    const focus: Focus = { path, id: rangeId, at: Date.now() };
    rooms.storage.write(FOCUS_PATH, JSON.stringify(focus)).catch((e) => console.warn("[highlights] could not save", e));
  }
});

// The tab edits notes in these files; the paint itself only changes with a recolor or a delete.
rooms.storage.onChange((path) => {
  if (open.has(path)) void load(path);
});

surfaces.setActions(ORDER.map((c) => ({ id: c, title: COLORS[c].label, color: COLORS[c].solid })));
surfaces.ready();
