/*
 * Paints with the CSS Custom Highlight API: one registered Highlight per color, filled with live
 * Ranges. The document's DOM is never touched. Without the API (an old WebView) the painter still
 * tracks ranges, so hit testing and the record keep working; nothing shows.
 */
import { COLORS, ORDER, type Color } from "../model";

/** The parts of `CSS.highlights` and `Highlight` the painter uses. */
export interface HighlightApi {
  registry: { get(name: string): SetLike | undefined; set(name: string, h: SetLike): unknown };
  /** A Highlight with a higher `priority` paints over one with a lower. */
  create(priority: number): SetLike;
}
interface SetLike {
  add(r: Range): unknown;
  delete(r: Range): unknown;
  has(r: Range): boolean;
}

export const highlightName = (c: Color) => `rooms-hl-${c}`;
/** Drawn over a highlight for a moment when the tab jumps to it. */
export const FLASH_NAME = "rooms-hl-flash";

export function nativeHighlightApi(): HighlightApi | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return null;
  return { registry: CSS.highlights, create: (priority) => Object.assign(new Highlight(), { priority }) };
}

export const PAINT_CSS = [
  ...ORDER.map(
    (c) => `::highlight(${highlightName(c)}){background-color:${COLORS[c].bg};text-decoration:underline 1.5px ${COLORS[c].line};text-underline-offset:3px;color:inherit}`,
  ),
  `::highlight(${FLASH_NAME}){background-color:rgba(44,40,34,.16);text-decoration:underline 2px rgba(44,40,34,.7);text-underline-offset:3px}`,
].join("\n");

export interface Painted {
  range: Range;
  color: Color;
  /** The range's text when painted: a change means the document changed under it. */
  text: string;
}

export interface Painter {
  paint(id: string, color: Color, range: Range): void;
  unpaint(id: string): void;
  get(id: string): Painted | undefined;
  /** Painted and still showing the same text in the document. */
  alive(id: string): boolean;
  entries(): IterableIterator<[string, Painted]>;
  /** Draws the flash over `range` for `ms`, above every color. */
  flash(range: Range, ms: number): void;
}

export function createPainter(api: HighlightApi | null): Painter {
  const painted = new Map<string, Painted>();
  const layer = (c: Color): SetLike | undefined => {
    if (!api) return undefined;
    let h = api.registry.get(highlightName(c));
    if (!h) {
      h = api.create(ORDER.indexOf(c));
      api.registry.set(highlightName(c), h);
    }
    return h;
  };
  // Where two colors overlap, the later one in ORDER shows, whichever was used first.
  ORDER.forEach(layer);
  const unpaint = (id: string) => {
    const p = painted.get(id);
    if (!p) return;
    layer(p.color)?.delete(p.range);
    painted.delete(id);
  };
  return {
    paint(id, color, range) {
      unpaint(id);
      painted.set(id, { range, color, text: range.toString() });
      layer(color)?.add(range);
    },
    unpaint,
    get: (id) => painted.get(id),
    alive(id) {
      const p = painted.get(id);
      if (!p) return false;
      const { range } = p;
      // The artifact can replace a registry entry or clear CSS.highlights itself.
      const shown = !api || !!api.registry.get(highlightName(p.color))?.has(range);
      return shown && !range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected && range.toString() === p.text;
    },
    entries: () => painted.entries(),
    flash(range, ms) {
      if (!api) return;
      let h = api.registry.get(FLASH_NAME);
      if (!h) {
        h = api.create(ORDER.length);
        api.registry.set(FLASH_NAME, h);
      }
      const shown = h;
      shown.add(range);
      setTimeout(() => shown.delete(range), ms);
    },
  };
}

let sheet: CSSStyleSheet | undefined;

/**
 * Adds the four `::highlight()` rules as a constructed sheet, so no <style> element enters the
 * document, unless it is already there: a document that reassigns adoptedStyleSheets drops it.
 * Engines without constructed sheets predate the Highlight API too, so they need no rules.
 */
export function adoptPaintStyles(doc: Document): void {
  if (!Array.isArray(doc.adoptedStyleSheets)) return;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(PAINT_CSS);
  }
  if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}
