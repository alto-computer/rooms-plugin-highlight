/*
 * Text-quote anchoring, ported from Hi-Lighter (buildIndex, globalOffset, nodeAt, findStart).
 * A highlight is stored as its text with 40 characters of context and a start offset into the
 * document's visible text; on load it is found again even when the document changed around it.
 */
import { CONTEXT, type Quote } from "../model";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);

export interface TextIndex {
  /** Every text node's data, concatenated in document order. */
  text: string;
  /** Each text node and where its data starts in `text`, ascending. */
  map: { node: Text; start: number }[];
}

export function buildIndex(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!n.nodeValue || !p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const map: TextIndex["map"] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    map.push({ node: n as Text, start: text.length });
    text += n.nodeValue;
  }
  return { text, map };
}

/** The offset in `index.text` of a range boundary point. */
export function offsetOf(index: TextIndex, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const seg = index.map.find((s) => s.node === node);
    if (seg) return seg.start + Math.min(offset, seg.node.data.length);
  }
  const at = (node.ownerDocument ?? (node as Document)).createRange();
  at.setStart(node, offset);
  // The first indexed text node at or after the point; the map is in document order.
  let lo = 0;
  let hi = index.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at.comparePoint(index.map[mid].node, 0) >= 0) hi = mid;
    else lo = mid + 1;
  }
  return lo < index.map.length ? index.map[lo].start : index.text.length;
}

/**
 * The text node and offset for `offset` in `index.text`. A start point takes the node holding the
 * character at `offset`; an end point takes the node holding the character before it.
 */
function pointAt(index: TextIndex, offset: number, side: "start" | "end"): { node: Text; offset: number } {
  const bias = side === "start" ? 1 : 0;
  let lo = 0;
  let hi = index.map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.map[mid].start < offset + bias) lo = mid;
    else hi = mid - 1;
  }
  const seg = index.map[lo];
  return { node: seg.node, offset: Math.min(offset - seg.start, seg.node.data.length) };
}

export function rangeAt(index: TextIndex, start: number, end: number): Range | null {
  if (!index.map.length || start < 0 || end <= start || end > index.text.length) return null;
  const a = pointAt(index, start, "start");
  const b = pointAt(index, end, "end");
  const r = a.node.ownerDocument.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** The quote for a selected range, or null when it holds no visible text. */
export function quoteOf(index: TextIndex, range: Range): Quote | null {
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  const text = index.text.slice(start, end);
  if (end <= start || !text.trim()) return null;
  return {
    text,
    prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: index.text.slice(end, end + CONTEXT),
    start,
  };
}

export type Anchor = { status: "exact" | "moved" | "fuzzy"; start: number; end: number } | { status: "orphan" };

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const commonSuffix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
};

/** Hi-Lighter's findStart: of every occurrence, the one whose context matches best, then the nearest. */
function findStart(text: string, q: Quote): number {
  let best = -1;
  let bestScore = -1;
  let bestDistance = Infinity;
  for (let i = text.indexOf(q.text); i !== -1; i = text.indexOf(q.text, i + 1)) {
    const pre = text.slice(Math.max(0, i - q.prefix.length), i);
    const suf = text.slice(i + q.text.length, i + q.text.length + q.suffix.length);
    const score = commonSuffix(pre, q.prefix) + commonPrefix(suf, q.suffix);
    const distance = q.start < 0 ? 0 : Math.abs(i - q.start);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = i;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return best;
}

const FUZZY_CONTEXT = 16;

/**
 * When the text itself changed a little: the span between the end of its prefix and the start of
 * its suffix, if that span is between half and one and a half times the old length.
 */
function findBetween(text: string, q: Quote): { start: number; end: number } | null {
  const pre = q.prefix.slice(-FUZZY_CONTEXT);
  const suf = q.suffix.slice(0, FUZZY_CONTEXT);
  if (!pre || !suf || pre.length + suf.length < FUZZY_CONTEXT) return null;
  const minGap = Math.max(1, Math.floor(q.text.length * 0.5));
  const maxGap = Math.ceil(q.text.length * 1.5) + 10;
  let best: { start: number; end: number; d: number } | null = null;
  for (let p = text.indexOf(pre); p !== -1; p = text.indexOf(pre, p + 1)) {
    const start = p + pre.length;
    const end = text.indexOf(suf, start + minGap);
    if (end === -1 || end - start > maxGap) continue;
    const d = q.start < 0 ? 0 : Math.abs(start - q.start);
    if (!best || d < best.d) best = { start, end, d };
  }
  return best && { start: best.start, end: best.end };
}

/** Where a stored quote is in the document's text now. */
export function locate(text: string, q: Quote): Anchor {
  const len = q.text.length;
  if (!len) return { status: "orphan" };
  if (q.start >= 0 && text.startsWith(q.text, q.start)) return { status: "exact", start: q.start, end: q.start + len };
  const i = findStart(text, q);
  if (i >= 0) return { status: "moved", start: i, end: i + len };
  const span = findBetween(text, q);
  return span ? { status: "fuzzy", ...span } : { status: "orphan" };
}
