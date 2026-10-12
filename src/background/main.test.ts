import { beforeEach, describe, expect, it, vi } from "vitest";
import { surfacePath, type ContentAction, type SurfaceId, type SurfaceRange, type SurfaceStyles } from "@alto-rooms/plugin-sdk";

type Cb = (...a: never[]) => void;
/** The app side of connect() and connectSurfaces(): storage in a Map, and what the page posted. */
const app = vi.hoisted(() => ({
  files: new Map<string, string>(),
  actions: [] as ContentAction[],
  paints: [] as { surface: SurfaceId; ranges: SurfaceRange[]; styles?: SurfaceStyles; version?: number }[],
  menus: [] as { surface: SurfaceId; rangeId: string; items: ContentAction[] }[],
  on: {} as Record<string, Cb>,
  changed: null as ((path: string) => void) | null,
  ready: false,
}));

vi.mock("@alto-rooms/plugin-sdk", async (actual) => ({
  ...(await actual<typeof import("@alto-rooms/plugin-sdk")>()),
  connect: async () => ({
    storage: {
      read: async (p: string) => app.files.get(p) ?? null,
      write: async (p: string, t: string) => void app.files.set(p, t),
      delete: async (p: string) => void app.files.delete(p),
      list: async (prefix = "") => [...app.files.keys()].filter((p) => p.startsWith(prefix)),
      onChange: (cb: (p: string) => void) => ((app.changed = cb), () => {}),
    },
  }),
  connectSurfaces: () => {
    const on = (name: string) => (cb: Cb) => ((app.on[name] = cb), () => {});
    return {
      setActions: (items: ContentAction[]) => (app.actions = items),
      paint: (surface: SurfaceId, ranges: SurfaceRange[], styles?: SurfaceStyles, version?: number) => app.paints.push({ surface, ranges, styles, version }),
      menu: (surface: SurfaceId, rangeId: string, items: ContentAction[]) => app.menus.push({ surface, rangeId, items }),
      onOpen: on("open"),
      onClose: on("close"),
      onAction: on("action"),
      onRangeClick: on("rangeClick"),
      onRangeAction: on("rangeAction"),
      ready: () => (app.ready = true),
    };
  },
}));

