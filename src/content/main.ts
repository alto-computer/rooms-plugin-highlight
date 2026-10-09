/*
 * The content script Rooms loads into every document a doc tab shows. It adds the four colors to
 * the app's selection bar, paints and stores highlights, opens the card when one is clicked, and
 * scrolls to a highlight the Highlights tab opened the document at. It runs from the top of
 * <head>, before the body exists.
 */
import { connectContent, type ContentSelection } from "@alto-rooms/plugin-sdk";
import { applyEdit, COLORS, DOC_PATH, emptyDoc, isColor, newHighlight, newNote, ORDER, ORPHANS_PATH, parseDocFile, parseIds, serialize, TEXT_MAX, type Color, type DocFile, type Edit } from "../model";
import { buildIndex, quoteOf, rangeAt } from "./anchor";
import { caretAt, hitTest } from "./hit";
import { adoptPaintStyles, createPainter, nativeHighlightApi } from "./paint";
import { restore, watchMutations } from "./restore";
import { createSaver } from "./save";
import { mountUi, type Ui } from "./ui";

const NOTE_ACTION = "note";
const FLASH_MS = 1200;

const rooms = connectContent("highlight");
const painter = createPainter(nativeHighlightApi());
let file: DocFile = emptyDoc();
/** Resolves once the stored record is read; nothing is written before, so a failed read never erases it. */
let loaded: Promise<boolean> = Promise.resolve(false);
/** Counts local edits, so a read that started before one is not taken over it. */
let edits = 0;
const saver = createSaver(() => rooms.storage.write(DOC_PATH, serialize(file)));
let ui: Ui | null = null;
/** "Highlight + note" uses the last color picked, for this page only: the script has no storage of its own. */
let lastColor: Color = "important";
/** orphans.json as last read or written, so it is written only when the set changes; null until read. */
let storedOrphans: string | null = null;
let started!: () => void;
const whenStarted = new Promise<void>((resolve) => (started = resolve));

const now = () => new Date().toISOString();
const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

function repaint(): void {
  adoptPaintStyles(document);
  if (!document.body) return;
  performance.mark("rooms-highlight:restore-start");
  const { orphans } = restore(document.body, file.highlights, painter);
  performance.measure("rooms-highlight:restore", "rooms-highlight:restore-start");
  reportOrphans(orphans);
  placeBadges();
  ui?.update(file.highlights);
}

function placeBadges(): void {
  ui?.setBadges(
    file.highlights.flatMap((h) => {
      const rects = h.annotations.length ? painter.get(h.id)?.range.getClientRects() : undefined;
      const rect = rects?.[rects.length - 1];
      return rect ? [{ id: h.id, count: h.annotations.length, rect }] : [];
    }),
  );
}

/** Tells the tab which highlights' text this document no longer has. */
function reportOrphans(ids: string[]): void {
  if (storedOrphans === null) return;
  const next = JSON.stringify([...ids].sort());
  if (next === storedOrphans) return;
  const before = storedOrphans;
  storedOrphans = next;
  rooms.storage.write(ORPHANS_PATH, next).catch(() => {
    if (storedOrphans === next) storedOrphans = before;
  });
}

async function load(): Promise<boolean> {
  const at = edits;
  await saver.settled();
  let read: DocFile;
  const orphans = rooms.storage.read(ORPHANS_PATH).catch(() => undefined);
  try {
    read = parseDocFile(await rooms.storage.read(DOC_PATH));
  } catch (e) {
    console.warn("[highlights] could not read the highlights of this document", e);
    return false;
  }
  const orphansRaw = await orphans;
  if (orphansRaw !== undefined) storedOrphans = JSON.stringify(parseIds(orphansRaw));
  if (at !== edits) return true;
  file = read;
  repaint();
  return true;
}

/** Waits for the record, reading it again if the first read failed. */
async function ensureLoaded(): Promise<boolean> {
  if (await loaded) return true;
  loaded = load();
  return loaded;
}

