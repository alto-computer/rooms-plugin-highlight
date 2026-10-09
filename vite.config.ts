import { defineConfig } from "vitest/config";

// Rooms loads content.js as a classic <script src> at the top of each document's <head>,
// so it is one self-contained IIFE. public/manifest.json lands beside it.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    lib: { entry: "src/content/main.ts", formats: ["iife"], name: "roomsHighlight", fileName: () => "content.js" },
  },
  test: { environment: "jsdom" },
});
