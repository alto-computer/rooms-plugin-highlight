import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAction, ContentSelection } from "@alto-rooms/plugin-sdk";
import { RESTORE_DEBOUNCE_MS } from "./restore";
import { SAVE_DEBOUNCE_MS } from "./save";

/** The app side of connectContent: storage in a Map, and the callbacks the script registered. */
const app = vi.hoisted(() => ({
  files: new Map<string, string>(),
  read: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  write: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  actions: [] as ContentAction[],
  onAction: null as ((id: string, s: ContentSelection | null) => void) | null,
  onDataChanged: null as ((path: string) => void) | null,
  onReveal: null as ((anchor: unknown) => void) | null,
  ready: false,
}));

vi.mock("@alto-rooms/plugin-sdk", () => ({
  connectContent: (id: string) => {
    if (id !== "highlight") throw new Error(`unexpected plugin id ${id}`);
    return {
      pluginId: id,
      storage: { read: app.read, write: app.write, list: vi.fn(), delete: vi.fn() },
      setActions: (items: ContentAction[]) => (app.actions = items),
      onAction: (cb: typeof app.onAction) => ((app.onAction = cb), () => {}),
      onDataChanged: (cb: typeof app.onDataChanged) => ((app.onDataChanged = cb), () => {}),
      onReveal: (cb: typeof app.onReveal) => ((app.onReveal = cb), () => {}),
      ready: () => (app.ready = true),
    };
  },
}));

const FOX = "The quick brown fox jumps over the lazy dog.";
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Past the save debounce, so a pending write has run. */
const saved = () => new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 50));

function select(text: string): ContentSelection {
  const node = document.querySelector("p")!.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, node.data.indexOf(text));
  range.setEnd(node, node.data.indexOf(text) + text.length);
  return { text, range };
}

const stored = () => JSON.parse(app.files.get("highlights.json")!);

async function boot(existing?: string) {
  vi.resetModules();
  app.files.clear();
  if (existing !== undefined) app.files.set("highlights.json", existing);
  app.read = vi.fn(async (p: string) => app.files.get(p) ?? null);
  app.write = vi.fn(async (p: string, t: string) => void app.files.set(p, t));
  document.title = "Fox doc";
  // A fresh body, so the observers of scripts booted by earlier tests stop firing.
  document.body.replaceWith(document.createElement("body"));
  document.body.innerHTML = `<p>${FOX}</p>`;
  await import("./main");
  await flush();
}

