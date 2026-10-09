/*
 * The content script Rooms loads into every document a doc tab shows. It adds the four colors to
 * the app's selection bar, paints and stores highlights, and opens the card when one is clicked.
 * It runs from the top of <head>, before the body exists.
 */
import { connectContent, type ContentSelection } from "@alto-rooms/plugin-sdk";
import { applyEdit, COLORS, DOC_PATH, emptyDoc, isColor, newHighlight, newNote, ORDER, parseDocFile, serialize, TEXT_MAX, type Color, type DocFile, type Edit } from "../model";
import { buildIndex, quoteOf, rangeAt } from "./anchor";
import { caretAt, hitTest } from "./hit";
import { adoptPaintStyles, createPainter, nativeHighlightApi } from "./paint";
import { restore, watchMutations } from "./restore";
import { mountUi, type Ui } from "./ui";

const NOTE_ACTION = "note";

const rooms = connectContent("highlight");
const painter = createPainter(nativeHighlightApi());
let file: DocFile = emptyDoc();
/** Resolves once the stored record is read; nothing is written before, so a failed read never erases it. */
let loaded: Promise<boolean> = Promise.resolve(false);
let writes: Promise<void> = Promise.resolve();
let ui: Ui | null = null;
/** "Highlight + note" uses the last color picked, for this page only: the script has no storage of its own. */
let lastColor: Color = "important";

const now = () => new Date().toISOString();
const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

function repaint(): void {
  if (!document.body) return;
  performance.mark("rooms-highlight:restore-start");
  restore(document.body, file.highlights, painter);
  performance.measure("rooms-highlight:restore", "rooms-highlight:restore-start");
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

async function load(): Promise<boolean> {
  try {
    file = parseDocFile(await rooms.storage.read(DOC_PATH));
  } catch (e) {
    console.warn("[highlights] could not read the highlights of this document", e);
    return false;
  }
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
  file = { ...applyEdit(file, edit, now()), title: document.title };
  repaint();
  const text = serialize(file);
  writes = writes.then(() => rooms.storage.write(DOC_PATH, text)).catch((e) => console.warn("[highlights] could not save", e));
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
}

rooms.setActions([...ORDER.map((c) => ({ id: c, title: COLORS[c].label, color: COLORS[c].solid })), { id: NOTE_ACTION, title: "Highlight + note" }]);
rooms.onAction((id, selection) => void highlight(id, selection));
rooms.onDataChanged((path) => {
  if (path === DOC_PATH) loaded = load();
});
rooms.ready();

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
