import { describe, expect, it, vi } from "vitest";
import type { PluginArtifact, SurfaceId } from "@alto-rooms/plugin-sdk";
import { orphansPathOf, surfaceFile } from "../surfaces";
import { collect, type CollectContext, type Group } from "./collect";

const ids = (g: Group) => g.found.map((f) => f.h.id);

const h = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, color: "agree", text: `text ${id}`, prefix: "", suffix: "", start: -1, annotations: [], createdAt, ...extra });
const file = (title: string, highlights: unknown[]) => JSON.stringify({ version: 1, title, highlights });
const art = (roomId: string, fileKey: string, title: string): PluginArtifact => ({ roomId, artifactId: `${roomId}-${fileKey}`, fileKey, title, createdAt: "2026-10-01" });

function ctx(files: Record<string, string>, rooms: { id: string; name: string; artifacts: PluginArtifact[] }[]): CollectContext {
  return {
    storage: {
      read: vi.fn(async (p: string) => files[p] ?? null),
      write: vi.fn(),
      list: vi.fn(async (prefix = "") => Object.keys(files).filter((p) => p.startsWith(prefix)).sort()),
      delete: vi.fn(),
      onChange: () => () => {},
    },
    rooms: { list: async () => rooms.map(({ id, name }) => ({ id, name })) },
    artifacts: { list: async (roomId: string) => rooms.find((r) => r.id === roomId)?.artifacts ?? [] },
  };
}

