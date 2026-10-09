import { describe, expect, it, vi } from "vitest";
import type { PluginArtifact } from "@alto-rooms/plugin-sdk";
import { collect, type CollectContext } from "./collect";

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
    expect(c.docs.map((d) => [d.fileKey, d.title, d.rooms, d.highlights.map((x) => x.id)])).toEqual([
      ["k1", "Report", ["Bench", "Research"], ["b", "a"]],
      ["k2", "Notes", ["Bench"], ["c"]],
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
    expect(c.docs.map((d) => [d.fileKey, d.highlights.map((x) => x.id)])).toEqual([["k3", ["ok"]]]);
  });

  it("keeps a document no room links any more, under its stored title and no rooms", async () => {
    const c = await collect(ctx({ "docs/gone/highlights.json": file("Old report", [h("a", "2026-10-01")]) }, [{ id: "r1", name: "Bench", artifacts: [] }]));
    expect(c.docs).toEqual([expect.objectContaining({ fileKey: "gone", title: "Old report", rooms: [] })]);
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
    expect(c.docs.map((d) => d.fileKey)).toEqual(["k2"]);
    expect([...c.docs[0].orphans]).toEqual(["<b>x</b>", "a"]);
  });
});
