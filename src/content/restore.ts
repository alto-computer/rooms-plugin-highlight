/*
 * Keeps the paint in step with the record and the document: on load, when the record changes, and
 * when the document re-renders the text under a highlight after load.
 */
import type { Highlight } from "../model";
import { buildIndex, locate, rangeAt, type TextIndex } from "./anchor";
import type { Painter } from "./paint";

export interface RestoreResult {
  painted: string[];
  kept: string[];
  orphans: string[];
}

/**
 * Paints every highlight of `highlights` that is not already painted over the same text, and
 * unpaints the rest. The text index is built only when something needs anchoring.
 */
export function restore(root: Node, highlights: readonly Highlight[], painter: Painter): RestoreResult {
  const result: RestoreResult = { painted: [], kept: [], orphans: [] };
  const wanted = new Set(highlights.map((h) => h.id));
  for (const [id] of [...painter.entries()]) if (!wanted.has(id)) painter.unpaint(id);
  let index: TextIndex | null = null;
  for (const h of highlights) {
    const current = painter.get(h.id);
    if (current && painter.alive(h.id)) {
      if (current.color !== h.color) painter.paint(h.id, h.color, current.range);
      result.kept.push(h.id);
      continue;
    }
    index ??= buildIndex(root);
    const at = locate(index.text, h);
    const range = at.status === "orphan" ? null : rangeAt(index, at.start, at.end);
    if (range) {
      painter.paint(h.id, h.color, range);
      result.painted.push(h.id);
    } else {
      painter.unpaint(h.id);
      result.orphans.push(h.id);
    }
  }
  return result;
}

export const RESTORE_DEBOUNCE_MS = 250;
/** A document that never stops changing (a ticking clock) still gets restored this often. */
export const RESTORE_MAX_WAIT_MS = 1000;

/**
 * Calls `run` once the document has stopped changing for 250 ms, or 1 s after the first change
 * when it keeps changing. Returns a stop function.
 */
export function watchMutations(root: Node, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstChange = 0;
  const fire = () => {
    timer = undefined;
    firstChange = 0;
    run();
  };
  const observer = new MutationObserver(() => {
    const now = Date.now();
    firstChange ||= now;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.min(RESTORE_DEBOUNCE_MS, firstChange + RESTORE_MAX_WAIT_MS - now));
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
}