describe("the content script", () => {
  beforeEach(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });

  it("puts the four colors, then Highlight + note, in the selection bar, and says it is ready", async () => {
    await boot();
    expect(app.actions).toEqual([
      { id: "important", title: "Important", color: "#b8893a" },
      { id: "agree", title: "Agree", color: "#6f8f6a" },
      { id: "disagree", title: "DisAgree", color: "#be7257" },
      { id: "idk", title: "IDK", color: "#8e84a0" },
      { id: "note", title: "Highlight + note" },
    ]);
    expect(app.ready).toBe(true);
    expect(app.read).toHaveBeenCalledWith("highlights.json");
  });

  it("stores a highlight in highlights.json when a color is clicked", async () => {
    await boot();
    app.onAction!("agree", select("quick brown fox"));
    await saved();
    expect(app.write).toHaveBeenCalledTimes(1);
    expect(app.write.mock.calls[0][0]).toBe("highlights.json");
    const file = stored();
    expect(file).toMatchObject({ version: 1, title: "Fox doc" });
    expect(file.highlights).toHaveLength(1);
    expect(file.highlights[0]).toMatchObject({ color: "agree", text: "quick brown fox", prefix: "The ", suffix: " jumps over the lazy dog.", start: 4, annotations: [] });
    expect(file.highlights[0].id).toMatch(/^[0-9a-f]{24}$/);
    expect(document.body.innerHTML, "the document is unchanged").toBe(`<p>${FOX}</p>`);
  });

  it("adds to the highlights already stored for the document", async () => {
    await boot(JSON.stringify({ version: 1, title: "Fox doc", highlights: [{ id: "old", color: "idk", text: "lazy dog", prefix: "", suffix: "", start: 35, annotations: [], createdAt: "2026-10-01T00:00:00.000Z" }] }));
    app.onAction!("important", select("quick"));
    await saved();
    expect(stored().highlights.map((h: { id: string; color: string }) => h.color)).toEqual(["idk", "important"]);
  });

  it("writes nothing when the stored record could not be read, so it is never erased", async () => {
    vi.resetModules();
    await boot("{}");
    app.read.mockRejectedValue(new Error("timeout"));
    app.onDataChanged!("highlights.json");
    await flush();
    app.onAction!("agree", select("quick"));
    await saved();
    expect(app.write).not.toHaveBeenCalled();
  });

  it("ignores an unknown action and an action without a selection", async () => {
    await boot();
    app.onAction!("yellow", select("quick"));
    app.onAction!("agree", null);
    await saved();
    expect(app.write).not.toHaveBeenCalled();
  });

  it("adds the paint rules back when the document replaces its adopted sheets", async () => {
    Object.defineProperty(document, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
    try {
      await boot();
      const painted = () => document.adoptedStyleSheets.filter((s) => [...s.cssRules].some((r) => r.cssText.includes("::highlight(rooms-hl-agree)"))).length;
      expect(painted()).toBe(1);
      document.adoptedStyleSheets = [];
      document.body.append(document.createElement("p"));
      await new Promise((r) => setTimeout(r, 300));
      expect(painted(), "re-added on the next repaint").toBe(1);
      app.onDataChanged!("highlights.json");
      await flush();
      expect(painted(), "never added twice").toBe(1);
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("keeps a local edit when a read that started before it lands after it", async () => {
    await boot();
    let finish!: (text: string | null) => void;
    app.read.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    app.onAction!("agree", select("quick"));
    app.onDataChanged!("highlights.json");
    await flush();
    finish(null);
    await saved();
    expect(stored().highlights.map((h: { text: string }) => h.text)).toEqual(["quick"]);
  });

  it("reads the record again only after a queued write lands, so the edit is not reverted", async () => {
    await boot();
    app.onAction!("agree", select("quick"));
    await flush();
    app.onDataChanged!("highlights.json");
    await saved();
    await flush();
    app.onAction!("idk", select("lazy dog"));
    await saved();
    expect(stored().highlights.map((h: { text: string }) => h.text)).toEqual(["quick", "lazy dog"]);
  });

  it("reads the record again when another frame changes it", async () => {
    await boot();
    app.read.mockClear();
    app.onDataChanged!("other.json");
    app.onDataChanged!("highlights.json");
    await flush();
    expect(app.read.mock.calls.map(([p]) => p).sort()).toEqual(["highlights.json", "orphans.json"]);
  });

  const T = "2026-10-01T00:00:00.000Z";
  const stored2 = (...hs: { id: string; text: string; start: number }[]) =>
    JSON.stringify({ version: 1, title: "Fox doc", highlights: hs.map((h) => ({ ...h, color: "idk", prefix: "", suffix: "", annotations: [], createdAt: T })) });

  it("scrolls to the highlight the tab opened the document at", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled(this.tagName);
    };
    await boot(stored2({ id: "dog", text: "lazy dog", start: 35 }));
    for (const forged of [null, "dog", { highlightId: 5 }, { highlightId: "nope" }]) app.onReveal!(forged);
    await flush();
    expect(scrolled).not.toHaveBeenCalled();
    app.onReveal!({ highlightId: "dog" });
    await flush();
    expect(scrolled.mock.calls).toEqual([["P"]]);
  });

  it("tells the tab which highlights' text is gone, and writes only when that changes", async () => {
    await boot(stored2({ id: "dog", text: "lazy dog", start: 35 }, { id: "gone", text: "a cat sleeps", start: 0 }));
    await saved();
    expect(app.files.get("orphans.json")).toBe('["gone"]');
    app.write.mockClear();
    app.onDataChanged!("highlights.json");
    await saved();
    expect(app.write).not.toHaveBeenCalled();

    await boot(stored2({ id: "dog", text: "lazy dog", start: 35 }));
    await saved();
    expect(app.files.has("orphans.json"), "nothing written while every highlight is found").toBe(false);
  });

  it("does not write lost text that comes back before the write", async () => {
    await boot(stored2({ id: "dog", text: "lazy dog", start: 35 }));
    await saved();
    const p = document.querySelector("p")!;
    p.textContent = "The page is re-rendering.";
    await new Promise((r) => setTimeout(r, RESTORE_DEBOUNCE_MS + 10));
    p.textContent = FOX;
    await new Promise((r) => setTimeout(r, RESTORE_DEBOUNCE_MS + SAVE_DEBOUNCE_MS + 50));
    expect(app.files.has("orphans.json"), "a re-render that briefly loses the text writes nothing").toBe(false);
  });
});