describe("collect", () => {
  it("lists two documents' highlights, newest first, joined with their titles and rooms by fileKey", async () => {
    const c = await collect(
      ctx(
        {
          "docs/k1/highlights.json": file("Stored title", [h("a", "2026-10-01T00:00:00Z"), h("b", "2026-10-03T00:00:00Z")]),
          "docs/k2/highlights.json": file("Second", [h("c", "2026-10-02T00:00:00Z")]),
          "goals.json": "{}",
        },
        [
          { id: "r1", name: "Bench", artifacts: [art("r1", "k1", "Report"), art("r1", "k2", "Notes")] },
          { id: "r2", name: "Research", artifacts: [art("r2", "k1", "Report (linked)")] },
        ],
      ),
    );
    expect(c.skipped).toBe(0);
    expect(c.groups.map((g) => [g.key, g.title, g.where, ids(g)])).toEqual([
      ["doc:k1", "Report", "Bench · Research", ["b", "a"]],
      ["doc:k2", "Notes", "Bench", ["c"]],
    ]);
  });

  it("skips and counts a forged file that is not a record, and drops its bad entries otherwise", async () => {
    const c = await collect(
      ctx(
        {
          "docs/k1/highlights.json": "<img src=x onerror=alert(1)>",
          "docs/k2/highlights.json": JSON.stringify([h("x", "2026-10-01")]),
          "docs/k3/highlights.json": file("Mixed", [h("ok", "2026-10-01"), { ...h("bad", "2026-10-01"), color: "javascript:alert(1)" }]),
        },
        [{ id: "r1", name: "Bench", artifacts: [art("r1", "k3", "Mixed")] }],
      ),
    );
    expect(c.skipped).toBe(2);
    expect(c.groups.map((g) => [g.key, ids(g)])).toEqual([["doc:k3", ["ok"]]]);
  });

  it("keeps a document no room links any more, under its stored title and no rooms", async () => {
    const c = await collect(ctx({ "docs/gone/highlights.json": file("Old report", [h("a", "2026-10-01")]) }, [{ id: "r1", name: "Bench", artifacts: [] }]));
    expect(c.groups).toEqual([expect.objectContaining({ key: "doc:gone", title: "Old report", where: "Doc removed", removed: true })]);
  });

  it("leaves out documents with no highlights left, and reads which ones the document lost", async () => {
    const c = await collect(
      ctx(
        {
          "docs/k1/highlights.json": file("Empty", []),
          "docs/k2/highlights.json": file("Doc", [h("a", "2026-10-01"), h("b", "2026-10-02")]),
          "docs/k2/orphans.json": JSON.stringify(["a", 7, "<b>x</b>"]),
          "docs/k3/orphans.json": JSON.stringify(["z"]),
        },
        [],
      ),
    );
    expect(c.groups.map((g) => g.key)).toEqual(["doc:k2"]);
    expect([...c.groups[0].orphans]).toEqual(["doc:k2#<b>x</b>", "doc:k2#a"]);
  });

  it("reads which answer highlights lost their text, beside the answer's file, and never lists that file as an answer", async () => {
    const c = await collect(
      ctx(
        {
          "docs/k1/highlights.json": file("Report", [h("a", "2026-10-01T00:00:00Z")]),
          "docs/k1/orphans.json": JSON.stringify(["a"]),
          "answer/artifact/k1/t1.json": file("Q", [h("a", "2026-10-04T00:00:00Z"), h("b", "2026-10-03T00:00:00Z")]),
          "answer/artifact/k1/t1.orphans": JSON.stringify(["b"]),
          "answer/room/r1/t2.json": file("Q", [h("c", "2026-10-02T00:00:00Z")]),
        },
        [{ id: "r1", name: "Bench", artifacts: [art("r1", "k1", "Report")] }],
      ),
    );
    expect(c.skipped).toBe(0);
    expect(c.groups.map((g) => [g.key, [...g.orphans].sort()])).toEqual([
      ["doc:k1", ["answer/artifact/k1/t1.json#b", "doc:k1#a"]],
      ["room:r1", []],
    ]);
  });

  it("lists answer highlights under their thread: a doc chat with its document, a room chat under the room, a day chat under the day", async () => {
    const c = await collect(
      ctx(
        {
          "docs/k1/highlights.json": file("Report", [h("d1", "2026-10-01T00:00:00Z")]),
          "answer/artifact/k1/t1.json": file("The cache misses at night", [h("a1", "2026-10-04T00:00:00Z")]),
          "answer/room/r1/t2.json": file("Three docs disagree", [h("a2", "2026-10-03T00:00:00Z")]),
          "answer/room/r1/t3.json": file("Later", [h("a3", "2026-10-05T00:00:00Z")]),
          "answer/day/2026-10-11/t4.json": file("Yesterday", [h("a4", "2026-10-02T00:00:00Z")]),
          "answer/room/gone/t5.json": file("Old", [h("a5", "2026-09-01T00:00:00Z")]),
          "answer/room/r1/notes.txt": "x",
          "answer/room/r1/t6.json": "{",
        },
        [{ id: "r1", name: "Bench", artifacts: [art("r1", "k1", "Report")] }],
      ),
    );
    expect(c.skipped).toBe(1);
    expect(c.groups.map((g) => [g.key, g.where, g.removed, g.target, ids(g)])).toEqual([
      ["room:r1", "Room chat", false, { roomId: "r1" }, ["a3", "a2"]],
      ["doc:k1", "Bench", false, { fileKey: "k1" }, ["a1", "d1"]],
      ["day:2026-10-11", "Journal", false, null, ["a4"]],
      ["room:gone", "Room removed", true, { roomId: "gone" }, ["a5"]],
    ]);
    expect(c.groups[0].title).toBe("Bench");
    expect(c.groups[2].title).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(2026, 9, 11)));
    const doc = c.groups[1].found;
    expect(doc.map((f) => f.place)).toEqual([
      { kind: "surface", surface: { kind: "answer", scope: { kind: "artifact", fileKey: "k1" }, turnId: "t1" }, path: "answer/artifact/k1/t1.json" },
      { kind: "doc", fileKey: "k1" },
    ]);
  });

  it("lists each note's highlights as its own group under its name, marked Notes with the day, and opens them by the name in the file", async () => {
    const plan: SurfaceId = { kind: "note", date: "2026-10-11", name: "Plan.md" };
    const memo: SurfaceId = { kind: "note", date: "2026-10-04", name: "회의 메모.md" };
    const c = await collect(
      ctx(
        {
          [surfaceFile(plan)]: file("Plan.md", [h("n1", "2026-10-11T00:00:00Z"), h("n2", "2026-10-11T01:00:00Z")]),
          [orphansPathOf(surfaceFile(plan))]: JSON.stringify(["n1"]),
          [surfaceFile(memo)]: file("회의 메모.md", [h("n3", "2026-10-05T00:00:00Z")]),
          [surfaceFile({ kind: "note", date: "2026-10-04", name: "Forged.md" })]: file("Other.md", [h("n4", "2026-10-06T00:00:00Z")]),
          "answer/room/r1/t1.json": file("Q", [h("a1", "2026-10-08T00:00:00Z")]),
        },
        [{ id: "r1", name: "Bench", artifacts: [] }],
      ),
    );
    const day = (y: number, m: number, d: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(y, m, d));
    expect(c.skipped, "a note file whose title is not its name").toBe(1);
    expect(c.groups.map((g) => [g.title, g.where, g.target, g.removed, ids(g)])).toEqual([
      ["Plan", `Notes · ${day(2026, 9, 11)}`, null, false, ["n2", "n1"]],
      ["Bench", "Room chat", { roomId: "r1" }, false, ["a1"]],
      ["회의 메모", `Notes · ${day(2026, 9, 4)}`, null, false, ["n3"]],
    ]);
    expect(c.groups[0].found[0].place).toEqual({ kind: "surface", surface: plan, path: surfaceFile(plan) });
    expect([...c.groups[0].orphans]).toEqual([`${surfaceFile(plan)}#n1`]);
  });
});
