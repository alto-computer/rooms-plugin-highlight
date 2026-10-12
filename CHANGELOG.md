# Changelog

## 0.5.0

- The Highlights tab follows the app's theme, light and dark, and changes with it. Its page, cards, filter chips, search field, note editor and text read the app's colours and font from SDK 0.7.0's `--rooms-*` variables instead of fixed light greys. "Text not found" uses the app's error colour.
- The four highlight colours are unchanged. Text under each keeps at least 7.5:1 contrast on the app's dark pane and sheet, and a unit test checks it in both schemes.
- The card drawn inside documents keeps its own look.
- Needs Alto Rooms 0.7.1 or later. Built on `@alto-rooms/plugin-sdk` 0.7.0.
