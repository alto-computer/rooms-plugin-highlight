/*
 * Perf probe for note highlights (F2-11), run like the lane specs from an alto-rooms checkout's
 * apps/desktop/e2e/lanes/. Alternates trunk (HIGHLIGHT_TRUNK_DIST) and head (HIGHLIGHT_DIST)
 * builds, PERF_RUNS runs each, on a 50 KB note that holds 20 stored highlights. Each run types
 * 200 characters at the top of the note in 10 bursts of 20, with a pause after each burst long
 * enough for the app to tell plugins the new text, and appends one JSON line to PERF_OUT:
 * keydown to the next painted frame for every key, and for every text the background page heard,
 * the time from its `surface.open` arriving in the page to its `paint` arriving in the app.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { surfacePath } from "../../../../packages/plugin-sdk/src/surfaces";
import { expect, test, today, type Daemon } from "../fixtures";

const RUNS = Number(process.env.PERF_RUNS ?? 20);
const OUT = process.env.PERF_OUT!;
const BUILDS = { trunk: process.env.HIGHLIGHT_TRUNK_DIST!, head: process.env.HIGHLIGHT_DIST! };
const BURSTS = 10;
const BURST = "typed words go here."; // 20 characters
const MARKS = 20;

/** About 50 KB of lines, with `markNN` words spread through it. */
function bigNote(): string {
  const lines: string[] = [];
  for (let i = 0; lines.join("\n").length < 50_000; i++) {
    const mark = i % 30 === 15 && i / 30 < MARKS ? ` mark${String(Math.floor(i / 30)).padStart(2, "0")}` : "";
    lines.push(`Line ${i}: the cache warms after the nightly batch job and holds until noon${mark}.`);
  }
  return lines.join("\n");
}

function highlights(body: string, date: string) {
  return Array.from({ length: MARKS }, (_, n) => {
    const text = `mark${String(n).padStart(2, "0")}`;
    const start = body.indexOf(text);
    return { id: `h${n}`, color: "agree", text, prefix: body.slice(Math.max(0, start - 40), start), suffix: body.slice(start + text.length, start + text.length + 40), start, annotations: [], createdAt: `${date}T09:00:00.000Z` };
  });
}

async function install(daemon: Daemon, dist: string) {
  const dest = path.join(daemon.home, ".rooms", "plugins", "highlight");
  await fs.cp(dist, dest, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
  const appVersion = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")).version;
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, minAppVersion: appVersion }));
}

const painted = (page: Page) =>
  page.evaluate(() => {
    const h = CSS.highlights.get("rooms-highlight-agree");
    return h ? Array.from(h as unknown as Iterable<Range>, (r) => r.toString()).sort() : [];
  });

for (let i = 0; i < 2 * RUNS; i++) {
  const build = i % 2 === 0 ? "trunk" : "head";
  test(`note typing, run ${Math.floor(i / 2) + 1} ${build}`, async ({ page, daemon }) => {
    test.setTimeout(120_000);
    const date = today();
    const body = bigNote();
    await daemon.saveNote(date, "Big.md", body);
    await daemon.write(`.rooms/plugins/highlight/data/${surfacePath({ kind: "note", date, name: "Big.md" })}.json`, JSON.stringify({ version: 1, title: "Big.md", highlights: highlights(body, date) }));
    await install(daemon, BUILDS[build]);
    await page.goto("/");
    const card = page.getByRole("dialog", { name: "New plugin: Highlights" });
    await card.getByRole("button", { name: "Turn on" }).click();
    await expect.poll(() => page.frame({ url: /\/_plugins\/highlight\/background\.html/ }) !== null).toBe(true);
    const bg = page.frame({ url: /\/_plugins\/highlight\/background\.html/ })!;
    await bg.evaluate(() => {
      const w = window as unknown as { opens: { version: number; at: number }[] };
      w.opens = [];
      window.addEventListener("message", (e) => {
        const d = e.data as { type?: string; version?: number; surface?: { kind?: string } };
        if (d?.type === "surface.open" && d.surface?.kind === "note") w.opens.push({ version: d.version!, at: performance.timeOrigin + performance.now() });
      });
    });
    await page.evaluate(() => {
      const w = window as unknown as { paints: { version: number; at: number }[]; frames: number[] };
      w.paints = [];
      w.frames = [];
      window.addEventListener("message", (e) => {
        const d = e.data as { rooms?: string; type?: string; version?: number; surface?: { kind?: string } };
        if (d?.rooms === "surface" && d.type === "paint" && d.surface?.kind === "note") w.paints.push({ version: d.version!, at: performance.timeOrigin + performance.now() });
      });
    });

    await page.getByRole("button", { name: "Journal", exact: true }).click();
    await page.getByRole("region", { name: "Your day" }).getByRole("button", { name: "Big" }).click();
    const editor = page.getByRole("textbox", { name: "Note" });
    await expect(editor).toHaveValue(body);
    const marks = Array.from({ length: MARKS }, (_, n) => `mark${String(n).padStart(2, "0")}`);
    if (build === "head") await expect.poll(() => painted(page)).toEqual(marks);
    await editor.click();
    await editor.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(0, 0);
      const w = window as unknown as { frames: number[] };
      el.addEventListener(
        "keydown",
        () => {
          const t = performance.now();
          requestAnimationFrame(() => setTimeout(() => w.frames.push(performance.now() - t)));
        },
        { capture: true },
      );
    });
    for (let b = 0; b < BURSTS; b++) {
      await page.keyboard.type(BURST);
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(500);
    const aligned = build === "trunk" || JSON.stringify(await painted(page)) === JSON.stringify(marks);

    const frames = await page.evaluate(() => (window as unknown as { frames: number[] }).frames);
    const paints = await page.evaluate(() => (window as unknown as { paints: { version: number; at: number }[] }).paints);
    const opens = await bg.evaluate(() => (window as unknown as { opens: { version: number; at: number }[] }).opens);
    const openToPaint = opens.flatMap((o) => {
      const p = paints.find((x) => x.version === o.version && x.at >= o.at);
      return p ? [p.at - o.at] : [];
    });
    expect(frames).toHaveLength(BURSTS * BURST.length);
    await fs.appendFile(OUT, `${JSON.stringify({ run: i, build, frames, openToPaint, opens: opens.length, aligned, load: (await import("node:os")).loadavg()[0] })}\n`);
  });
}
