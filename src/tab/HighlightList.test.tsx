import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PluginError, type RoomsPlugin } from "@alto-rooms/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightList } from "./HighlightList";

// jsdom has no layout, and the windowed list renders nothing in a zero-height scroller.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const T = (d: number) => `2026-10-0${d}T10:00:00.000Z`;
const h = (id: string, color: string, text: string, day: number, notes: string[] = []) => ({
  id,
  color,
  text,
  prefix: "",
  suffix: "",
  start: -1,
  annotations: notes.map((body, i) => ({ id: `${id}-n${i}`, body, createdAt: T(day) })),
  createdAt: T(day),
});
const file = (title: string, highlights: unknown[]) => JSON.stringify({ version: 1, title, highlights });

const XSS = "<img src=x onerror=alert(1)>";

function fakeRooms(files: Record<string, string>) {
  let changed: ((path: string) => void) | null = null;
  const rooms = {
    pluginId: "highlight",
    onContext: () => () => {},
    onBeforeClose: () => () => {},
    storage: {
      read: vi.fn(async (p: string) => files[p] ?? null),
      write: vi.fn(),
      list: vi.fn(async (prefix = "") => Object.keys(files).filter((p) => p.startsWith(prefix)).sort()),
      delete: vi.fn(),
      onChange: (cb: (path: string) => void) => ((changed = cb), () => (changed = null)),
    },
    rooms: { list: async () => [{ id: "r1", name: "Bench" }] },
    artifacts: {
      list: async () => [
        { roomId: "r1", artifactId: "a1", fileKey: "k1", title: "Latency report", createdAt: T(1) },
        { roomId: "r1", artifactId: "a2", fileKey: "k2", title: XSS, createdAt: T(1) },
      ],
    },
    open: vi.fn(async () => {}),
  };
  return { rooms: rooms as unknown as RoomsPlugin, open: rooms.open, change: (p: string) => changed?.(p) };
}

const FILES = {
  "docs/k1/highlights.json": file("Latency report", [
    h("a", "important", "p95 is 118 ms under load", 1, ["check the cache"]),
    h("b", "disagree", "the cache never misses", 3, ["it does, at night"]),
  ]),
  "docs/k1/orphans.json": JSON.stringify(["a"]),
  "docs/k2/highlights.json": file("x", [h("c", "agree", XSS, 2, ["<script>alert(1)</script>"])]),
  "docs/gone/highlights.json": file("Old memo", [h("d", "idk", "a removed doc's line", 1)]),
};

const rows = () => screen.queryAllByText(/./, { selector: ".quote" }).map((e) => e.textContent);

async function mount(files: Record<string, string> = FILES) {
  const f = fakeRooms({ ...files });
  render(<HighlightList rooms={f.rooms} />);
  await screen.findByRole("heading", { name: "Highlights" });
  await screen.findAllByText(/./, { selector: ".quote" });
  return f;
}

