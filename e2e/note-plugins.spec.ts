/*
 * Lane spec for note highlights (F2-11): the built plugin from HIGHLIGHT_DIST against an
 * alto-rooms checkout's roomsd and web build, copied into its apps/desktop/e2e/lanes/. The file
 * name matches the WebKit project.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { surfacePath, type SurfaceId } from "../../../../packages/plugin-sdk/src/surfaces";
import { expect, test, today, type Daemon } from "../fixtures";

const DIST = process.env.HIGHLIGHT_DIST!;
const SHOTS = process.env.HIGHLIGHT_SHOTS ?? "/tmp";
const DATA = ".rooms/plugins/highlight/data";
const COLOR = {
  important: "rgba(199, 154, 62, 0.28)",
  agree: "rgba(122, 153, 113, 0.26)",
  disagree: "rgba(190, 114, 87, 0.24)",
  idk: "rgba(142, 132, 160, 0.26)",
};
const PLAN = ["Ship the cache fix on Friday.", "Then warm it after the batch job.", "Ask Mina about the night graphs.", "Keep the old flag one more week."].join("\n");

async function installHighlight(daemon: Daemon) {
  const dest = path.join(daemon.home, ".rooms", "plugins", "highlight");
  await fs.cp(DIST, dest, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
  const appVersion = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")).version;
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, minAppVersion: appVersion }));
}

async function start(page: Page, daemon: Daemon) {
  await installHighlight(daemon);
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "New plugin: Highlights" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Can read and mark chat answers and notes");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => page.frame({ url: /\/_plugins\/highlight\/background\.html/ }) !== null).toBe(true);
}

const tabNamed = (page: Page, name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name, exact: true });
const tabFrame = (page: Page): FrameLocator => page.frameLocator('xpath=//iframe[@title="Highlights"][not(ancestor::*[@data-background-frames])]');
const bar = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note" });

async function openNote(page: Page, title: string) {
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await page.getByRole("region", { name: "Your day" }).getByRole("button", { name: title }).click();
  await expect(tabNamed(page, title)).toHaveAttribute("aria-selected", "true");
  await expect(editor(page)).not.toHaveValue("");
}

async function openHighlights(page: Page) {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Highlights" }).click();
  await expect(tabNamed(page, "Highlights")).toHaveAttribute("aria-selected", "true");
  await expect(tabFrame(page).getByRole("heading", { name: "Highlights", level: 1 })).toBeVisible();
}

/** Selects `words` in the note from the keyboard, so the bar reads the selection on key up. */
async function select(page: Page, words: string) {
  const start = (await editor(page).inputValue()).indexOf(words);
  expect(start, `"${words}" is in the note`).toBeGreaterThanOrEqual(0);
  await editor(page).click();
  await editor(page).evaluate((el: HTMLTextAreaElement, s) => el.setSelectionRange(s, s), start);
  for (let i = 0; i < words.length; i++) await page.keyboard.press("Shift+ArrowRight");
}

async function highlight(page: Page, words: string, color: string) {
  await select(page, words);
  await expect(bar(page).getByRole("button")).toHaveText(["Important", "Agree", "DisAgree", "IDK"]);
  await bar(page).getByRole("button", { name: color, exact: true }).click();
  await expect(bar(page)).toBeHidden();
}

/** The text of every range painted under `rooms-highlight-<style>`, or under `name` as given. */
const painted = (page: Page, style: string) =>
  page.evaluate((n) => {
    const h = CSS.highlights.get(n);
    return h ? Array.from(h as unknown as Iterable<Range>, (r) => r.toString()) : [];
  }, style.startsWith("rooms-") ? style : `rooms-highlight-${style}`);

const paintColor = (page: Page, style: string) =>
  page.locator("[data-note-backdrop]").evaluate((el, n) => getComputedStyle(el, `::highlight(${n})`).backgroundColor, `rooms-highlight-${style}`);

async function clickPainted(page: Page, style: string) {
  // The words stay selected after a color is picked, and a click inside a selection reaches the app's mouseup before
  // the caret collapses, so the app reads it as a selection, not a click on the range: start from a caret elsewhere.
  await editor(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  const at = await page.evaluate((n) => {
    const [r] = Array.from(CSS.highlights.get(n) as unknown as Iterable<Range>);
    const box = r.getClientRects()[0];
    return { x: box.left + Math.min(10, box.width / 2), y: box.top + box.height / 2 };
  }, `rooms-highlight-${style}`);
  await page.mouse.click(at.x, at.y);
}

type HighlightFile = { title: string; highlights: { id: string; color: string; text: string; annotations: { body: string }[] }[] };

const noteFile = (date: string, name: string) => `${surfacePath({ kind: "note", date, name } satisfies SurfaceId)}.json`;

async function stored(daemon: Daemon): Promise<Record<string, HighlightFile | string[]>> {
  const dir = path.join(daemon.home, DATA);
  const out: Record<string, HighlightFile | string[]> = {};
  for (const sub of ["note", "answer"]) {
    const root = path.join(dir, sub);
    if (!(await fs.stat(root).catch(() => null))) continue;
    for (const f of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) out[path.relative(dir, path.join(f.parentPath, f.name))] = JSON.parse(await fs.readFile(path.join(f.parentPath, f.name), "utf8"));
    }
  }
  return out;
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, name) });

