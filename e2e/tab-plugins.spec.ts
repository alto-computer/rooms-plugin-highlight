/*
 * Lane spec for the Highlights tab (F2-7): the built plugin from HIGHLIGHT_DIST against an
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

async function installHighlight(daemon: Daemon) {
  const dest = path.join(daemon.home, ".rooms", "plugins", "highlight");
  await fs.cp(DIST, dest, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
  const appVersion = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")).version;
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, minAppVersion: appVersion }));
}

async function turnOn(page: Page) {
  const card = page.getByRole("dialog", { name: "New plugin: Highlights" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Can read the text of artifacts");
  await expect(card).toContainText("Can see your rooms and artifacts");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
}

const docFrame = (page: Page, title: string): FrameLocator => page.frameLocator(`iframe[title="${title}"]:not([aria-hidden])`);
const tabFrame = (page: Page) => page.frameLocator('xpath=//iframe[@title="Highlights"][not(ancestor::*[@data-background-frames])]');
const tabNamed = (page: Page, name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name, exact: true });

async function openDoc(page: Page, room: string, title: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room }).click();
  const button = page.getByTestId("artifact-card").filter({ hasText: title }).getByRole("button", { name: title });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

async function openTab(page: Page) {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Highlights" }).click();
  await expect(tabNamed(page, "Highlights")).toHaveAttribute("aria-selected", "true");
  await expect(tabFrame(page).getByRole("heading", { name: "Highlights", level: 1 })).toBeVisible();
}

async function highlight(page: Page, doc: FrameLocator, selector: string, action: string) {
  await doc.locator(selector).click({ clickCount: 3 });
  const bar = page.getByRole("toolbar", { name: "Selection actions" });
  await bar.getByRole("button", { name: action, exact: true }).click();
  await expect(bar).toBeHidden();
}

/** Each painted range's text, by highlight name, read inside the document. */
const paint = (doc: FrameLocator) =>
  doc.locator("html").evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, h] of CSS.highlights) out[name] = [...(h as Highlight)].map((r) => (r as Range).toString().trim());
    return out;
  });

async function fileKeyOf(daemon: Daemon, room: string, title: string): Promise<string> {
  const [r] = (await daemon.listRooms()).filter((x) => x.name === room);
  const res = await fetch(`${daemon.baseUrl}/v1/rooms/${r.id}/artifacts`, { headers: { authorization: `Bearer ${daemon.token}` } });
  return ((await res.json()) as { title: string; fileKey: string }[]).find((a) => a.title === title)!.fileKey;
}