const ROOM: SurfaceId = { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t1" };
const DAY: SurfaceId = { kind: "answer", scope: { kind: "day", date: "2026-10-11" }, turnId: "t9" };
const ROOM_FILE = "answer/room/r1/t1.json";
const ANSWER = "The cache misses at night because the batch job evicts it. Warm it after the job.";

const settle = () => new Promise((r) => setTimeout(r, 0));
const fire = async (name: string, ...args: unknown[]) => {
  await settle();
  (app.on[name] as (...a: unknown[]) => void)(...args);
  await settle();
  await settle();
};
const stored = (path = ROOM_FILE) => JSON.parse(app.files.get(path)!);
const lastPaint = () => app.paints[app.paints.length - 1];
const at = (s: string) => ({ start: ANSWER.indexOf(s), end: ANSWER.indexOf(s) + s.length });

async function boot(files: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(app, { files: new Map(Object.entries(files)), actions: [], paints: [], menus: [], on: {}, changed: null, ready: false });
  await import("./main");
}

describe("the background page", () => {
  beforeEach(() => boot());

  it("puts the four document colors in the bar over answers, and says it is ready", () => {
    expect(app.actions).toEqual([
      { id: "important", title: "Important", color: "#b8893a" },
      { id: "agree", title: "Agree", color: "#6f8f6a" },
      { id: "disagree", title: "DisAgree", color: "#be7257" },
      { id: "idk", title: "IDK", color: "#8e84a0" },
    ]);
    expect(app.ready).toBe(true);
  });

  it("stores a picked color with 40 characters of context and paints it in the document color", async () => {
    await fire("open", ROOM, ANSWER);
    const { start, end } = at("batch job evicts it");
    await fire("action", "disagree", { surface: ROOM, start, end, text: "batch job evicts it" });

    const file = stored();
    expect(file.title).toBe(ANSWER.slice(0, 80));
    expect(file.highlights).toEqual([
      expect.objectContaining({ color: "disagree", text: "batch job evicts it", prefix: ANSWER.slice(Math.max(0, start - 40), start), suffix: ANSWER.slice(end, end + 40), start, annotations: [] }),
    ]);
    expect(lastPaint()).toEqual({
      surface: ROOM,
      ranges: [{ id: file.highlights[0].id, start, end, style: "disagree" }],
      styles: { important: "rgba(199,154,62,0.28)", agree: "rgba(122,153,113,0.26)", disagree: "rgba(190,114,87,0.24)", idk: "rgba(142,132,160,0.26)" },
    });
  });

  it("repaints a stored highlight on open, found again by its context after the answer changed", async () => {
    const h = { id: "h1", color: "agree", text: "Warm it", prefix: "evicts it. ", suffix: " after the job.", start: 60, annotations: [], createdAt: "2026-10-11T00:00:00Z" };
    await boot({ "answer/day/2026-10-11/t9.json": JSON.stringify({ version: 1, title: "x", highlights: [h] }) });
    const text = `Short answer. ${ANSWER}`;
    await fire("open", DAY, text);
    expect(lastPaint().ranges).toEqual([{ id: "h1", start: text.indexOf("Warm it"), end: text.indexOf("Warm it") + 7, style: "agree" }]);
  });

  it("finds a painted highlight again when the open answer's text changes", async () => {
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, ...at("Warm it"), text: "Warm it" });
    const id = stored().highlights[0].id;
    const text = `Updated. ${ANSWER}`;
    await fire("open", ROOM, text);
    expect(lastPaint().ranges).toEqual([{ id, start: text.indexOf("Warm it"), end: text.indexOf("Warm it") + 7, style: "agree" }]);
  });

  it("tells the tab which highlights the answer lost, and clears it once they are back", async () => {
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, ...at("Warm it"), text: "Warm it" });
    const id = stored().highlights[0].id;
    await fire("open", ROOM, "A regenerated answer about something else entirely.");
    expect(lastPaint().ranges).toEqual([]);
    expect(JSON.parse(app.files.get("answer/room/r1/t1.orphans")!)).toEqual([id]);

    await fire("open", ROOM, ANSWER);
    expect(lastPaint().ranges).toHaveLength(1);
    expect(app.files.has("answer/room/r1/t1.orphans")).toBe(false);
  });

  it("reports a stored highlight lost on first open, and writes nothing when nothing is lost", async () => {
    const h = { id: "h1", color: "agree", text: "gone words", prefix: "", suffix: "", start: 3, annotations: [], createdAt: "2026-10-11T00:00:00Z" };
    await boot({ "answer/day/2026-10-11/t9.json": JSON.stringify({ version: 1, title: "x", highlights: [h] }) });
    await fire("open", DAY, ANSWER);
    expect(JSON.parse(app.files.get("answer/day/2026-10-11/t9.orphans")!)).toEqual(["h1"]);

    await boot();
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, ...at("cache"), text: "cache" });
    expect([...app.files.keys()]).toEqual([ROOM_FILE]);
  });

  it("ignores a whitespace selection, an unknown action and a closed answer", async () => {
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, start: 9, end: 10, text: " " });
    await fire("action", "pink", { surface: ROOM, ...at("cache"), text: "cache" });
    await fire("close", ROOM);
    await fire("action", "agree", { surface: ROOM, ...at("cache"), text: "cache" });
    expect(app.files.has(ROOM_FILE)).toBe(false);
  });

  it("answers a range click with recolor, delete and the note count, and recolors and deletes from it", async () => {
    await fire("open", ROOM, ANSWER);
    await fire("action", "important", { surface: ROOM, ...at("cache"), text: "cache" });
    const id = stored().highlights[0].id;

    await fire("rangeClick", ROOM, id);
    expect(app.menus).toEqual([
      {
        surface: ROOM,
        rangeId: id,
        items: [
          { id: "important", title: "Important", color: "#b8893a" },
          { id: "agree", title: "Agree", color: "#6f8f6a" },
          { id: "disagree", title: "DisAgree", color: "#be7257" },
          { id: "idk", title: "IDK", color: "#8e84a0" },
          { id: "delete", title: "Delete" },
          { id: "notes", title: "Add a note in Highlights" },
        ],
      },
    ]);

    await fire("rangeAction", ROOM, id, "idk");
    expect(stored().highlights[0].color).toBe("idk");
    expect(lastPaint().ranges).toEqual([expect.objectContaining({ id, style: "idk" })]);

    await fire("rangeAction", ROOM, id, "delete");
    expect(app.files.has(ROOM_FILE)).toBe(false);
    expect(lastPaint().ranges).toEqual([]);
  });

  it("asks the tab for the highlight's notes, and picks up a note the tab added", async () => {
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, ...at("Warm it"), text: "Warm it" });
    const id = stored().highlights[0].id;

    await fire("rangeAction", ROOM, id, "notes");
    expect(JSON.parse(app.files.get("focus.json")!)).toEqual({ path: ROOM_FILE, id, at: expect.any(Number) });

    const withNote = stored();
    withNote.highlights[0].annotations = [{ id: "n1", body: "after 2am", createdAt: "2026-10-11T00:00:00Z" }];
    app.files.set(ROOM_FILE, JSON.stringify(withNote));
    app.changed!(ROOM_FILE);
    await settle();
    await fire("rangeClick", ROOM, id);
    expect(app.menus.at(-1)!.items.at(-1)).toEqual({ id: "notes", title: "1 note in Highlights" });
  });

  it("keeps two quick picks, and never overwrites a stored file it cannot read", async () => {
    await fire("open", ROOM, ANSWER);
    app.on.action("agree" as never, { surface: ROOM, ...at("cache"), text: "cache" } as never);
    await fire("action", "idk", { surface: ROOM, ...at("Warm it"), text: "Warm it" });
    expect(stored().highlights.map((h: { color: string }) => h.color)).toEqual(["agree", "idk"]);

    await boot({ [ROOM_FILE]: "not json" });
    await fire("open", ROOM, ANSWER);
    await fire("action", "agree", { surface: ROOM, ...at("cache"), text: "cache" });
    expect(app.files.get(ROOM_FILE)).toBe("not json");
  });
});