test("a note takes the four document colors behind its text, lists under Notes with the day, and jumps back", async ({ page, daemon }) => {
  const date = today();
  await daemon.saveNote(date, "Plan.md", PLAN);
  await start(page, daemon);
  await openNote(page, "Plan");

  await highlight(page, "Ship the cache fix", "Important");
  await highlight(page, "warm it", "Agree");
  await highlight(page, "night graphs", "DisAgree");
  await highlight(page, "old flag", "IDK");
  for (const [style, words] of [["important", "Ship the cache fix"], ["agree", "warm it"], ["disagree", "night graphs"], ["idk", "old flag"]] as const) {
    await expect.poll(() => painted(page, style)).toEqual([words]);
    expect(await paintColor(page, style), `the document's ${style} color`).toBe(COLOR[style]);
  }
  await expect(editor(page), "the text is the user's own").toHaveValue(PLAN);
  expect(await daemon.read(`journal/${date}/Plan.md`), "a highlight never writes the note").toBe(PLAN);
  const file = (await stored(daemon))[noteFile(date, "Plan.md")] as HighlightFile;
  expect(file.title).toBe("Plan.md");
  expect(file.highlights.map((h) => [h.color, h.text])).toEqual([
    ["important", "Ship the cache fix"],
    ["agree", "warm it"],
    ["disagree", "night graphs"],
    ["idk", "old flag"],
  ]);
  await shot(page, "notehl-colors.png");

  await openHighlights(page);
  const group = tabFrame(page).getByRole("region", { name: "Plan" });
  await expect(group.locator(".doc-where")).toHaveText(/^Notes · /);
  await expect(group.locator(".quote")).toHaveText(["old flag", "night graphs", "warm it", "Ship the cache fix"]);
  await shot(page, "notehl-tab.png");

  await group.getByText("warm it").click();
  await expect(tabNamed(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 5000, intervals: [25] }).toEqual(["warm it"]);
  await shot(page, "notehl-regression.png");
});

