/*
 * Lane spec for answer highlights (F2-9): the built plugin from HIGHLIGHT_DIST against an
 * alto-rooms checkout's roomsd and web build, with the streaming fake agent, copied into its
 * apps/desktop/e2e/lanes/. The file name matches the WebKit project.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, test, type Daemon } from "../fixtures";
import { installStreamingAgent } from "../streamingAgent";

const DIST = process.env.HIGHLIGHT_DIST!;
const DATA = ".rooms/plugins/highlight/data";
const COLOR = { important: "rgba(199, 154, 62, 0.28)", agree: "rgba(122, 153, 113, 0.26)", idk: "rgba(142, 132, 160, 0.26)" };
const ALPHA = "<html><head><title>Alpha</title></head><body><p>alpha</p></body></html>";

async function installHighlight(daemon: Daemon) {
  const dest = path.join(daemon.home, ".rooms", "plugins", "highlight");
  await fs.cp(DIST, dest, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
  const appVersion = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")).version;
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, minAppVersion: appVersion }));
}

async function start(page: Page, daemon: Daemon) {
  installStreamingAgent(daemon, "Chat");
  const room = await daemon.createRoom("harness");
  await daemon.write("harness/alpha.html", ALPHA);
  await installHighlight(daemon);
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "New plugin: Highlights" });
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("Can read and mark chat answers");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => page.frame({ url: /\/_plugins\/highlight\/background\.html/ }) !== null).toBe(true);
  return room;
}

const tabNamed = (page: Page, name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name, exact: true });
const tabFrame = (page: Page): FrameLocator => page.frameLocator('xpath=//iframe[@title="Highlights"][not(ancestor::*[@data-background-frames])]');
const bar = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });

async function openRoom(page: Page, room: string) {
  await page.getByRole("list", { name: "Rooms" }).getByRole("button", { name: room, exact: true }).click();
  await expect(tabNamed(page, room)).toHaveAttribute("aria-selected", "true");
}

async function openDocTab(page: Page, title: string) {
  const card = page.getByTestId("artifact-card").filter({ hasText: title });
  await card.hover();
  await card.getByRole("button", { name: "Open in new tab" }).click();
  await expect(page.getByRole("tab", { name: title, selected: true })).toBeVisible();
}

async function openHighlights(page: Page) {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu", { name: "Plugins" }).getByRole("menuitem", { name: "Highlights" }).click();
  await expect(tabNamed(page, "Highlights")).toHaveAttribute("aria-selected", "true");
  await expect(tabFrame(page).getByRole("heading", { name: "Highlights", level: 1 })).toBeVisible();
}

async function ask(page: Page, placeholder: string, question: string) {
  const input = page.getByPlaceholder(placeholder);
  await input.fill(question);
  await input.press("Enter");
  const answer = page.locator("[data-surface] p").filter({ hasText: `answer to ${question}` });
  await expect(answer).toBeVisible({ timeout: 10_000 });
  return answer;
}

/** The text of every range painted under `rooms-highlight-<style>`, or under `name` as given. */
const painted = (page: Page, style: string) =>
  page.evaluate((n) => {
    const h = CSS.highlights.get(n);
    return h ? Array.from(h as unknown as Iterable<Range>, (r) => r.toString().trim()) : [];
  }, style.startsWith("rooms-") ? style : `rooms-highlight-${style}`);

const paintColor = (el: Locator, style: string) => el.evaluate((p, n) => getComputedStyle(p, `::highlight(${n})`).backgroundColor, `rooms-highlight-${style}`);

async function highlight(page: Page, answer: Locator, color: string) {
  await answer.click({ clickCount: 3 });
  await expect(bar(page).getByRole("button")).toHaveText(["Ask", "Important", "Agree", "DisAgree", "IDK"]);
  await bar(page).getByRole("button", { name: color, exact: true }).click();
  await expect(bar(page)).toBeHidden();
}

async function clickPainted(page: Page, style: string) {
  const at = await page.evaluate((n) => {
    const [r] = Array.from(CSS.highlights.get(n) as unknown as Iterable<Range>);
    const box = r.getClientRects()[0];
    return { x: box.left + Math.min(20, box.width / 2), y: box.top + box.height / 2 };
  }, `rooms-highlight-${style}`);
  await page.mouse.click(at.x, at.y);
}

type AnswerFile = { title: string; highlights: { color: string; text: string; annotations: { body: string }[] }[] };

async function answerFiles(daemon: Daemon): Promise<Record<string, AnswerFile>> {
  const dir = path.join(daemon.home, DATA, "answer");
  if (!(await fs.stat(dir).catch(() => null))) return {};
  const files = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const out: Record<string, AnswerFile> = {};
  for (const f of files) out[path.relative(dir, path.join(f.parentPath, f.name))] = JSON.parse(await fs.readFile(path.join(f.parentPath, f.name), "utf8"));
  return out;
}

