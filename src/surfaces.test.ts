import { describe, expect, it } from "vitest";
import { surfacePath, type SurfaceId } from "@alto-rooms/plugin-sdk";
import { editSurface, orphansPathOf, parseFocus, parseStoredPath, Serial, surfaceAt, surfaceFile } from "./surfaces";
import type { Edit } from "./model";

const PATH = "answer/room/r1/t1.json";
const h = (id: string) => ({ id, color: "agree", text: "warm it", prefix: "", suffix: "", start: -1, annotations: [], createdAt: "2026-10-11T00:00:00Z" });

/** Storage whose reads all finish before any write lands, the way two edits from one gesture interleave. */
function slowStorage(files: Map<string, string>) {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    read: async (p: string) => (await tick(), files.get(p) ?? null),
    write: async (p: string, t: string) => void (await tick(), files.set(p, t)),
    delete: async (p: string) => void files.delete(p),
    list: async () => [...files.keys()],
    onChange: () => () => {},
  };
}

const note = (id: string, body: string): Edit => ({ kind: "addNote", id: "x", note: { id, body, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" } });

describe("Serial", () => {
  it("keeps both of two concurrent edits on one answer, where unqueued edits drop one", async () => {
    const queue = new Serial();
    const files = new Map([[PATH, JSON.stringify({ version: 1, title: "q", highlights: [h("x")] })]]);
    const storage = slowStorage(files);
    const bodies = () => JSON.parse(files.get(PATH)!).highlights[0].annotations.map((a: { body: string }) => a.body);

    await Promise.all([note("n1", "first"), note("n2", "second")].map((e) => queue.run(PATH, () => editSurface(storage, PATH, e, "now"))));
    expect(bodies()).toEqual(["first", "second"]);

    files.set(PATH, JSON.stringify({ version: 1, title: "q", highlights: [h("x")] }));
    await Promise.all([note("n1", "first"), note("n2", "second")].map((e) => editSurface(storage, PATH, e, "now")));
    expect(bodies(), "the race this queue exists for").toHaveLength(1);
  });

  it("forgets a key once its tasks settle, failed ones too, and passes each failure to its caller", async () => {
    const queue = new Serial();
    let release!: () => void;
    const first = queue.run("a", () => new Promise<void>((r) => (release = r)));
    const second = queue.run("a", async () => {
      throw new Error("disk full");
    }).catch((e: Error) => e.message);
    const third = queue.run("a", async () => "ok");
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size).toBe(1);
    release();
    await first;
    expect(await second).toBe("disk full");
    expect(await third).toBe("ok");
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size).toBe(0);
  });
});

describe("stored paths", () => {
  const SURFACES: SurfaceId[] = [
    { kind: "answer", scope: { kind: "artifact", fileKey: "k1" }, turnId: "t1" },
    { kind: "answer", scope: { kind: "room", roomId: "r1" }, turnId: "t1" },
    { kind: "answer", scope: { kind: "day", date: "2026-10-11" }, turnId: "t1" },
    { kind: "answer", scope: { kind: "session", agent: "claude", id: "s-1" }, turnId: "t1" },
    { kind: "note", date: "2026-10-11", name: "Plan.md" },
    { kind: "note", date: "2026-10-11", name: "회의 메모.md" },
  ];

  it("names each surface's file by the SDK's surfacePath, and reads every one back, a note by its title", () => {
    for (const s of SURFACES) {
      const path = surfaceFile(s);
      expect(path).toBe(`${surfacePath(s)}.json`);
      expect(surfaceAt(path, s.kind === "note" ? s.name : "any answer title")).toEqual(s);
    }
    expect(surfaceFile(SURFACES[0])).toBe("answer/artifact/k1/t1.json");
    expect(surfaceFile(SURFACES[3])).toBe("answer/session/claude/s-1/t1.json");
    expect(surfaceFile(SURFACES[4])).toMatch(/^note\/2026-10-11\/plan\.md-[0-9a-f]{8}\.json$/);
  });

  it("refuses a note file whose title is not the name its path was made from, and any path of SDK 0.5", () => {
    const plan = surfaceFile(SURFACES[4]);
    expect(surfaceAt(plan, "PLAN.md"), "the same file under another spelling").toEqual({ kind: "note", date: "2026-10-11", name: "PLAN.md" });
    expect(surfaceAt(plan, "Other.md")).toBeNull();
    expect(parseStoredPath("answer/doc/k1/t1.json")).toBeNull();
    expect(parseStoredPath("answer/conversation/claude/s-1/t1.json")).toBeNull();
    expect(parseStoredPath("note/2026-10-11/x.orphans")).toBeNull();
  });

  it("takes a focus request for a note's file as for an answer's", () => {
    const path = surfaceFile(SURFACES[4]);
    expect(parseFocus(JSON.stringify({ path, id: "h1", at: 1000 }), 2000)).toEqual({ path, id: "h1", at: 1000 });
    expect(parseFocus(JSON.stringify({ path: "answer/doc/k1/t1.json", id: "h1", at: 1000 }), 2000)).toBeNull();
  });
});

describe("orphansPathOf", () => {
  it("sits beside the surface's file and never reads as a surface", () => {
    expect(orphansPathOf(PATH)).toBe("answer/room/r1/t1.orphans");
    expect(parseStoredPath(orphansPathOf(PATH))).toBeNull();
  });
});
