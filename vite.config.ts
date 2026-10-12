import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two builds into one dist/. The default holds the tab (index.html) and the hidden background page
// (background.html), served from /_plugins/highlight/, so every URL in them is relative.
// `--mode content` adds content.js: Rooms loads it as a classic <script src> at the top of each
// document's <head>, so it is one self-contained IIFE.
export default defineConfig(({ mode }) =>
  mode === "content"
    ? {
        publicDir: false,
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "es2022",
          lib: { entry: "src/content/main.ts", formats: ["iife"], name: "roomsHighlight", fileName: () => "content.js" },
        },
      }
    : {
        base: "./",
        plugins: [react()],
        build: {
          outDir: "dist",
          emptyOutDir: true,
          target: "es2022",
          modulePreload: false,
          rollupOptions: { input: { index: "index.html", background: "background.html" } },
        },
        test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
      },
);
