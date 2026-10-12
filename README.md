# Highlights for Alto Rooms

Highlight text in any [Alto Rooms](https://github.com/alto-computer/alto-rooms) document, chat answer or Journal note in four colors, and attach notes to each highlight. Highlights stay with the document, the answer or the note.

The plugin is a content script, which Rooms loads into every document a doc tab shows (permission `artifact.content`), a hidden background page that reads and marks chat answers and notes (permission `surfaces.text`), and a **Highlights** tab that lists every highlight (permission `rooms.read`, to show each document's title and rooms). It needs Alto Rooms 0.7.0 or later.

## Use

- Select text in a document. The selection bar shows **Ask**, then the four colors (**Important**, **Agree**, **DisAgree**, **IDK**) and **Highlight + note**.
- Click a color to paint the text. **Highlight + note** paints in the last color you picked and opens the card.
- Click a highlight to open its card: change its color, delete it, or add, edit and delete notes. ⌘Enter adds a note. A highlight with notes shows their count beside its last line.
- Select text in a chat answer, in a document's, a room's or a day's chat. The selection bar shows **Ask**, then the same four colors. Click a painted answer highlight for a menu: the four colors, **Delete**, and its notes, which you edit in the Highlights tab (the app draws only buttons over answers). Picking the notes item opens that highlight's notes the next time you open the tab, or at once when it is open.
- Select text in a note in the Journal. The selection bar shows the same four colors (notes have no **Ask**). The paint sits behind the text, and the note's file never changes. Editing the note keeps each highlight on its words; one whose words you delete stays in the tab marked "Text not found", and paints again if the words come back. Renaming the note keeps its highlights. A click on a painted note highlight shows the same menu as over an answer.
- Open **Highlights** from **Plugins** in the sidebar to see every highlight, grouped by document or chat, newest first. A document's chat highlights sit with the document's own, marked "Doc chat"; a room's chat is under the room, marked "Room chat"; a day's chat is under the day, marked "Day chat". Each note is a group of its own under its name, marked "Notes" with its day. Filter by color, or search quotes and notes. Click a highlight to open its document next to the tab, scrolled to the highlight, which flashes; an answer highlight opens its chat at the answer and flashes there, and a note highlight opens the note and flashes there. **Add a note** under an answer or note highlight edits its notes. A document no room links any more shows as "Doc removed", and a highlight whose text the document lost shows "Text not found".

Paint uses the CSS Custom Highlight API, so the document's own DOM, layout and scripts are untouched, and so are the app's answers. The card lives in a closed shadow root outside `<body>`.

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

Next to it, `orphans.json` lists the ids of the highlights whose text the document no longer has, as the content script last saw it. The tab reads it to mark those rows.

`fileKey` identifies the document's original file, so every room that links it shows the same highlights. The document can write these files too; the plugin reads them as untrusted input, and the tab renders every field as text.

Each chat answer's and each note's highlights are one file of the same shape, at the SDK's `surfacePath` for that surface plus `.json`:

```text
~/rooms/.rooms/plugins/highlight/data/answer/artifact/<fileKey>/<turnId>.json
~/rooms/.rooms/plugins/highlight/data/answer/room/<roomId>/<turnId>.json
~/rooms/.rooms/plugins/highlight/data/answer/day/<date>/<turnId>.json
~/rooms/.rooms/plugins/highlight/data/answer/session/<agent>/<id>/<turnId>.json
~/rooms/.rooms/plugins/highlight/data/note/<date>/<name segment>.json
```

A note's name segment is its folded name's path-safe characters and a hash of the whole name, for example `plan.md-1a2b3c4d`, so the path cannot give the name back: a note file's `title` is the note's file name, `Plan.md`, and the tab opens the note by it. An answer file's `title` is the start of the answer, since the background page sees answers and never their questions. `start`, `prefix` and `suffix` index the surface's text, and each open finds the highlight again the same way as in a document; a note is read again each time you pause typing. The file goes away with its last highlight. Beside it, `<name>.orphans` lists the ids of the highlights whose text the surface no longer has, as the background page last saw it, for example after an answer was regenerated or a note's words were deleted; the tab marks those rows like a document's lost text. Renaming a note moves its two files to the new name. `focus.json` is the range menu's request to show one highlight's notes; the tab reads and deletes it.

Plugin 0.3.0 kept a document chat's answers under `answer/doc/` and an agent session's under `answer/conversation/`, the names of SDK 0.5. On start, 0.4.0 moves each such file to `answer/artifact/` or `answer/session/`, ids unchanged. If a file is already at the new path, the old file's highlights it lacks are added to it; if either file is not a record, both stay where they are.

## Develop

```sh
bun install
bun run test           # needs Node 22 or later for jsdom
bun run build          # → dist/: manifest.json, the tab (index.html), the background page (background.html), assets/ and content.js
bun run package        # → highlight.zip
```

To try a build in the app, copy `dist/` to `~/rooms/.rooms/plugins/highlight/`. See the [plugin guide](https://github.com/alto-computer/alto-rooms/blob/main/docs/plugins.md).

### End to end

Four specs drive a built plugin through an alto-rooms checkout's Playwright harness. `e2e/highlight-plugins.spec.ts` covers select, the colors in the bar, paint, notes, reload and restore, a late re-render, and a hostile document. `e2e/tab-plugins.spec.ts` covers the tab: the list across documents and rooms, the filter and the search, the jump and its flash, lost text, a removed document, a forged record, and 4,000 highlights. `e2e/answer-plugins.spec.ts` covers chat answers with the streaming fake agent: the four colors over room, doc and day answers, their rows in the tab and the jump back, the range menu's recolor, delete and notes, and repaint after a reload. `e2e/note-plugins.spec.ts` covers notes: the four colors behind a note's text, the tab's Notes group and the jump back, typing above a highlight, deleting its words, a reload, a rename, the range menu, a note from last week, answer files from 0.3.0, and turning the plugin off. Copy them to `apps/desktop/e2e/lanes/` there, then run from `apps/desktop`:

```sh
HIGHLIGHT_DIST=<this repo>/dist bunx playwright test e2e/lanes/ --project chromium --project webkit
```

`perf/note-typing.spec.ts` is the note typing probe: copy it to the same `e2e/lanes/` and set `HIGHLIGHT_TRUNK_DIST` to a build of the previous version, `PERF_OUT` to a file for its JSON lines, and `PERF_RUNS` (default 20). It alternates the two builds on a 50 KB note with 20 highlights, types 200 characters in bursts, and records keydown to the next painted frame and `surface.open` to `paint`.

### The SDK

The background page uses `connectSurfaces` from `@alto-rooms/plugin-sdk` 0.6.0, which says it reads surface API 2: the app sends it notes and the scope names `artifact` and `session`, and gives each text a `version` that every paint names. 0.6.0 is not released yet. Until it is, `vendor/plugin-sdk/` holds a byte-for-byte copy of `packages/plugin-sdk` (its `package.json` and the files it lists) from alto-rooms `98958b3`, and `package.json` depends on it. Once the `plugin-sdk-v0.6.0` release exists, replace the dependency line with the line below, delete `vendor/`, and run `bun install`:

```json
"@alto-rooms/plugin-sdk": "https://github.com/alto-computer/alto-rooms/releases/download/plugin-sdk-v0.6.0/alto-rooms-plugin-sdk-0.6.0.tgz"
```

## License

MIT.