describe("HighlightList", () => {
  it("groups every highlight by document, newest first, with its room, color, date, notes and lost text", async () => {
    await mount();
    expect(screen.getAllByRole("heading", { level: 2 }).map((e) => e.textContent)).toEqual(["Latency report", XSS, "Old memo"]);
    expect(rows()).toEqual(["the cache never misses", "p95 is 118 ms under load", XSS, "a removed doc's line"]);
    const report = within(screen.getByRole("region", { name: "Latency report" }));
    expect(report.getByText("Bench")).toBeTruthy();
    const first = report.getByText("p95 is 118 ms under load").closest(".hl")!;
    expect(first.textContent).toContain("check the cache");
    expect(first.textContent).toMatch(/Important · .*2026 · 1 note/);
    expect(first.textContent).toContain("Text not found");
    expect(report.getByText("the cache never misses").closest(".hl")!.textContent).not.toContain("Text not found");
    expect(within(screen.getByRole("region", { name: "Old memo" })).getByText("Doc removed")).toBeTruthy();
  });

  it("renders stored HTML as text", async () => {
    await mount();
    expect(document.querySelector("img, script")).toBeNull();
    expect(screen.getAllByText(XSS).length).toBe(2);
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  });

  it("filters by color and searches quotes and notes", async () => {
    await mount();
    const colors = within(screen.getByRole("group", { name: "Filter by color" }));
    fireEvent.click(colors.getByRole("button", { name: /DisAgree/ }));
    expect(rows()).toEqual(["the cache never misses"]);
    fireEvent.click(colors.getByRole("button", { name: /DisAgree/ }));
    expect(rows()).toHaveLength(4);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search highlights" }), { target: { value: "CACHE" } });
    await vi.waitFor(() => expect(rows()).toEqual(["the cache never misses", "p95 is 118 ms under load"]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "at night" } });
    await vi.waitFor(() => expect(rows()).toEqual(["the cache never misses"]));
    fireEvent.click(colors.getByRole("button", { name: /Important/ }));
    expect(rows()).toEqual([]);
    expect(screen.getByText("No highlights match.")).toBeTruthy();
  });

  it("opens the document at the highlight, and opens nothing for a removed document", async () => {
    const f = await mount();
    fireEvent.click(screen.getByText("p95 is 118 ms under load"));
    expect(f.open).toHaveBeenCalledWith({ fileKey: "k1", anchor: { highlightId: "a" } });
    fireEvent.click(screen.getByText("a removed doc's line"));
    expect(screen.getByText("a removed doc's line").closest("button")).toBeNull();
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("does not render a row again when only the search around it changes", async () => {
    await mount();
    const renders = vi.spyOn(Date, "parse");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search highlights" }), { target: { value: "cache" } });
    await vi.waitFor(() => expect(rows()).toEqual(["the cache never misses", "p95 is 118 ms under load"]));
    expect(renders, "each row formats its date once per render").not.toHaveBeenCalled();
  });

  it("says why a document did not open", async () => {
    const f = await mount();
    f.open.mockRejectedValueOnce(new PluginError("timeout"));
    await act(async () => void fireEvent.click(screen.getByText("p95 is 118 ms under load")));
    expect(screen.getByRole("status").textContent).toBe("That document could not be opened. Try again.");
    f.open.mockRejectedValueOnce(new PluginError("not_found"));
    await act(async () => void fireEvent.click(screen.getByText("p95 is 118 ms under load")));
    expect(screen.getByRole("status").textContent).toBe("That document is no longer in a room.");
  });

  it("keeps each document's rows a list for VoiceOver, which drops list-style: none lists", async () => {
    await mount();
    for (const ul of document.querySelectorAll("ul")) expect(ul.getAttribute("role")).toBe("list");
  });

  it("reads only that document's lost text when it changes", async () => {
    const files: Record<string, string> = { ...FILES };
    const f = fakeRooms(files);
    render(<HighlightList rooms={f.rooms} />);
    await screen.findByText("the cache never misses");
    expect(screen.getAllByText("Text not found")).toHaveLength(1);
    const read = f.rooms.storage.read as ReturnType<typeof vi.fn>;
    const list = f.rooms.storage.list as ReturnType<typeof vi.fn>;
    read.mockClear();
    list.mockClear();
    files["docs/k1/orphans.json"] = JSON.stringify(["b"]);
    await act(async () => {
      f.change("docs/k1/orphans.json");
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(screen.getByText("the cache never misses").closest(".hl")!.textContent).toContain("Text not found");
    expect(screen.getByText("p95 is 118 ms under load").closest(".hl")!.textContent).not.toContain("Text not found");
    expect(read.mock.calls).toEqual([["docs/k1/orphans.json"]]);
    expect(list).not.toHaveBeenCalled();
  });

  it("lists again when a document's highlights change", async () => {
    const files: Record<string, string> = { ...FILES };
    const f = fakeRooms(files);
    render(<HighlightList rooms={f.rooms} />);
    await screen.findByText("the cache never misses");
    files["docs/k1/highlights.json"] = file("Latency report", [h("a", "important", "p95 is 118 ms under load", 1)]);
    await act(async () => {
      f.change("goals.json");
      f.change("docs/k1/highlights.json");
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(screen.queryByText("the cache never misses")).toBeNull();
    expect(screen.getByText("p95 is 118 ms under load")).toBeTruthy();
  });

  it("says so when there is nothing yet", async () => {
    const f = fakeRooms({});
    render(<HighlightList rooms={f.rooms} />);
    expect(await screen.findByText("No highlights yet")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("keeps the newest listing when an older one lands after it", async () => {
    const files: Record<string, string> = { ...FILES };
    const f = fakeRooms(files);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const read = f.rooms.storage.read as ReturnType<typeof vi.fn>;
    render(<HighlightList rooms={f.rooms} />);
    await screen.findByText("the cache never misses");
    read.mockImplementationOnce(async (p: string) => (await slow, files[p] ?? null));
    await act(async () => {
      f.change("docs/k1/highlights.json");
      await new Promise((r) => setTimeout(r, 200));
    });
    files["docs/k1/highlights.json"] = file("Latency report", [h("a", "important", "p95 is 118 ms under load", 1)]);
    await act(async () => {
      f.change("docs/k1/highlights.json");
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(screen.queryByText("the cache never misses")).toBeNull();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText("the cache never misses"), "the stale listing is dropped").toBeNull();
  });

  describe("answer highlights", () => {
    const ROOM = { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t1" };
    const PATH = "answer/room/r1/t1.json";
    const withAnswer = (notes: string[] = []) => ({ ...FILES, [PATH]: file("The cache misses at night", [h("x", "agree", "warm it after the job", 4, notes)]) });

    async function mountAnswer(files: Record<string, string>) {
      const f = fakeRooms(files);
      const storage = f.rooms.storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
      storage.write.mockImplementation(async (p: string, t: string) => void (files[p] = t));
      storage.delete.mockImplementation(async (p: string) => void delete files[p]);
      render(<HighlightList rooms={f.rooms} />);
      await screen.findByText("warm it after the job");
      return f;
    }

    it("lists them under their room's chat and jumps back to the answer", async () => {
      const f = await mountAnswer(withAnswer());
      const room = within(screen.getByRole("region", { name: "Bench" }));
      expect(room.getByText("Room chat")).toBeTruthy();
      expect(room.getByText("warm it after the job").closest(".hl")!.textContent).toMatch(/Agree · Room chat · .*2026/);
      fireEvent.click(room.getByText("warm it after the job"));
      expect(f.open).toHaveBeenCalledWith({ surface: ROOM, rangeId: "x" });
      fireEvent.click(room.getByRole("button", { name: "Bench" }));
      expect(f.open).toHaveBeenCalledWith({ roomId: "r1" });
    });

    it("adds, edits and deletes a note on an answer highlight in its file", async () => {
      const files = withAnswer(["first"]);
      await mountAnswer(files);
      const stored = () => JSON.parse(files[PATH]).highlights[0].annotations.map((a: { body: string }) => a.body);
      fireEvent.click(screen.getByRole("button", { name: "Edit 1 note" }));

      fireEvent.change(screen.getByRole("textbox", { name: "New note" }), { target: { value: "  second  " } });
      await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
      expect(stored()).toEqual(["first", "second"]);

      const [note] = await screen.findAllByRole("textbox", { name: "Note" });
      fireEvent.change(note, { target: { value: "first, edited" } });
      await act(async () => void fireEvent.blur(note));
      expect(stored()).toEqual(["first, edited", "second"]);

      await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]));
      expect(stored()).toEqual(["first, edited"]);
    });

    it("opens a highlight's notes when the menu over the answer asks, once", async () => {
      const files = { ...withAnswer(), "focus.json": JSON.stringify({ path: PATH, id: "x", at: Date.now() }) };
      const f = await mountAnswer(files);
      expect(await screen.findByRole("textbox", { name: "New note" })).toBe(document.activeElement);
      expect(files["focus.json"]).toBeUndefined();

      fireEvent.click(screen.getByRole("button", { name: "Hide notes" }));
      files["focus.json"] = JSON.stringify({ path: PATH, id: "x", at: Date.now() - 10 * 60_000 });
      await act(async () => f.change("focus.json"));
      expect(screen.queryByRole("textbox", { name: "New note" }), "a stale request is ignored").toBeNull();
    });
  });
});
