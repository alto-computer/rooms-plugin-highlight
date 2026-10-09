import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newHighlight, type Highlight } from "../model";
import { buildIndex, quoteOf } from "./anchor";
import { createPainter, highlightName, type HighlightApi, type Painter } from "./paint";
import { restore, watchMutations } from "./restore";

const T0 = "2026-10-09T00:00:00.000Z";

/** A stand-in for CSS.highlights: the registry is a Map, each Highlight a Set of ranges. */
function fakeApi() {
  const registry = new Map<string, Set<Range>>();
  const api: HighlightApi = { registry, create: () => new Set<Range>() };
  return { api, registry, painted: (color: string) => [...(registry.get(highlightName(color as never)) ?? [])].map((r) => r.toString()) };
}

function highlightOf(text: string, color: Highlight["color"], id: string): Highlight {
  const r = document.createRange();
  const node = [...document.body.querySelectorAll("p")].map((p) => p.firstChild as Text).find((t) => t.data.includes(text))!;
  r.setStart(node, node.data.indexOf(text));
  r.setEnd(node, node.data.indexOf(text) + text.length);
  return newHighlight(quoteOf(buildIndex(document.body), r)!, color, id, T0);
}

describe("restore", () => {
  let fake: ReturnType<typeof fakeApi>;
  let painter: Painter;
  beforeEach(() => {
    document.body.innerHTML = "<p id='a'>The quick brown fox jumps over the lazy dog.</p><p id='b'>Second paragraph with more words in it.</p>";
    fake = fakeApi();
    painter = createPainter(fake.api);
  });

  it("paints every highlight in its color without changing the document", () => {
    const before = document.body.innerHTML;
    const hs = [highlightOf("quick brown", "important", "h1"), highlightOf("lazy dog", "agree", "h2"), highlightOf("more words", "important", "h3")];
    expect(restore(document.body, hs, painter)).toEqual({ painted: ["h1", "h2", "h3"], kept: [], orphans: [] });
    expect(fake.painted("important")).toEqual(["quick brown", "more words"]);
    expect(fake.painted("agree")).toEqual(["lazy dog"]);
    expect(document.body.innerHTML).toBe(before);
  });

  it("keeps live paint, repaints a recolor, and unpaints a removed highlight", () => {
    const h1 = highlightOf("quick brown", "important", "h1");
    const h2 = highlightOf("lazy dog", "agree", "h2");
    restore(document.body, [h1, h2], painter);
    expect(restore(document.body, [{ ...h1, color: "idk" }], painter)).toEqual({ painted: [], kept: ["h1"], orphans: [] });
    expect(fake.painted("important")).toEqual([]);
    expect(fake.painted("idk")).toEqual(["quick brown"]);
    expect(fake.painted("agree"), "h2 left the record").toEqual([]);
  });

  it("leaves an orphan unpainted and reports it", () => {
    const h1 = highlightOf("quick brown", "important", "h1");
    document.body.innerHTML = "<p>Entirely different text.</p>";
    expect(restore(document.body, [h1], painter).orphans).toEqual(["h1"]);
    expect(fake.painted("important")).toEqual([]);
  });

  it("repaints when the document clears CSS.highlights behind its back", () => {
    const h1 = highlightOf("quick brown", "important", "h1");
    restore(document.body, [h1], painter);
    fake.registry.clear();
    expect(restore(document.body, [h1], painter).painted).toEqual(["h1"]);
    expect(fake.painted("important")).toEqual(["quick brown"]);
  });

  describe("after a late re-render", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("paints a highlight again 250 ms after its paragraph is re-rendered at 4 s", async () => {
      const h1 = highlightOf("quick brown", "important", "h1");
      const run = vi.fn(() => restore(document.body, [h1], painter));
      run();
      const stop = watchMutations(document.body, run);
      await vi.advanceTimersByTimeAsync(4000);
      document.getElementById("a")!.replaceWith(Object.assign(document.createElement("p"), { textContent: "The quick brown fox jumps over the lazy dog." }));
      await vi.advanceTimersByTimeAsync(0);
      expect(painter.alive("h1"), "the old range lost its text").toBe(false);
      await vi.advanceTimersByTimeAsync(249);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      expect(painter.alive("h1")).toBe(true);
      expect(fake.painted("important")).toEqual(["quick brown"]);
      stop();
    });

    it("still restores within 1 s while the document keeps changing", async () => {
      const run = vi.fn();
      const clock = document.createElement("span");
      document.body.append(clock);
      const stop = watchMutations(document.body, run);
      for (let t = 0; t < 1200; t += 100) {
        clock.textContent = String(t);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(run).toHaveBeenCalledTimes(1);
      stop();
    });
  });
});
