import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS, ORDER } from "../model";

const CSS = readFileSync(path.join(import.meta.dirname, "styles.css"), "utf8");
const ROOT = /^:root\s*\{([^}]*)\}/m.exec(CSS);
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(|(?<![\w-])(?:white|black)(?![\w-])/i;

describe("the tab's stylesheet", () => {
  it("reads every colour, font and surface from the app's theme, with a fallback", () => {
    expect(ROOT).not.toBeNull();
    const decls = ROOT![1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) expect(d).toMatch(/^--[\w-]+:\s*var\(--rooms-[\w-]+,\s*.+\)$/);
  });

  it("names no colour of its own outside those aliases", () => {
    const rules = CSS.slice(ROOT!.index + ROOT![0].length);
    const hits = rules.split("\n").filter((line) => COLOUR.test(line));
    expect(hits).toEqual([]);
  });
});

/** Cozy Den's pane, sheet and ink in each scheme (alto-rooms apps/desktop/src/styles.css). */
const SCHEMES = {
  light: { surfaces: ["#f8f4ee", "#fffdf9"], ink: "#27211e" },
  dark: { surfaces: ["#211c19", "#2a2420"], ink: "#efe7df" },
};

type Rgba = [number, number, number, number];
const parse = (c: string): Rgba => {
  if (c.startsWith("#")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).concat(1) as Rgba;
  const [r, g, b, a] = c.match(/[\d.]+/g)!.map(Number);
  return [r, g, b, a ?? 1];
};
const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const luminance = (c: Rgba) =>
  c
    .slice(0, 3)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the four highlight colours", () => {
  for (const [scheme, { surfaces, ink }] of Object.entries(SCHEMES)) {
    for (const surface of surfaces) {
      it(`keep the ink at AA under their paint on ${scheme} ${surface}`, () => {
        for (const c of ORDER) {
          const painted = over(parse(COLORS[c].bg), parse(surface));
          expect(contrast(parse(ink), painted), c).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
});