const DATA = ".rooms/plugins/highlight/data";
const filler = Array.from({ length: 60 }, (_, i) => `<p>Filler paragraph ${i + 1} about nothing in particular.</p>`).join("");
const FOX = `<!doctype html><html><head><meta charset="utf-8"><title>Fox</title>
<style>body{font:18px/1.6 system-ui;padding:40px;max-width:760px}</style></head><body>
<p id="top">The quick brown fox jumps over the lazy dog.</p>${filler}
<p id="bottom">Far down the page the fox finally rests.</p></body></html>`;
const owl = (line: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Owl</title></head><body><p id="text">${line}</p></body></html>`;
const T = "2026-10-09T00:00:00.000Z";
const FORGED = {
  version: 1,
  title: "<img src=x onerror=parent.__pwned=1>",
  highlights: [
    { id: "forged", color: "idk", text: "<img src=x onerror=parent.__pwned=1>", prefix: "", suffix: "", start: -1, annotations: [{ id: "n", body: "<script>parent.__pwned=1</script>", createdAt: T }], createdAt: T },
  ],
};
const MEMO = `<!doctype html><html><head><meta charset="utf-8"><title>Memo</title></head><body><p>A memo.</p><script>
parent.postMessage({ rooms: "content", v: 1, plugin: "highlight", type: "storage.write", id: "forge", path: "highlights.json", text: ${JSON.stringify(JSON.stringify(FORGED)).replaceAll("</", "<\\/")} }, "*");
</script></body></html>`;

test("the Highlights tab lists, filters and searches every document's highlights, and jumps to one", async ({ page, daemon, browserName }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await daemon.createRoom("Bench");
  await daemon.createRoom("Research");
  await daemon.write("Bench/fox.html", FOX);
  await daemon.write("Bench/owl.html", owl("Owls see well at night and sleep by day."));
  await daemon.write("Research/memo.html", MEMO);
  await installHighlight(daemon);
  await page.goto("/");
  await turnOn(page);

  await openDoc(page, "Bench", "Fox");
  const fox = docFrame(page, "Fox");
  await expect(fox.locator("rooms-highlight-ui")).toBeAttached();
  await highlight(page, fox, "#top", "Agree");
  await fox.locator("#bottom").scrollIntoViewIfNeeded();
  await highlight(page, fox, "#bottom", "DisAgree");
  const foxKey = await fileKeyOf(daemon, "Bench", "Fox");
  await expect.poll(async () => JSON.parse(await daemon.read(`${DATA}/docs/${foxKey}/highlights.json`).catch(() => "{}")).highlights?.length ?? 0).toBe(2);

  await openDoc(page, "Bench", "Owl");
  const owlDoc = docFrame(page, "Owl");
  await expect(owlDoc.locator("rooms-highlight-ui")).toBeAttached();
  await highlight(page, owlDoc, "#text", "Highlight + note");
  await expect(owlDoc.locator("rooms-highlight-ui")).toHaveAttribute("data-card-open");
  await page.waitForTimeout(200);
  await page.keyboard.type("check owls at dawn");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const owlKey = await fileKeyOf(daemon, "Bench", "Owl");
  await expect.poll(async () => JSON.parse(await daemon.read(`${DATA}/docs/${owlKey}/highlights.json`).catch(() => "{}")).highlights?.[0]?.annotations?.length ?? 0).toBe(1);

  await openDoc(page, "Research", "Memo");
  const memoKey = await fileKeyOf(daemon, "Research", "Memo");
  await expect.poll(async () => JSON.parse(await daemon.read(`${DATA}/docs/${memoKey}/highlights.json`).catch(() => "{}")).highlights?.length ?? 0, "the hostile document forged its record").toBe(1);
  await daemon.write(`${DATA}/docs/zzzz-not-a-doc/highlights.json`, "<b>not json</b>");

  await openTab(page);
  const tab = tabFrame(page);
  await expect(tab.getByRole("heading", { level: 2 })).toHaveText(["Owl", "Fox", "Memo"]);
  await expect(tab.locator(".quote")).toHaveText([
    "Owls see well at night and sleep by day.",
    "Far down the page the fox finally rests.",
    "The quick brown fox jumps over the lazy dog.",
    FORGED.highlights[0].text,
  ]);
  await expect(tab.getByRole("region", { name: "Fox" })).toContainText("Bench");
  await expect(tab.getByRole("region", { name: "Memo" })).toContainText("Research");
  await expect(tab.getByRole("region", { name: "Owl" })).toContainText(/Important · .* · 1 note/);
  await expect(tab.getByText("check owls at dawn")).toBeVisible();
  await expect(tab.getByText("<script>parent.__pwned=1</script>"), "a forged note shows as text").toBeVisible();
  await expect(tab.getByText("1 highlight file could not be read.")).toBeVisible();
  expect(await tab.locator("img, script:not([type=module])").count(), "no stored HTML became elements").toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await page.screenshot({ path: `${SHOTS}/${browserName}-tab-list.png` });

  const colors = tab.getByRole("group", { name: "Filter by color" });
  await colors.getByRole("button", { name: /DisAgree/ }).click();
  await expect(tab.locator(".quote")).toHaveText(["Far down the page the fox finally rests."]);
  await page.screenshot({ path: `${SHOTS}/${browserName}-tab-filter.png` });
  await colors.getByRole("button", { name: /^All/ }).click();
  await tab.getByRole("searchbox", { name: "Search highlights" }).fill("dawn");
  await expect(tab.locator(".quote")).toHaveText(["Owls see well at night and sleep by day."]);
  await tab.getByRole("searchbox", { name: "Search highlights" }).fill("");
  await expect(tab.locator(".quote")).toHaveCount(4);

  await tab.getByRole("button", { name: /Far down the page/ }).click();
  await expect(tabNamed(page, "Fox"), "the doc opens next to the tab").toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toContainText(["Highlights", "Fox"]);
  const t0 = Date.now();
  await expect.poll(async () => (await paint(fox))["rooms-hl-flash"], { message: "the highlight flashes" }).toEqual(["Far down the page the fox finally rests."]);
  console.log(`[lane] ${browserName} click to flash: ${Date.now() - t0} ms after the tab became active`);
  const inView = await fox.locator("#bottom").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: innerHeight, scrolled: scrollY };
  });
  expect(inView.scrolled, "the document scrolled").toBeGreaterThan(0);
  expect(inView.top).toBeGreaterThanOrEqual(0);
  expect(inView.bottom).toBeLessThanOrEqual(inView.height);
  await page.screenshot({ path: `${SHOTS}/${browserName}-tab-jump-flash.png` });
  await expect.poll(async () => (await paint(fox))["rooms-hl-flash"] ?? [], { message: "the flash ends", timeout: 3000 }).toEqual([]);
  expect((await paint(fox))["rooms-hl-disagree"], "the paint stays").toEqual(["Far down the page the fox finally rests."]);

  await daemon.write("Bench/owl.html", owl("This page was rewritten and the old sentence is gone."));
  await tabNamed(page, "Highlights").click();
  await tab.getByRole("button", { name: /Owls see well/ }).click();
  await expect(tabNamed(page, "Owl")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => daemon.read(`${DATA}/docs/${owlKey}/orphans.json`).catch(() => ""), "the document reports the lost text").toMatch(/^\["[0-9a-f]{24}"\]$/);
  await tabNamed(page, "Highlights").click();
  await expect(tab.getByRole("region", { name: "Owl" })).toContainText("Text not found");
  await expect(tab.getByRole("region", { name: "Fox" })).not.toContainText("Text not found");
  await page.screenshot({ path: `${SHOTS}/${browserName}-tab-orphan.png` });

  await fs.rm(path.join(daemon.home, "Research", "memo.html"));
  await expect.poll(async () => {
    await tabNamed(page, "Fox").click();
    await tabNamed(page, "Highlights").click();
    return tab.getByRole("region", { name: /pwned|Memo/ }).textContent({ timeout: 2000 }).catch(() => "");
  }, { message: "a document no room links shows as removed", timeout: 15000 }).toContain("Doc removed");
  const tabsBefore = await page.getByRole("tablist", { name: "Tabs" }).getByRole("tab").count();
  await tab.locator(".hl.inert").first().click();
  await page.waitForTimeout(500);
  expect(await page.getByRole("tablist", { name: "Tabs" }).getByRole("tab").count(), "a removed doc's row opens nothing").toBe(tabsBefore);

  for (const width of [900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const cut = await tab.locator("body").evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(cut, `nothing cut at ${width} px`).toBe(false);
    await page.screenshot({ path: `${SHOTS}/${browserName}-tab-${width}.png` });
  }
  expect(errors.filter(ownError), "no errors").toEqual([]);
});

/**
 * Runs in every frame before its own scripts. Chromium reports long tasks; WebKit has no longtask
 * entry type, so there a frame that comes over 100 ms after the one before counts as one.
 */
function watchLongTasks() {
  const tasks: { start: number; duration: number }[] = [];
  (window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) tasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
    return;
  }
  let last = performance.now();
  const frame = (t: number) => {
    if (t - last > 100) tasks.push({ start: last, duration: t - last });
    last = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

type RenderRun = { bootMs: number; collectMs: number; commitMs: number; paintMs: number; listMs: number; longestMs: number; watch: string; rows: number; domRows: number };

/** The tab's own marks from connect() to the first painted list, then long tasks from connect() through a scroll to the end. */
const measureRender = (tab: FrameLocator, clickedAt: number): Promise<RenderRun> =>
  tab.locator("body").evaluate(async (body, clickedAt) => {
    const at = (name: string) => performance.getEntriesByName(name)[0].startTime;
    const list = body.querySelector(".list")!;
    for (let y = 0; y < list.scrollHeight; y += 2000) {
      list.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 200));
    const connected = at("rooms-highlight:connected");
    const tasks = (window as unknown as { __longTasks: { start: number; duration: number }[] }).__longTasks.filter((t) => t.start + t.duration > connected);
    return {
      bootMs: performance.timeOrigin + connected - clickedAt,
      collectMs: at("rooms-highlight:collected") - connected,
      commitMs: at("rooms-highlight:listed") - at("rooms-highlight:collected"),
      paintMs: at("rooms-highlight:painted") - at("rooms-highlight:listed"),
      listMs: at("rooms-highlight:painted") - connected,
      longestMs: Math.max(0, ...tasks.map((t) => t.duration)),
      watch: PerformanceObserver.supportedEntryTypes.includes("longtask") ? "long task" : "frame gap",
      rows: Number(body.querySelector(".total")?.textContent),
      domRows: body.querySelectorAll(".hl").length,
    };
  }, clickedAt);

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
const RENDER_RUNS = 7;

test("the tab lists 4,000 highlights across 200 documents within 500 ms and without a long task", async ({ page, daemon, browserName }) => {
  test.setTimeout(180_000);
  await daemon.createRoom("Bench");
  await daemon.write("Bench/one.html", owl("One real document."));
  await installHighlight(daemon);
  const colors = ["important", "agree", "disagree", "idk"];
  for (let d = 0; d < 200; d++) {
    const highlights = Array.from({ length: 20 }, (_, i) => ({
      id: `h${d}-${i}`,
      color: colors[i % 4],
      text: `Document ${d} highlight ${i}: a sentence long enough to wrap onto a second line when the tab is narrow.`,
      prefix: "",
      suffix: "",
      start: -1,
      annotations: i % 5 ? [] : [{ id: `n${d}-${i}`, body: `note ${d}-${i}`, createdAt: T }],
      createdAt: new Date(Date.UTC(2026, 9, 1) + (d * 20 + i) * 60_000).toISOString(),
    }));
    await daemon.write(`${DATA}/docs/doc${String(d).padStart(3, "0")}/highlights.json`, JSON.stringify({ version: 1, title: `Doc ${d}`, highlights }));
  }
  await page.addInitScript(watchLongTasks);
  await page.goto("/");
  await turnOn(page);
  const tab = tabFrame(page);
  const runs: RenderRun[] = [];
  for (let i = 0; i < RENDER_RUNS; i++) {
    await expect(tab.locator("body"), "each run boots a new frame").toHaveCount(0);
    const clickedAt = Date.now();
    await openTab(page);
    await expect.poll(() => tab.locator("body").evaluate(() => performance.getEntriesByName("rooms-highlight:painted").length), { timeout: 15000 }).toBe(1);
    const run = await measureRender(tab, clickedAt);
    console.log(`[lane] ${browserName} run ${i + 1}: ${JSON.stringify(run, (_, v) => (typeof v === "number" ? Math.round(v) : v))}`);
    expect(run.rows).toBe(4000);
    runs.push(run);
    if (i < RENDER_RUNS - 1) await page.getByRole("tablist", { name: "Tabs" }).locator("[role=presentation]", { has: page.getByRole("tab", { name: "Highlights", exact: true }) }).getByRole("button", { name: "Close tab" }).click();
  }
  const listP95 = p95(runs.map((r) => r.listMs));
  const longest = Math.max(...runs.map((r) => r.longestMs));
  console.log(`[lane] ${browserName} ${RENDER_RUNS} runs: list render p95 ${Math.round(listP95)} ms (connect to painted), frame boot p95 ${Math.round(p95(runs.map((r) => r.bootMs)))} ms (click to connect), longest ${runs[0].watch} ${Math.round(longest)} ms`);

  await tab.getByRole("searchbox", { name: "Search highlights" }).fill("note 199-0");
  await expect(tab.locator(".quote")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${browserName}-tab-scale.png` });
  expect(listP95, "p95 list render").toBeLessThanOrEqual(500);
  expect(longest, "longest task during render and scroll").toBeLessThanOrEqual(100);
});
