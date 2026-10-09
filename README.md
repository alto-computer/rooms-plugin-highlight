# Highlights for Alto Rooms

Highlight text in any [Alto Rooms](https://github.com/alto-computer/alto-rooms) document in four colors, and attach notes to each highlight. Highlights stay with the document.

The plugin is a content script: Rooms loads it into every document a doc tab shows (permission `artifact.content`). It needs Alto Rooms 0.7.0 or later.

## Develop

```sh
bun install
bun run test
bun run build          # → dist/: manifest.json and content.js
bun run package        # → highlight.zip
```

To try a build in the app, copy `dist/` to `~/rooms/.rooms/plugins/highlight/`. See the [plugin guide](https://github.com/alto-computer/alto-rooms/blob/main/docs/plugins.md).

### The SDK

`connectContent` arrives in `@alto-rooms/plugin-sdk` 0.3.0, which is not released yet. Until it is, `vendor/plugin-sdk/` holds a copy of `packages/plugin-sdk/src` from alto-rooms `a21e26b`, and `package.json` depends on it. Once the `plugin-sdk-v0.3.0` release exists, replace the dependency line with the line below, delete `vendor/`, and run `bun install`:

```json
"@alto-rooms/plugin-sdk": "https://github.com/alto-computer/alto-rooms/releases/download/plugin-sdk-v0.3.0/alto-rooms-plugin-sdk-0.3.0.tgz"
```

## License

MIT.
