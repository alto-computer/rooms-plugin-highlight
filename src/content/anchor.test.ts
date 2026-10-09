import { beforeEach, describe, expect, it } from "vitest";
import { buildIndex, locate, quoteOf, rangeAt } from "./anchor";

const FOX = "The quick brown fox jumps over the lazy dog near the river bank.";
const ABOVE = "A brand new paragraph inserted above everything else, long enough to shift offsets.";

function setBody(html: string) {
  document.body.innerHTML = html;
}

/** Selects `text` in the body, as a reader's drag would, and returns the quote. */
function quote(text: string) {
  const index = buildIndex(document.body);
  const at = index.text.indexOf(text);
  const range = rangeAt(index, at, at + text.length)!;
  return quoteOf(buildIndex(document.body), range)!;
}

/** Where the quote lands in the current body, as the text the range covers. */
function anchorIn(q: ReturnType<typeof quote>) {
  const index = buildIndex(document.body);
  const at = locate(index.text, q);
  return { status: at.status, text: at.status === "orphan" ? null : rangeAt(index, at.start, at.end)!.toString() };
}

describe("anchoring", () => {
  beforeEach(() => setBody(`<h1>Fox</h1><p>${FOX}</p>`));

  it("captures 40 characters of context and the start offset", () => {
    const q = quote("quick brown fox jumps over");
    expect(q.text).toBe("quick brown fox jumps over");
    expect(q.prefix).toBe("FoxThe ");
    expect(q.suffix).toBe(" the lazy dog near the river bank.");
    expect(q.start).toBe(7);
    setBody(`<p>${"x".repeat(100)}</p><p>${FOX}${"y".repeat(100)}</p>`);
    const long = quote("brown");
    expect(long.prefix).toHaveLength(40);
    expect(long.suffix).toHaveLength(40);
  });

  it("finds unchanged text at its start offset", () => {
    const q = quote("quick brown fox jumps over");
    expect(anchorIn(q)).toEqual({ status: "exact", text: "quick brown fox jumps over" });
  });

  it("finds text that moved when a paragraph was inserted above it", () => {
    const q = quote("quick brown fox jumps over");
    setBody(`<p>${ABOVE}</p><h1>Fox</h1><p>${FOX}</p>`);
    expect(anchorIn(q)).toEqual({ status: "moved", text: "quick brown fox jumps over" });
  });

  it("finds text whose words changed, between its unchanged context", () => {
    const q = quote("quick brown fox jumps over");
    setBody(`<p>${ABOVE}</p><h1>Fox</h1><p>${FOX.replace("fox", "cat")}</p>`);
    expect(anchorIn(q)).toEqual({ status: "fuzzy", text: "quick brown cat jumps over" });
  });

  it("reports an orphan when the text was rewritten", () => {
    const q = quote("quick brown fox jumps over");
    setBody("<p>Totally different words now stand in this place entirely, nothing kept.</p>");
    expect(anchorIn(q)).toEqual({ status: "orphan", text: null });
  });

  it("picks the occurrence whose context matches when the text repeats", () => {
    setBody("<p>alpha one beta</p><p>gamma one delta</p>");
    const q = quote("gamma one");
    const second = { ...q, text: "one", prefix: "gamma ", suffix: " delta", start: -1 };
    const index = buildIndex(document.body);
    const at = locate(index.text, second);
    expect(at.status === "moved" && index.text.slice(at.start - 6, at.start)).toBe("gamma ");
  });

  it("anchors two highlights in one text node independently", () => {
    const a = quote("quick brown");
    const b = quote("lazy dog");
    const index = buildIndex(document.body);
    const ra = locate(index.text, a);
    const rb = locate(index.text, b);
    expect([ra.status, rb.status]).toEqual(["exact", "exact"]);
    const textNodes = document.body.querySelectorAll("p")[0].childNodes;
    expect(textNodes).toHaveLength(1);
  });

  it("anchors a highlight that crosses elements", () => {
    setBody("<ul><li>first item ends here</li><li>second item starts here</li></ul>");
    const q = quote("ends heresecond item");
    expect(anchorIn(q)).toEqual({ status: "exact", text: "ends heresecond item" });
    setBody("<p>new intro</p><ul><li>first item ends here</li><li>second item starts here</li></ul>");
    expect(anchorIn(q)).toEqual({ status: "moved", text: "ends heresecond item" });
  });

  it("indexes no script, style or textarea text", () => {
    setBody("<p>visible</p><script>var hidden = 1</script><style>p{}</style><textarea>typed</textarea><p>after</p>");
    expect(buildIndex(document.body).text).toBe("visibleafter");
  });

  it("measures a selection whose ends sit on elements, not text", () => {
    setBody("<p>one</p><p>two</p><p>three</p>");
    const r = document.createRange();
    r.setStart(document.body, 1);
    r.setEnd(document.body, 2);
    expect(quoteOf(buildIndex(document.body), r)).toMatchObject({ text: "two", prefix: "one", suffix: "three", start: 3 });
  });

  it("refuses a selection with no visible text", () => {
    setBody("<p>a</p><p>   </p><p>b</p>");
    const r = document.createRange();
    r.selectNodeContents(document.body.children[1]);
    expect(quoteOf(buildIndex(document.body), r)).toBeNull();
  });
});
