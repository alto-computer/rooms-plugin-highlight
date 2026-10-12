/*
 * Lane spec for rooms-plugin-highlight (F2-5): the built plugin from HIGHLIGHT_DIST against an
 * alto-rooms checkout's roomsd and web build, copied into its apps/desktop/e2e/lanes/. The file
 * name matches the WebKit project.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, test, type Daemon } from "../fixtures";

const DIST = process.env.HIGHLIGHT_DIST!;
const SHOTS = process.env.HIGHLIGHT_SHOTS ?? "/tmp";
/**
 * Leaves out the app's own errors: a failed load, and the inline styles the app's CSP blocks in its
 * own page (Chromium's and WebKit's wording) since the e2e preview serves that CSP (alto-rooms 75ac1d5).
 */
const ownError = (e: string) =>
  !e.includes("Failed to load resource") && !e.startsWith("Applying inline style violates") && !e.startsWith("Refused to apply a stylesheet because its hash");
const SWATCHES = ["Important", "Agree", "DisAgree", "IDK"];

async function installHighlight(daemon: Daemon) {
  const dest = path.join(daemon.home, ".rooms", "plugins", "highlight");
  await fs.cp(DIST, dest, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
  // This checkout is 0.6.0; the plugin asks for the first release with the content channel.
  const appVersion = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")).version;
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, minAppVersion: appVersion }));
}

async function turnOn(page: Page) {
  const card = page.getByRole("dialog", { name: "New plugin: Highlights" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Can read the text of artifacts");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}

const docFrame = (page: Page, title: string): FrameLocator => page.frameLocator(`iframe[title="${title}"]:not([aria-hidden])`);

async function openDoc(page: Page, title: string) {
  if (!(await page.getByRole("tab", { name: "Bench", selected: true }).isVisible())) {
    await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: "Bench" }).click();
  }
  const button = page.getByTestId("artifact-card").filter({ hasText: title }).getByRole("button", { name: title });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

/** Each painted range's text, by highlight name, read inside the document. */
const paint = (doc: FrameLocator) =>
  doc.locator("html").evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, h] of CSS.highlights) out[name] = [...(h as Highlight)].map((r) => (r as Range).toString());
    return out;
  });

async function fileKeyOf(daemon: Daemon, title: string): Promise<string> {
  const [r] = (await daemon.listRooms()).filter((x) => x.name === "Bench");
  const res = await fetch(`${daemon.baseUrl}/v1/rooms/${r.id}/artifacts`, { headers: { authorization: `Bearer ${daemon.token}` } });
  return ((await res.json()) as { title: string; fileKey: string }[]).find((a) => a.title === title)!.fileKey;
}

const stored = async (daemon: Daemon, key: string) => JSON.parse(await daemon.read(`.rooms/plugins/highlight/data/docs/${key}/highlights.json`));

const DOC = `<!doctype html><html><head><meta charset="utf-8"><title>Fox</title>
<style>body{font:20px/1.6 system-ui;padding:40px;max-width:760px}</style></head><body>
<h1>Fox</h1>
<p id="text">The quick brown fox jumps over the lazy dog near the river bank.</p>
<ul><li id="li">A list item that must not move.</li></ul>
<section id="live"><p>Loading…</p></section>
<script>
window.render = () => { document.getElementById("live").innerHTML = '<p class="item">Rendered paragraph talks about state.</p>'; };
render();
</script>
</body></html>`;

