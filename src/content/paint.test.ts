import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORDER, type Color } from "../model";
import { createPainter, FLASH_NAME, highlightName, PAINT_CSS, type HighlightApi } from "./paint";

/** CSS.highlights as a Map; each Highlight a Set of ranges carrying its priority. */
function fakeApi() {
  const registry = new Map<string, Set<Range> & { priority: number }>();
  const api: HighlightApi = { registry, create: (priority) => Object.assign(new Set<Range>(), { priority }) };
  return { api, registry };
}

/** Which color shows where all four overlap: the highest priority, then the latest registered. */
function topColor(registry: ReturnType<typeof fakeApi>["registry"]): Color {
  const layers = ORDER.map((c) => ({ c, priority: registry.get(highlightName(c))!.priority, order: [...registry.keys()].indexOf(highlightName(c)) }));
  layers.sort((a, b) => a.priority - b.priority || a.order - b.order);
  return layers[layers.length - 1].c;
}

describe("the painter", () => {
  let range: Range;
  beforeEach(() => {
    document.body.innerHTML = "<p>overlap</p>";
    range = document.createRange();
    range.selectNodeContents(document.body.firstChild!);
  });

  it("registers the four colors in ORDER before anything paints", () => {
    const { api, registry } = fakeApi();
    createPainter(api);
    expect([...registry.keys()]).toEqual(ORDER.map(highlightName));
  });

  it("shows the same color on an overlap whatever order the colors were used or re-registered in", () => {
    const tops = (["important", "idk"] as const).map((first) => {
      const { api, registry } = fakeApi();
      const painter = createPainter(api);
      registry.clear();
      const rest = ORDER.filter((c) => c !== first);
      [first, ...rest].forEach((c, i) => painter.paint(String(i), c, range.cloneRange()));
      return topColor(registry);
    });
    expect(tops).toEqual(["idk", "idk"]);
  });

  it("flashes a range above every color for a moment", () => {
    vi.useFakeTimers();
    try {
      const { api, registry } = fakeApi();
      const painter = createPainter(api);
      painter.paint("a", "idk", range);
      painter.flash(range, 1200);
      const flash = registry.get(FLASH_NAME)!;
      expect(flash.has(range)).toBe(true);
      expect(flash.priority).toBeGreaterThan(Math.max(...ORDER.map((c) => registry.get(highlightName(c))!.priority)));
      expect(PAINT_CSS).toContain(`::highlight(${FLASH_NAME})`);
      vi.advanceTimersByTime(1199);
      expect(flash.has(range)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(flash.has(range)).toBe(false);
      expect(registry.get(highlightName("idk"))!.has(range), "the paint stays").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
