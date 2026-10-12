import { describe, expect, it } from "vitest";
import { moveLegacyAnswers, movedPath } from "./legacy";
import { parseStoredPath, Serial } from "./surfaces";

const h = (id: string) => ({ id, color: "agree", text: `text ${id}`, prefix: "", suffix: "", start: -1, annotations: [], createdAt: "2026-10-11T00:00:00Z" });
const file = (title: string, ids: string[]) => JSON.stringify({ version: 1, title, highlights: ids.map(h) });

function storage(files: Map<string, string>, failWrite?: string) {
  return {
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, t: string) => {
      if (p === failWrite) throw new Error("disk full");
      files.set(p, t);
    },
    delete: async (p: string) => void files.delete(p),
    list: async (prefix = "") => [...files.keys()].filter((p) => p.startsWith(prefix)),
    onChange: () => () => {},
  };
}

const ids = (raw: string | undefined) => JSON.parse(raw!).highlights.map((x: { id: string }) => x.id);

describe("movedPath", () => {
  it("renames the two scopes SDK 0.6 renamed, and leaves every other path", () => {
    expect(movedPath("answer/doc/k1/t1.json")).toBe("answer/artifact/k1/t1.json");
    expect(movedPath("answer/doc/k1/t1.orphans")).toBe("answer/artifact/k1/t1.orphans");
    expect(movedPath("answer/conversation/claude/s-1/t1.json")).toBe("answer/session/claude/s-1/t1.json");
    expect(parseStoredPath(movedPath("answer/conversation/claude/s-1/t1.json")!)).not.toBeNull();
    expect(movedPath("answer/room/r1/t1.json")).toBeNull();
    expect(movedPath("answer/artifact/k1/t1.json")).toBeNull();
    expect(movedPath("docs/doc/highlights.json")).toBeNull();
  });
});

describe("moveLegacyAnswers", () => {
  it("moves an artifact's and a session's answer files byte for byte, with their lost-text lists, and keeps room and day files", async () => {
    const files = new Map([
      ["answer/doc/k1/t1.json", file("Q1", ["a"])],
      ["answer/doc/k1/t1.orphans", JSON.stringify(["a"])],
      ["answer/conversation/claude/s-1/t2.json", file("Q2", ["b"])],
      ["answer/room/r1/t3.json", file("Q3", ["c"])],
      ["docs/k1/highlights.json", file("Doc", ["d"])],
    ]);
    const before = new Map(files);
    expect(await moveLegacyAnswers(storage(files), new Serial())).toBe(3);
    expect([...files.keys()].sort()).toEqual([
      "answer/artifact/k1/t1.json",
      "answer/artifact/k1/t1.orphans",
      "answer/room/r1/t3.json",
      "answer/session/claude/s-1/t2.json",
      "docs/k1/highlights.json",
    ]);
    expect(files.get("answer/artifact/k1/t1.json")).toBe(before.get("answer/doc/k1/t1.json"));
    expect(files.get("answer/artifact/k1/t1.orphans")).toBe(before.get("answer/doc/k1/t1.orphans"));
    expect(files.get("answer/session/claude/s-1/t2.json")).toBe(before.get("answer/conversation/claude/s-1/t2.json"));

    expect(await moveLegacyAnswers(storage(files), new Serial()), "a second run finds nothing").toBe(0);
  });

  it("adds an old file's highlights to a new file at the same path, the new one winning on a shared id", async () => {
    const files = new Map([
      ["answer/doc/k1/t1.json", file("Old", ["a", "b"])],
      ["answer/artifact/k1/t1.json", JSON.stringify({ version: 1, title: "New", highlights: [{ ...h("b"), color: "idk" }, h("c")] })],
    ]);
    await moveLegacyAnswers(storage(files), new Serial());
    const merged = JSON.parse(files.get("answer/artifact/k1/t1.json")!);
    expect(merged.title).toBe("New");
    expect(merged.highlights.map((x: { id: string; color: string }) => `${x.id}:${x.color}`)).toEqual(["b:idk", "c:agree", "a:agree"]);
    expect(files.has("answer/doc/k1/t1.json")).toBe(false);
  });

  it("loses nothing when a write fails part way, and finishes on the next run", async () => {
    const files = new Map([
      ["answer/doc/k1/t1.json", file("Q1", ["a"])],
      ["answer/doc/k2/t2.json", file("Q2", ["b"])],
    ]);
    await expect(moveLegacyAnswers(storage(files, "answer/artifact/k2/t2.json"), new Serial())).rejects.toThrow("disk full");
    expect(ids(files.get("answer/doc/k2/t2.json")), "the old file stays until the new one is written").toEqual(["b"]);
    expect(ids(files.get("answer/artifact/k1/t1.json"))).toEqual(["a"]);

    await moveLegacyAnswers(storage(files), new Serial());
    expect([...files.keys()].sort()).toEqual(["answer/artifact/k1/t1.json", "answer/artifact/k2/t2.json"]);
  });

  it("leaves both files when the old or the new one is not a record", async () => {
    const files = new Map([
      ["answer/doc/k1/t1.json", "not json"],
      ["answer/artifact/k1/t1.json", file("New", ["a"])],
    ]);
    await moveLegacyAnswers(storage(files), new Serial());
    expect(files.get("answer/doc/k1/t1.json")).toBe("not json");
    expect(ids(files.get("answer/artifact/k1/t1.json"))).toEqual(["a"]);
  });
});