test("select, pick a color in the bar, paint, reload, restore", async ({ page, daemon, browserName }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await daemon.createRoom("Bench");
  await daemon.write("Bench/fox.html", DOC);
  await installHighlight(daemon);
  await page.goto("/");
  await turnOn(page);
  await openDoc(page, "Fox");
  const doc = docFrame(page, "Fox");
  await expect(doc.locator("rooms-highlight-ui"), "the content script ran").toBeAttached();
  const bodyBefore = await doc.locator("body").evaluate((b) => b.innerHTML);
  const liBox = await doc.locator("#li").boundingBox();

  await doc.locator("#text").click({ clickCount: 3 });
  const bar = page.getByRole("toolbar", { name: "Selection actions" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText(["Ask", ...SWATCHES, "Highlight + note"]);
  await page.screenshot({ path: `${SHOTS}/${browserName}-1-bar.png` });
  await bar.getByRole("button", { name: "Agree", exact: true }).click();
  await expect(bar).toBeHidden();
  const sentence = "The quick brown fox jumps over the lazy dog near the river bank.";
  await expect.poll(async () => (await paint(doc))["rooms-hl-agree"]?.map((t) => t.trim())).toEqual([sentence]);
  await page.screenshot({ path: `${SHOTS}/${browserName}-2-painted.png` });

  const key = await fileKeyOf(daemon, "Fox");
  await expect.poll(async () => (await stored(daemon, key).catch(() => null))?.highlights?.length ?? 0).toBe(1);
  const file = await stored(daemon, key);
  expect(file).toMatchObject({ version: 1, title: "Fox" });
  expect(file.highlights[0]).toMatchObject({ color: "agree", annotations: [] });
  expect(file.highlights[0].text.trim()).toBe(sentence);
  expect(await doc.locator("body").evaluate((b) => b.innerHTML), "paint changes no DOM").toBe(bodyBefore);
  expect(await doc.locator("#li").boundingBox(), "paint moves no layout").toEqual(liBox);

  await doc.locator("li").click({ clickCount: 3 });
  await bar.getByRole("button", { name: "Important" }).click();
  await expect.poll(async () => (await paint(doc))["rooms-hl-important"]?.map((t) => t.trim())).toEqual(["A list item that must not move."]);
  await expect.poll(async () => (await stored(daemon, key)).highlights.length).toBe(2);

  await page.reload();
  await openDoc(page, "Fox");
  await expect.poll(async () => {
    const p = await paint(doc);
    return [p["rooms-hl-agree"]?.map((t) => t.trim()), p["rooms-hl-important"]?.map((t) => t.trim())];
  }, { message: "both highlights restored after reload" }).toEqual([[sentence], ["A list item that must not move."]]);
  await page.screenshot({ path: `${SHOTS}/${browserName}-3-restored.png` });

  await doc.locator(".item").click({ clickCount: 3 });
  await bar.getByRole("button", { name: "IDK" }).click();
  await expect.poll(async () => (await paint(doc))["rooms-hl-idk"]?.map((t) => t.trim())).toEqual(["Rendered paragraph talks about state."]);
  const t0 = Date.now();
  await doc.locator("html").evaluate(() => (window as unknown as { render(): void }).render());
  await expect.poll(async () => (await paint(doc))["rooms-hl-idk"]?.map((t) => t.trim()), { message: "a late re-render is painted again", timeout: 2000 }).toEqual([
    "Rendered paragraph talks about state.",
  ]);
  const repaintMs = Date.now() - t0;
  console.log(`[lane] ${browserName} repaint after re-render: ${repaintMs} ms`);
  expect(repaintMs).toBeLessThan(1000);

  await doc.locator("h1").click({ clickCount: 3 });
  await bar.getByRole("button", { name: "Highlight + note" }).click();
  await expect.poll(async () => (await paint(doc))["rooms-hl-idk"]?.length, { message: "Highlight + note paints in the last color" }).toBe(2);
  const ui = doc.locator("rooms-highlight-ui");
  await expect(ui, "Highlight + note opens the card").toHaveAttribute("data-card-open");
  await page.waitForTimeout(200);
  await page.keyboard.type("Check the fox");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect.poll(async () => (await stored(daemon, key)).highlights.find((h: { text: string }) => h.text.trim() === "Fox")?.annotations.map((a: { body: string }) => a.body)).toEqual(["Check the fox"]);
  await page.screenshot({ path: `${SHOTS}/${browserName}-5-card-note.png` });
  await page.keyboard.press("Escape");
  await expect(ui, "Escape closes the card").not.toHaveAttribute("data-card-open");
  await doc.locator("#text").click({ position: { x: 40, y: 10 } });
  await expect(ui, "clicking a highlight opens its card").toHaveAttribute("data-card-open");
  await page.screenshot({ path: `${SHOTS}/${browserName}-6-card-click.png` });
  expect(await doc.locator("body").evaluate((b) => /<mark|rooms-highlight/i.test(b.innerHTML)), "nothing of the plugin in body").toBe(false);
  expect(errors.filter(ownError), "no errors").toEqual([]);
});

test("a hostile document can forge only its own record, which the plugin reads as untrusted", async ({ page, daemon, browserName }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const T = "2026-10-09T00:00:00.000Z";
  const forged = {
    version: 1,
    title: "<img src=x onerror=parent.__pwned=1>",
    highlights: [
      { id: "good", color: "disagree", text: "hostile but real text", prefix: "", suffix: "", start: -1, annotations: [{ id: "n", body: "<script>parent.__pwned=1</script>", createdAt: T }], createdAt: T },
      { id: "badcolor", color: "url(javascript:alert(1))", text: "hostile", prefix: "", suffix: "", start: 0, annotations: [], createdAt: T },
      { id: "huge", color: "idk", text: "x".repeat(10_000), prefix: "", suffix: "", start: 0, annotations: [], createdAt: T },
      { id: "proto", color: "__proto__", text: "hostile", annotations: [], createdAt: T },
      { id: 5, color: "agree", text: "hostile", createdAt: T },
    ],
  };
  await daemon.createRoom("Bench");
  await daemon.write(
    "Bench/hostile.html",
    `<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title></head><body><p id="text">This is hostile but real text in a page.</p><script>
const send = (m) => parent.postMessage({ rooms: "content", v: 1, plugin: "highlight", ...m }, "*");
send({ type: "storage.write", id: "forge", path: "highlights.json", text: ${JSON.stringify(JSON.stringify(forged)).replaceAll("</", "<\\/")} });
send({ type: "storage.write", id: "escape", path: "../other/highlights.json", text: "{}" });
// The plugin's listener trusts only window.parent, so this fake click on a swatch does nothing.
window.postMessage({ rooms: "content", v: 1, plugin: "highlight", type: "selection.action", actionId: "agree" }, "*");
</script></body></html>`,
  );
  await installHighlight(daemon);
  await page.goto("/");
  await turnOn(page);
  await openDoc(page, "Hostile");
  const doc = docFrame(page, "Hostile");
  await expect(doc.locator("rooms-highlight-ui")).toBeAttached();
  const key = await fileKeyOf(daemon, "Hostile");
  await expect.poll(async () => (await stored(daemon, key).catch(() => null))?.highlights?.length).toBe(5);

  await page.reload();
  await openDoc(page, "Hostile");
  await expect.poll(async () => await paint(doc), { message: "only the well-formed highlight paints" }).toMatchObject({ "rooms-hl-disagree": ["hostile but real text"] });
  const p = await paint(doc);
  expect(Object.entries(p).filter(([, v]) => v.length).map(([k]) => k)).toEqual(["rooms-hl-disagree"]);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await doc.locator("html").evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const dir = path.join(daemon.home, ".rooms", "plugins", "highlight", "data");
  const files = (await fs.readdir(dir, { recursive: true })).map(String).filter((f) => f.endsWith(".json"));
  expect(files, "the escape stayed in this document's folder or failed").toEqual([`docs/${key}/highlights.json`]);
  expect((await stored(daemon, key)).highlights.length, "the fake selection.action wrote nothing").toBe(5);
  await page.screenshot({ path: `${SHOTS}/${browserName}-4-hostile.png` });

  await doc.locator("#text").click({ clickCount: 3 });
  await page.getByRole("toolbar", { name: "Selection actions" }).getByRole("button", { name: "Agree", exact: true }).click();
  await expect.poll(async () => (await stored(daemon, key)).highlights.map((h: { id: string }) => h.id), { message: "the next save rewrites the record with only parsed entries" }).toHaveLength(2);
  const saved = await stored(daemon, key);
  expect(saved.highlights[0].id).toBe("good");
  expect(saved.highlights[1].color).toBe("agree");
  expect(errors.filter(ownError), "no errors").toEqual([]);
});
