import { describe, expect, it } from "vitest";
import { answerOrphansPath, editAnswer, Serial, surfaceOf } from "./answers";
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

    await Promise.all([note("n1", "first"), note("n2", "second")].map((e) => queue.run(PATH, () => editAnswer(storage, PATH, e, "now"))));
    expect(bodies()).toEqual(["first", "second"]);

    files.set(PATH, JSON.stringify({ version: 1, title: "q", highlights: [h("x")] }));
    await Promise.all([note("n1", "first"), note("n2", "second")].map((e) => editAnswer(storage, PATH, e, "now")));
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

describe("answerOrphansPath", () => {
  it("sits beside the answer's file and never reads as an answer", () => {
    expect(answerOrphansPath(PATH)).toBe("answer/room/r1/t1.orphans");
    expect(surfaceOf(answerOrphansPath(PATH))).toBeNull();
  });
});
