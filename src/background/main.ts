/*
 * The hidden background page. It adds the four colors to the selection bar over chat answers,
 * stores each answer's highlights, paints them whenever the answer is on screen, and answers a
 * click on one with a menu to recolor it, delete it, or find its notes in the Highlights tab.
 */
import { connect, connectSurfaces, type SurfaceId, type SurfaceRange } from "@alto-rooms/plugin-sdk";
import { answerOrphansPath, answerPath, answerTitle, editAnswer, FOCUS_PATH, PAINT_STYLES, Serial, type Focus } from "../answers";
import { locate } from "../content/anchor";
import { COLORS, CONTEXT, emptyDoc, isColor, newHighlight, newId, ORDER, parseIds, readDocFile, TEXT_MAX, type DocFile, type Edit } from "../model";

const DELETE = "delete";
const NOTES = "notes";

interface Open {
  surface: SurfaceId;
  text: string;
  file: DocFile;
  /** The stored orphan ids as JSON, as last read or written; null until read, and nothing is written before. */
  orphans: string | null;
}

const rooms = await connect();
const surfaces = connectSurfaces();
/** Every answer on screen, by its file's path. */
const open = new Map<string, Open>();
const queues = new Serial();

const now = () => new Date().toISOString();

function queued(path: string, run: () => Promise<void>): Promise<void> {
  return queues.run(path, run).catch((e) => console.warn("[highlights] could not save", e));
}

/** Paints the answer, and tells the tab which highlights' text the answer no longer has. */
function paint(path: string, entry: Open): void {
  const ranges: SurfaceRange[] = [];
  const orphans: string[] = [];
  for (const h of entry.file.highlights) {
    const at = locate(entry.text, h);
    if (at.status === "orphan") orphans.push(h.id);
    else ranges.push({ id: h.id, start: at.start, end: at.end, style: h.color });
  }
  surfaces.paint(entry.surface, ranges, PAINT_STYLES);
  const next = JSON.stringify(orphans.sort());
  if (entry.orphans === null || next === entry.orphans) return;
  entry.orphans = next;
  const lost = answerOrphansPath(path);
  void queued(lost, () => (orphans.length ? rooms.storage.write(lost, next) : rooms.storage.delete(lost)));
}

/** Reads the answer's file and paints it, unless the answer left the screen meanwhile. */
function load(path: string): Promise<void> {
  return queued(path, async () => {
    const [raw, orphans] = await Promise.all([rooms.storage.read(path), rooms.storage.read(answerOrphansPath(path))]);
    const entry = open.get(path);
    if (!entry) return;
    entry.file = readDocFile(raw) ?? emptyDoc();
    entry.orphans = JSON.stringify(parseIds(orphans));
    paint(path, entry);
  });
}

function edit(surface: SurfaceId, change: Edit): Promise<void> {
  const path = answerPath(surface);
  return queued(path, async () => {
    const text = open.get(path)?.text ?? "";
    const file = await editAnswer(rooms.storage, path, change, now(), answerTitle(text));
    const entry = open.get(path);
    if (!file || !entry) return;
    entry.file = file;
    paint(path, entry);
  });
}

surfaces.onOpen((surface, text) => {
  const path = answerPath(surface);
  const entry = open.get(path);
  if (entry) {
    entry.text = text;
    paint(path, entry);
    return;
  }
  open.set(path, { surface, text, file: emptyDoc(), orphans: null });
  void load(path);
});

surfaces.onClose((surface) => void open.delete(answerPath(surface)));

surfaces.onAction((actionId, { surface, start, end }) => {
  const entry = open.get(answerPath(surface));
  if (!entry || !isColor(actionId) || end <= start || end > entry.text.length) return;
  const text = entry.text.slice(start, end);
  if (!text.trim() || text.length > TEXT_MAX) return;
  const quote = { text, prefix: entry.text.slice(Math.max(0, start - CONTEXT), start), suffix: entry.text.slice(end, end + CONTEXT), start };
  void edit(surface, { kind: "add", highlight: newHighlight(quote, actionId, newId(), now()) });
});

surfaces.onRangeClick((surface, rangeId) => {
  const h = open.get(answerPath(surface))?.file.highlights.find((x) => x.id === rangeId);
  if (!h) return;
  const notes = h.annotations.length;
  surfaces.menu(surface, rangeId, [
    ...ORDER.map((c) => ({ id: c, title: COLORS[c].label, color: COLORS[c].solid })),
    { id: DELETE, title: "Delete" },
    { id: NOTES, title: notes ? `${notes} ${notes === 1 ? "note" : "notes"} in Highlights` : "Add a note in Highlights" },
  ]);
});

surfaces.onRangeAction((surface, rangeId, actionId) => {
  const path = answerPath(surface);
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