describe("answers saved before 0.4.0", () => {
  it("moves an artifact chat's answer file to its new path before reading it, and paints its highlights", async () => {
    const ART: SurfaceId = { kind: "answer", scope: { kind: "artifact", fileKey: "k1" }, turnId: "t1" };
    const h = { id: "h1", color: "idk", text: "Warm it", prefix: "evicts it. ", suffix: " after the job.", start: 70, annotations: [], createdAt: "2026-10-11T00:00:00Z" };
    const old = JSON.stringify({ version: 1, title: "q", highlights: [h] });
    await boot({ "answer/doc/k1/t1.json": old });
    await fire("open", ART, ANSWER, 4);
    expect([...app.files.keys()]).toEqual(["answer/artifact/k1/t1.json"]);
    expect(app.files.get("answer/artifact/k1/t1.json")).toBe(old);
    expect(lastPaint()).toEqual(expect.objectContaining({ surface: ART, ranges: [{ id: "h1", ...at("Warm it"), style: "idk" }], version: 4 }));
  });
});

describe("note highlights", () => {
  const NOTE: SurfaceId = { kind: "note", date: "2026-10-11", name: "Plan.md" };
  const FILE = `${surfacePath(NOTE)}.json`;
  const BODY = "Ship the cache fix on Friday.\nThen warm it after the batch job.";
  const where = (text: string, s: string) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });

  beforeEach(() => boot());

  async function highlighted(word = "warm it") {
    await fire("open", NOTE, BODY, 1);
    await fire("action", "agree", { surface: NOTE, ...where(BODY, word), text: word });
    return stored(FILE).highlights[0].id as string;
  }

  it("stores a note's highlight under the SDK's path for the note, titled with its name, and paints it on the text it was given", async () => {
    const id = await highlighted();
    expect(FILE).toMatch(/^note\/2026-10-11\/plan\.md-[0-9a-f]{8}\.json$/);
    expect(stored(FILE).title).toBe("Plan.md");
    expect(lastPaint()).toEqual(expect.objectContaining({ surface: NOTE, ranges: [{ id, ...where(BODY, "warm it"), style: "agree" }], version: 1 }));
  });

  it("keeps the paint on its words when the user types above it, naming the newer text", async () => {
    const id = await highlighted();
    const typed = `A new first line.\n${BODY}`;
    await fire("open", NOTE, typed, 7);
    expect(lastPaint()).toEqual(expect.objectContaining({ ranges: [{ id, ...where(typed, "warm it"), style: "agree" }], version: 7 }));
    expect(app.files.has(FILE.replace(/\.json$/, ".orphans"))).toBe(false);
  });

  it("keeps a highlight whose words were deleted as lost, paints nothing for it, and paints it again once the words are back", async () => {
    const id = await highlighted();
    const cut = "Ship the cache fix on Friday.\nThen leave it.";
    await fire("open", NOTE, cut, 2);
    expect(lastPaint().ranges).toEqual([]);
    expect(stored(FILE).highlights.map((h: { id: string }) => h.id)).toEqual([id]);
    expect(JSON.parse(app.files.get(FILE.replace(/\.json$/, ".orphans"))!)).toEqual([id]);

    await fire("open", NOTE, BODY, 3);
    expect(lastPaint().ranges).toEqual([{ id, ...where(BODY, "warm it"), style: "agree" }]);
  });

  it("takes a note's highlights along when it is renamed, and paints them under the new name", async () => {
    const id = await highlighted();
    const renamed: SurfaceId = { kind: "note", date: "2026-10-11", name: "Launch plan.md" };
    const to = `${surfacePath(renamed)}.json`;
    await fire("close", NOTE);
    await fire("open", renamed, BODY, 2);
    expect([...app.files.keys()]).toEqual([to]);
    expect(stored(to)).toEqual(expect.objectContaining({ title: "Launch plan.md", highlights: [expect.objectContaining({ id, text: "warm it" })] }));
    expect(lastPaint()).toEqual(expect.objectContaining({ surface: renamed, ranges: [{ id, ...where(BODY, "warm it"), style: "agree" }], version: 2 }));
  });

  it("does not take a closed note's highlights into a different note opened after it", async () => {
    await highlighted();
    await fire("close", NOTE);
    const other: SurfaceId = { kind: "note", date: "2026-10-11", name: "Groceries.md" };
    await fire("open", other, "Eggs, milk.", 2);
    expect([...app.files.keys()]).toEqual([FILE]);
    expect(lastPaint()).toEqual(expect.objectContaining({ surface: other, ranges: [] }));
  });
});
