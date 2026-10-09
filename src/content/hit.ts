/*
 * Which painted highlight a click landed on. Paint adds no element to click, so the caret position
 * under the pointer is tested against each painted range, then against the range's line boxes so a
 * click in the margin beside a highlight's last line does not count.
 */
import type { Painted } from "./paint";

export interface Caret {
  node: Node;
  offset: number;
}

export function caretAt(doc: Document, x: number, y: number): Caret | null {
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  // WebKit has only the older API.
  const r = (doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

const inside = (rects: Iterable<DOMRect>, x: number, y: number) => {
  for (const r of rects) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  return false;
};

/** The id of the shortest painted range under the point, so a highlight inside another wins. */
export function hitTest(painted: Iterable<[string, Painted]>, caret: Caret, x: number, y: number): string | null {
  let best: { id: string; length: number } | null = null;
  for (const [id, { range, text }] of painted) {
    let within = false;
    try {
      within = range.isPointInRange(caret.node, caret.offset);
    } catch {
      continue;
    }
    if (!within || !inside(range.getClientRects(), x, y)) continue;
    if (!best || text.length < best.length) best = { id, length: text.length };
  }
  return best?.id ?? null;
}