test("answer highlights take the four document colors, list under their thread in the tab, and jump back", async ({ page, daemon }) => {
  const room = await start(page, daemon);

  await openRoom(page, "harness");
  const roomAnswer = await ask(page, "Ask about this room…", "Which doc is first?");
  const roomText = (await roomAnswer.textContent())!.trim();
  const surface = roomAnswer.locator("xpath=ancestor::*[@data-surface]");
  const before = await surface.innerHTML();
  await highlight(page, roomAnswer, "Agree");
  await expect.poll(() => painted(page, "agree")).toEqual([roomText]);
  expect(await paintColor(roomAnswer, "agree"), "the document's Agree color").toBe(COLOR.agree);
  expect(await surface.innerHTML(), "paint changes no DOM").toBe(before);
  const files = await answerFiles(daemon);
  const [roomFile] = Object.keys(files);
  expect(roomFile).toMatch(new RegExp(`^room/${room.id}/[^/]+\\.json$`));
  expect(files[roomFile].highlights).toEqual([expect.objectContaining({ color: "agree", text: roomText, annotations: [] })]);

  await openDocTab(page, "Alpha");
  const docAnswer = await ask(page, "Ask about this artifact…", "What is this?");
  const docText = (await docAnswer.textContent())!.trim();
  await highlight(page, docAnswer, "Important");
  await expect.poll(() => painted(page, "important")).toEqual([docText]);
  expect(await paintColor(docAnswer, "important")).toBe(COLOR.important);
  await expect.poll(() => painted(page, "agree"), "the room's paint left with its thread").toEqual([]);

  await openHighlights(page);
  const tab = tabFrame(page);
  const roomGroup = tab.getByRole("region", { name: "harness" });
  await expect(roomGroup.getByText("Room chat", { exact: true })).toBeVisible();
  await expect(roomGroup.locator(".hl")).toContainText([roomText]);
  await expect(roomGroup.locator(".meta")).toContainText([/Agree · Room chat/]);
  const docGroup = tab.getByRole("region", { name: "Alpha" });
  await expect(docGroup.locator(".meta")).toContainText([/Important · Doc chat/]);
  await page.screenshot({ path: path.join(process.env.HIGHLIGHT_SHOTS ?? "/tmp", "answer-tab.png") });

  await roomGroup.getByText(roomText).click();
  await expect(tabNamed(page, "harness")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => painted(page, "rooms-flash"), { timeout: 5000, intervals: [25] }).toEqual([roomText]);
  await expect.poll(() => painted(page, "agree")).toEqual([roomText]);
});

test("the range menu recolors, deletes, and sends a note to the Highlights tab", async ({ page, daemon }) => {
  await start(page, daemon);
  await openRoom(page, "harness");
  const answer = await ask(page, "Ask about this room…", "Which doc is first?");
  const text = (await answer.textContent())!.trim();
  await highlight(page, answer, "Agree");
  await expect.poll(() => painted(page, "agree")).toEqual([text]);

  await clickPainted(page, "agree");
  await expect(bar(page).getByRole("button")).toHaveText(["Important", "Agree", "DisAgree", "IDK", "Delete", "Add a note in Highlights"]);
  await bar(page).getByRole("button", { name: "IDK", exact: true }).click();
  await expect.poll(() => painted(page, "idk")).toEqual([text]);
  expect(await painted(page, "agree")).toEqual([]);
  expect(await paintColor(answer, "idk")).toBe(COLOR.idk);

  await clickPainted(page, "idk");
  await bar(page).getByRole("button", { name: "Add a note in Highlights" }).click();
  await openHighlights(page);
  const note = tabFrame(page).getByRole("textbox", { name: "New note" });
  await expect(note).toBeFocused();
  await note.fill("Check after 2am");
  await tabFrame(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(async () => Object.values(await answerFiles(daemon))[0]?.highlights[0].annotations.map((a) => a.body)).toEqual(["Check after 2am"]);

  await openRoom(page, "harness");
  await expect.poll(() => painted(page, "idk")).toEqual([text]);
  await clickPainted(page, "idk");
  await expect(bar(page).getByRole("button").last()).toHaveText("1 note in Highlights");
  await page.screenshot({ path: path.join(process.env.HIGHLIGHT_SHOTS ?? "/tmp", "answer-menu.png") });
  await bar(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => painted(page, "idk")).toEqual([]);
  await expect.poll(async () => Object.keys(await answerFiles(daemon))).toEqual([]);
});

test("a day answer's highlight lists under the day, and every answer highlight paints again after a reload", async ({ page, daemon }) => {
  await start(page, daemon);
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Journal · /, selected: true })).toBeVisible();
  const answer = await ask(page, "Ask about this day…", "What did I do?");
  const text = (await answer.textContent())!.trim();
  await highlight(page, answer, "DisAgree");
  await expect.poll(() => painted(page, "disagree")).toEqual([text]);

  await page.reload();
  await expect(page.getByText(text)).toBeVisible();
  await expect.poll(() => painted(page, "disagree"), "repainted from storage").toEqual([text]);

  await openHighlights(page);
  const row = tabFrame(page).locator(".hl", { hasText: text });
  await expect(row.locator(".meta")).toContainText(/DisAgree · Day chat/);
  await expect(tabFrame(page).locator(".doc-where")).toHaveText(["Journal"]);
});
