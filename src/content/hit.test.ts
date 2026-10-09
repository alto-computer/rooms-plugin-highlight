import { beforeEach, describe, expect, it, vi } from "vitest";
import { hitTest } from "./hit";
import type { Painted } from "./paint";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom }) as DOMRect;

function painted(text: Text, start: number, end: number, rects: DOMRect[]): Painted {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  range.getClientRects = vi.fn(() => rects as unknown as DOMRectList);
  return { range, color: "important", text: range.toString() };
}

describe("hitTest", () => {
  let text: Text;
  beforeEach(() => {
    document.body.innerHTML = "<p>The quick brown fox jumps over the lazy dog.</p>";
    text = document.body.querySelector("p")!.firstChild as Text;
  });

  it("finds the highlight under the caret and the pointer", () => {
    const list: [string, Painted][] = [
      ["fox", painted(text, 16, 19, [rect(160, 0, 190, 20)])],
      ["dog", painted(text, 40, 43, [rect(400, 0, 430, 20)])],
    ];
    expect(hitTest(list, { node: text, offset: 17 }, 170, 10)).toBe("fox");
    expect(hitTest(list, { node: text, offset: 41 }, 410, 10)).toBe("dog");
  });

  it("misses when the caret is outside every highlight", () => {
    const list: [string, Painted][] = [["fox", painted(text, 16, 19, [rect(160, 0, 190, 20)])]];
    expect(hitTest(list, { node: text, offset: 5 }, 50, 10)).toBeNull();
  });

  it("misses a click beside the highlight's line even when the caret snaps into it", () => {
    const list: [string, Painted][] = [["fox", painted(text, 16, 19, [rect(160, 0, 190, 20)])]];
    expect(hitTest(list, { node: text, offset: 19 }, 600, 10)).toBeNull();
  });

  it("prefers the shorter of two overlapping highlights", () => {
    const list: [string, Painted][] = [
      ["sentence", painted(text, 4, 30, [rect(40, 0, 300, 20)])],
      ["fox", painted(text, 16, 19, [rect(160, 0, 190, 20)])],
    ];
    expect(hitTest(list, { node: text, offset: 17 }, 170, 10)).toBe("fox");
  });
});
