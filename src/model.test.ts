import { describe, expect, it } from "vitest";
import { applyEdit, COLORS, newHighlight, newNote, ORDER, parseDocFile, serialize, type DocFile } from "./model";

const T0 = "2026-10-09T00:00:00.000Z";
const T1 = "2026-10-09T01:00:00.000Z";

const valid = {
  id: "h1",
  color: "agree",
  text: "quick brown fox",
  prefix: "The ",
  suffix: " jumps",
  start: 4,
  annotations: [{ id: "n1", body: "a note", createdAt: T0, updatedAt: T0 }],
  createdAt: T0,
  updatedAt: T0,
};
const file = (highlights: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, title: "Doc", highlights, ...extra });

describe("parseDocFile", () => {
  it("reads a valid record unchanged", () => {
    expect(parseDocFile(file([valid]))).toEqual({ version: 1, title: "Doc", highlights: [valid] });
  });

  it("round-trips what it writes", () => {
    const doc = parseDocFile(file([valid]));
    expect(parseDocFile(serialize(doc))).toEqual(doc);
  });

  it("returns an empty record for a missing, broken or non-object file", () => {
    for (const raw of [null, "", "{", "[]", "42", "null"]) expect(parseDocFile(raw)).toEqual({ version: 1, title: "", highlights: [] });
  });

  it("drops forged entries with wrong types and keeps the good ones", () => {
    const forged = [
      { ...valid, id: 7 },
      { ...valid, id: "h2", text: ["x"] },
      { ...valid, id: "h3", color: { important: 1 } },
      { ...valid, id: "h4", createdAt: null },
      "string",
      null,
      { ...valid, id: "h5", annotations: [{ id: "n", body: 5 }, null, { id: "n2", body: "kept", createdAt: T0 }] },
      { ...valid, id: "h6", start: "4", prefix: 3, suffix: "x".repeat(41) },
    ];
    const doc = parseDocFile(file([valid, ...forged], { title: 12 }));
    expect(doc.title).toBe("");
    expect(doc.highlights.map((h) => h.id)).toEqual(["h1", "h5", "h6"]);
    expect(doc.highlights[1].annotations).toEqual([{ id: "n2", body: "kept", createdAt: T0, updatedAt: T0 }]);
    expect(doc.highlights[2]).toMatchObject({ start: -1, prefix: "", suffix: "" });
  });

  it("drops a highlight longer than 2,000 characters", () => {
    const doc = parseDocFile(file([{ ...valid, text: "x".repeat(10_000) }, { ...valid, id: "h2", text: "x".repeat(2000) }]));
    expect(doc.highlights.map((h) => h.id)).toEqual(["h2"]);
  });

  it("drops an unknown color, including inherited names", () => {
    const doc = parseDocFile(file([{ ...valid, color: "yellow" }, { ...valid, id: "h2", color: "toString" }, { ...valid, id: "h3", color: "idk" }]));
    expect(doc.highlights.map((h) => h.id)).toEqual(["h3"]);
  });

  it("keeps the first of two entries with one id", () => {
    const doc = parseDocFile(file([valid, { ...valid, color: "idk" }]));
    expect(doc.highlights).toHaveLength(1);
    expect(doc.highlights[0].color).toBe("agree");
  });

  it("turns a Hi-Lighter record's old note field into an annotation", () => {
    const { annotations: _, ...old } = valid;
    const doc = parseDocFile(file([{ ...old, url: "https://example.com", title: "Old", note: "from before" }]));
    expect(doc.highlights[0].annotations).toEqual([{ id: "h1-note", body: "from before", createdAt: T0, updatedAt: T0 }]);
    expect(doc.highlights[0]).not.toHaveProperty("note");
    expect(doc.highlights[0]).not.toHaveProperty("url");
  });
});

describe("the record", () => {
  it("has Hi-Lighter's four colors in its order", () => {
    expect(ORDER).toEqual(["important", "agree", "disagree", "idk"]);
    expect(ORDER.map((c) => [COLORS[c].label, COLORS[c].solid])).toEqual([
      ["Important", "#b8893a"],
      ["Agree", "#6f8f6a"],
      ["DisAgree", "#be7257"],
      ["IDK", "#8e84a0"],
    ]);
  });

  it("builds a highlight with the shape the file stores", () => {
    const h = newHighlight({ text: "fox", prefix: "brown ", suffix: " jumps", start: 16 }, "important", "h9", T0);
    expect(h).toEqual({ id: "h9", color: "important", text: "fox", prefix: "brown ", suffix: " jumps", start: 16, annotations: [], createdAt: T0, updatedAt: T0 });
    expect(parseDocFile(file([h])).highlights).toEqual([h]);
  });

  it("applies every edit the card makes", () => {
    let doc: DocFile = { version: 1, title: "Doc", highlights: [] };
    const h = newHighlight({ text: "fox", prefix: "", suffix: "", start: 0 }, "important", "h1", T0);
    doc = applyEdit(doc, { kind: "add", highlight: h }, T0);
    doc = applyEdit(doc, { kind: "recolor", id: "h1", color: "disagree" }, T1);
    expect(doc.highlights[0]).toMatchObject({ color: "disagree", updatedAt: T1 });
    doc = applyEdit(doc, { kind: "addNote", id: "h1", note: newNote("  first  ", "n1", T1) }, T1);
    doc = applyEdit(doc, { kind: "addNote", id: "h1", note: newNote("second", "n2", T1) }, T1);
    doc = applyEdit(doc, { kind: "editNote", id: "h1", noteId: "n1", body: "edited" }, T1);
    doc = applyEdit(doc, { kind: "removeNote", id: "h1", noteId: "n2" }, T1);
    expect(doc.highlights[0].annotations.map((a) => a.body)).toEqual(["edited"]);
    doc = applyEdit(doc, { kind: "editNote", id: "h1", noteId: "n1", body: "   " }, T1);
    expect(doc.highlights[0].annotations, "an emptied note is removed").toEqual([]);
    doc = applyEdit(doc, { kind: "remove", id: "h1" }, T1);
    expect(doc.highlights).toEqual([]);
  });
});