test("typing above a note highlight keeps it on its words; deleting them leaves it lost in the tab; a reload paints again", async ({ page, daemon }) => {
  const date = today();
  await daemon.saveNote(date, "Plan.md", PLAN);
  await start(page, daemon);
  await openNote(page, "Plan");
  await highlight(page, "warm it", "Agree");
  await expect.poll(() => painted(page, "agree")).toEqual(["warm it"]);

  await editor(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await page.keyboard.type("Standup notes, warm room.\n");
  await expect.poll(() => painted(page, "agree"), "on its words while typing and after the debounce").toEqual(["warm it"]);
  await page.waitForTimeout(600);
  expect(await painted(page, "agree")).toEqual(["warm it"]);
  await shot(page, "notehl-webkit.png");
  await expect.poll(() => daemon.read(`journal/${date}/Plan.md`), { timeout: 5000 }).toBe(`Standup notes, warm room.\n${PLAN}`);

  await page.reload();
  await expect(editor(page)).toHaveValue(`Standup notes, warm room.\n${PLAN}`);
  await expect.poll(() => painted(page, "agree"), "repainted from storage").toEqual(["warm it"]);

  const text = await editor(page).inputValue();
  const at = text.indexOf("warm it");
  await editor(page).click();
  await editor(page).evaluate((el: HTMLTextAreaElement, [s, e]) => el.setSelectionRange(s, e), [at, at + "warm it".length]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => painted(page, "agree")).toEqual([]);
  const orphans = `${noteFile(date, "Plan.md").replace(/\.json$/, "")}.orphans`;
  await expect.poll(async () => (await stored(daemon))[orphans]).toHaveLength(1);

  await openHighlights(page);
  const row = tabFrame(page).locator(".hl", { hasText: "warm it" });
  await expect(row).toContainText("Text not found");
  await shot(page, "notehl-orphan.png");
});

test("renaming a note keeps its highlights, under the new name in the tab", async ({ page, daemon }) => {
  const date = today();
  await daemon.saveNote(date, "Plan.md", PLAN);
  await start(page, daemon);
  await openNote(page, "Plan");
  await highlight(page, "night graphs", "Important");
  await expect.poll(() => painted(page, "important")).toEqual(["night graphs"]);

  await page.getByRole("heading", { level: 1, name: "Plan" }).click();
  const title = page.getByRole("textbox", { name: "Note name" });
  await title.fill("Launch plan");
  await title.press("Enter");
  await expect(tabNamed(page, "Launch plan")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => painted(page, "important"), "the paint is back under the new name").toEqual(["night graphs"]);
  await expect.poll(async () => Object.keys(await stored(daemon))).toEqual([noteFile(date, "Launch plan.md")]);
  expect(((await stored(daemon))[noteFile(date, "Launch plan.md")] as HighlightFile).title).toBe("Launch plan.md");

  await openHighlights(page);
  await expect(tabFrame(page).getByRole("region", { name: "Launch plan" }).locator(".quote")).toHaveText(["night graphs"]);
  await shot(page, "notehl-rename.png");
});

test("the range menu over a note highlight recolors, deletes, and sends a note to the tab", async ({ page, daemon }) => {
  const date = today();
  await daemon.saveNote(date, "Plan.md", PLAN);
  await start(page, daemon);
  await openNote(page, "Plan");
  await highlight(page, "batch job", "Agree");
  await expect.poll(() => painted(page, "agree")).toEqual(["batch job"]);

  await clickPainted(page, "agree");
  await expect(bar(page).getByRole("button")).toHaveText(["Important", "Agree", "DisAgree", "IDK", "Delete", "Add a note in Highlights"]);
  await bar(page).getByRole("button", { name: "IDK", exact: true }).click();
  await expect.poll(() => painted(page, "idk")).toEqual(["batch job"]);
  expect(await painted(page, "agree")).toEqual([]);
  const file = noteFile(date, "Plan.md");
  expect(((await stored(daemon))[file] as HighlightFile).highlights.map((h) => h.color)).toEqual(["idk"]);

  await clickPainted(page, "idk");
  await bar(page).getByRole("button", { name: "Add a note in Highlights" }).click();
  await openHighlights(page);
  const note = tabFrame(page).getByRole("textbox", { name: "New note" });
  await expect(note).toBeFocused();
  await note.fill("Move the job to 3am");
  await tabFrame(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(async () => ((await stored(daemon))[file] as HighlightFile | undefined)?.highlights[0].annotations.map((a) => a.body)).toEqual(["Move the job to 3am"]);

  await openNote(page, "Plan");
  await expect.poll(() => painted(page, "idk")).toEqual(["batch job"]);
  await clickPainted(page, "idk");
  await expect(bar(page).getByRole("button").last()).toHaveText("1 note in Highlights");
  await shot(page, "notehl-menu.png");
  await bar(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => painted(page, "idk")).toEqual([]);
  await expect.poll(async () => Object.keys(await stored(daemon))).toEqual([]);
});

test("a highlight in last week's note opens that note from the tab and flashes; answer files saved by 0.3.0 move and list", async ({ page, daemon }) => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const date = today(d);
  await daemon.saveNote(date, "Retro.md", PLAN);
  const at = PLAN.indexOf("night graphs");
  const record = (id: string, text: string, start: number, title: string) =>
    JSON.stringify({ version: 1, title, highlights: [{ id, color: "agree", text, prefix: "", suffix: "", start, annotations: [], createdAt: `${date}T09:00:00.000Z` }] });
  await daemon.write(path.join(DATA, noteFile(date, "Retro.md")), record("n1", "night graphs", at, "Retro.md"));
  await daemon.write(`${DATA}/answer/doc/k-gone/t1.json`, record("a1", "an answer from 0.3.0", 0, "an answer from 0.3.0"));
  await daemon.write(`${DATA}/answer/conversation/claude/s-1/t2.json`, record("a2", "a session answer from 0.3.0", 0, "a session answer"));
  await start(page, daemon);

  await expect
    .poll(async () => Object.keys(await stored(daemon)).sort(), "the old answer files moved to SDK 0.6's paths")
    .toEqual(["answer/artifact/k-gone/t1.json", "answer/session/claude/s-1/t2.json", noteFile(date, "Retro.md")]);

  await openHighlights(page);
  const tab = tabFrame(page);
  await expect(tab.locator(".hl", { hasText: "an answer from 0.3.0" }).locator(".meta")).toContainText("Doc chat");
  await expect(tab.locator(".hl", { hasText: "a session answer from 0.3.0" }).locator(".meta")).toContainText("Agent chat");
  const retro = tab.getByRole("region", { name: "Retro" });
  await expect(retro.locator(".doc-where")).toHaveText(/^Notes · /);
  await shot(page, "notehl-all.png");
  await retro.getByText("night graphs").click();
  await expect(tabNamed(page, "Retro")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 5000, intervals: [25] }).toEqual(["night graphs"]);
  await expect.poll(() => painted(page, "agree")).toEqual(["night graphs"]);
  await shot(page, "notehl-jump.png");
});

test("turning Highlights off takes the paint off notes and keeps the data", async ({ page, daemon }) => {
  const date = today();
  await daemon.saveNote(date, "Plan.md", PLAN);
  await start(page, daemon);
  await openNote(page, "Plan");
  await highlight(page, "warm it", "Agree");
  await expect.poll(() => painted(page, "agree")).toEqual(["warm it"]);

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Plugin settings…" }).click();
  const on = page.getByRole("region", { name: "Plugins" }).getByRole("switch", { name: "Highlights" });
  await on.click();
  await expect(on).not.toBeChecked();
  await expect.poll(() => page.frame({ url: /\/_plugins\/highlight\/background\.html/ }) === null).toBe(true);
  await tabNamed(page, "Plan").click();
  await expect.poll(() => painted(page, "agree")).toEqual([]);
  await select(page, "Ship");
  await expect(bar(page)).toBeHidden();
  expect(Object.keys(await stored(daemon))).toEqual([noteFile(date, "Plan.md")]);
  await shot(page, "notehl-off.png");
});