function apply(edit: Edit): void {
  edits++;
  file = { ...applyEdit(file, edit, now()), title: document.title };
  repaint();
  saver.changed();
}

async function highlight(actionId: string, selection: ContentSelection | null): Promise<void> {
  const withNote = actionId === NOTE_ACTION;
  if (!selection || (!withNote && !isColor(actionId)) || !document.body || !(await ensureLoaded())) return;
  const color = withNote ? lastColor : (actionId as Color);
  lastColor = color;
  const index = buildIndex(document.body);
  const quote = quoteOf(index, selection.range);
  if (!quote || quote.text.length > TEXT_MAX) return;
  const range = rangeAt(index, quote.start, quote.start + quote.text.length);
  if (!range) return;
  const h = newHighlight(quote, color, newId(), now());
  painter.paint(h.id, color, range);
  apply({ kind: "add", highlight: h });
  document.getSelection()?.removeAllRanges();
  if (withNote) ui?.openCard(h, range.getBoundingClientRect(), true);
}

const highlightIdOf = (anchor: unknown): string | null =>
  anchor && typeof anchor === "object" && typeof (anchor as { highlightId?: unknown }).highlightId === "string" ? (anchor as { highlightId: string }).highlightId : null;

/** Scrolls the highlight the tab asked for into view and flashes it. Its text may be gone. */
async function reveal(anchor: unknown): Promise<void> {
  const id = highlightIdOf(anchor);
  if (!id) return;
  await whenStarted;
  if (!(await ensureLoaded())) return;
  if (!painter.alive(id)) repaint();
  const painted = painter.get(id);
  if (!painted) return;
  const { range } = painted;
  const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  // The element brings any scrolling container around it along; a paragraph taller than the
  // window can still leave the range out of view, so the window centers the range itself.
  el?.scrollIntoView({ block: "center" });
  const r = range.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) scrollBy({ top: r.top + r.height / 2 - innerHeight / 2 });
  painter.flash(range, FLASH_MS);
}

function onClick(e: MouseEvent): void {
  if (!ui || ui.owns(e)) return;
  if (!document.getSelection()?.isCollapsed) return;
  const caret = caretAt(document, e.clientX, e.clientY);
  const id = caret && hitTest(painter.entries(), caret, e.clientX, e.clientY);
  const h = id ? file.highlights.find((x) => x.id === id) : undefined;
  if (h) ui.openCard(h, painter.get(h.id)!.range.getBoundingClientRect());
  else ui.closeCard();
}

function start(): void {
  adoptPaintStyles(document);
  ui = mountUi(document, {
    recolor: (id, color) => apply({ kind: "recolor", id, color }),
    remove: (id) => apply({ kind: "remove", id }),
    addNote: (id, body) => apply({ kind: "addNote", id, note: newNote(body, newId(), now()) }),
    editNote: (id, noteId, body) => apply({ kind: "editNote", id, noteId, body }),
    removeNote: (id, noteId) => apply({ kind: "removeNote", id, noteId }),
  });
  // Capture, so the card opens even when the document stops the click; its own handlers still run.
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", (e) => e.key === "Escape" && ui?.closeCard(), true);
  let frame = 0;
  const onLayout = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(placeBadges);
  };
  window.addEventListener("resize", onLayout);
  window.addEventListener("scroll", onLayout, { capture: true, passive: true });
  watchMutations(document.body, repaint);
  loaded = load();
  started();
}

rooms.setActions([...ORDER.map((c) => ({ id: c, title: COLORS[c].label, color: COLORS[c].solid })), { id: NOTE_ACTION, title: "Highlight + note" }]);
rooms.onAction((id, selection) => void highlight(id, selection));
rooms.onDataChanged((path) => {
  if (path === DOC_PATH) loaded = load();
});
rooms.onReveal((anchor) => void reveal(anchor));
rooms.ready();

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
