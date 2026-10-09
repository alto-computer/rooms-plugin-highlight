# Highlights for Alto Rooms

Highlight text in any [Alto Rooms](https://github.com/alto-computer/alto-rooms) document in four colors, and attach notes to each highlight. Highlights stay with the document.

The plugin is a content script: Rooms loads it into every document a doc tab shows (permission `artifact.content`). It needs Alto Rooms 0.7.0 or later.

## Use

- Select text in a document. The selection bar shows **Ask**, then the four colors (**Important**, **Agree**, **DisAgree**, **IDK**) and **Highlight + note**.
- Click a color to paint the text. **Highlight + note** paints in the last color you picked and opens the card.
- Click a highlight to open its card: change its color, delete it, or add, edit and delete notes. ⌘Enter adds a note. A highlight with notes shows their count beside its last line.

Paint uses the CSS Custom Highlight API, so the document's own DOM, layout and scripts are untouched. The card lives in a closed shadow root outside `<body>`.

## Data

Each document's highlights are one JSON file:

```text
~/rooms/.rooms/plugins/highlight/data/docs/<fileKey>/highlights.json
```

```json
{ "version": 1, "title": "Q4 report", "highlights": [
  { "id": "9f2c…", "color": "important", "text": "p95 118 ms", "prefix": "latency ", "suffix": " under load",
    "start": 1532, "annotations": [{ "id": "…", "body": "Check the cache", "createdAt": "…", "updatedAt": "…" }],
    "createdAt": "…", "updatedAt": "…" }
] }
```

`text` is the highlighted text, `prefix` and `suffix` are up to 40 characters around it, and `start` is where it began in the document's text. When the document changes, the highlight is found again by its text and context; when the text itself changed a little, by the span between its context. A highlight whose text is gone stays in the file and is not painted. `color` is one of `important`, `agree`, `disagree`, `idk`. The record follows the Hi-Lighter browser extension's, and a Hi-Lighter `note` string reads as one annotation.

`fileKey` identifies the document's original file, so every room that links it shows the same highlights. The document can write this file too; the plugin reads it as untrusted input.

## Develop

```sh
bun install
bun run test           # needs Node 22 or later for jsdom
bun run build          # → dist/: manifest.json and content.js
bun run package        # → highlight.zip
```

To try a build in the app, copy `dist/` to `~/rooms/.rooms/plugins/highlight/`. See the [plugin guide](https://github.com/alto-computer/alto-rooms/blob/main/docs/plugins.md).

### End to end

`e2e/highlight-plugins.spec.ts` drives a built plugin through an alto-rooms checkout's Playwright harness: select, the colors in the bar, paint, notes, reload and restore, a late re-render, and a hostile document. Copy it to `apps/desktop/e2e/lanes/` there, then run from `apps/desktop`:

```sh
HIGHLIGHT_DIST=<this repo>/dist bunx playwright test e2e/lanes/highlight-plugins.spec.ts --project chromium --project webkit
```

### The SDK

`connectContent` arrives in `@alto-rooms/plugin-sdk` 0.3.0, which is not released yet. Until it is, `vendor/plugin-sdk/` holds a copy of `packages/plugin-sdk/src` from alto-rooms `a21e26b`, and `package.json` depends on it. Once the `plugin-sdk-v0.3.0` release exists, replace the dependency line with the line below, delete `vendor/`, and run `bun install`:

```json
"@alto-rooms/plugin-sdk": "https://github.com/alto-computer/alto-rooms/releases/download/plugin-sdk-v0.3.0/alto-rooms-plugin-sdk-0.3.0.tgz"
```

## License

MIT.
