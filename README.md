# Inkwell Figma plugin

Streams Figma design changes to the Inkwell editor as IR patches over a local WebSocket. Design: `Inkwell Design Spec.md`, section "Figma integration and live sync". Formats come from `@inkwell-ui/spec` (linked as `link:../Inkwell-Spec`, a sibling checkout that must exist next to this repo; it becomes a published, pinned dependency later).

## Build

```
(cd ../Inkwell-Spec && yarn install && yarn build)
yarn install        # the spec is linked, not copied: after changing it only `yarn build` in Inkwell-Spec is needed
yarn test && yarn typecheck && yarn build
```

Output: `plugin/dist/code.js` (main thread) and `plugin/dist/ui.html` (iframe script inlined). In Figma desktop: Plugins > Development > Import plugin from manifest... > `plugin/manifest.json`.

## Design notes

- **One SWF per top-level frame:** each top-level FRAME on the current page is its own SWF (`swfId` = its node id, name = frame name, stage = frame size, sent as `swf` metadata with the root upsert). Patches, hash trees and resends are per SWF; a `swfs` message lists the frames and the loose top-level layers (text, rectangles, groups, sections, components directly on the page), which are not synced. Moving a node into another frame removes it from the old SWF and upserts it whole into the new one.
- **Text style name:** the main thread looks up `textStyleId` with `figma.getStyleByIdAsync` (prefetched like instances' main components) and the pure serializer reads it through `Ctx.styleNameOf`; it lands in the run's `font.styleName` next to `family/style`.
- **Scope:** the current page. Top-level layers have `parent: null`. Switching pages sends a reconcile patch.
- **Change detection:** per-page `nodechange` (not `documentchange`). With `documentAccess: dynamic-page`, `documentchange` requires `figma.loadAllPagesAsync()`, which is slow on large files. Changes are debounced 150 ms, then the changed subtrees (plus their parents) are re-serialized and diffed against the last-sent IR; only differing nodes are sent (`upsert`, `move` for pure reparenting, `remove` for deleted nodes).
- **Node IDs:** the IR id is stored in `setSharedPluginData("inkwell", "id")` (written on every synced node, so a first sync touches the file). A pasted copy carries the source's id; it is given a new id and a `duplicate_id` issue (`clonedFrom`) rides on the patch. Detached-instance re-linking is not implemented yet.
- **Network:** only the UI iframe, `ws://localhost:8787..8790` (the manifest lists each explicitly in `devAllowedDomains`; `allowedDomains` is `["none"]`). It tries the ports in order, sends `hello`, and waits for `helloAck`. A version mismatch is shown and not retried. Reconnects back off 0.5 s doubling to 8 s; on every (re)connect the plugin sends a `hashTree` and answers `resend {ids}` with fresh subtrees.
- **Images (protocol 3):** a RECTANGLE whose only fill is an image (and no stroke) becomes an `image` node (`asset` = Figma image hash, `scaleMode`, `fillOpacity` = the paint opacity); other image paints stay image fills (`opacity` kept), and frames now send their `fills`. Bytes travel only on request: the editor sends `needAssets {hashes}` for hashes it lacks, the main thread reads `figma.getImageByHash(h).getBytesAsync()`, and the iframe sends one `asset {hash, data}` (base64 PNG; JPEG/GIF/16-bit/interlaced PNGs are re-encoded through a canvas). Each hash is sent at most once per connection; the editor keeps it on disk, so it is not asked again. Size limits are linted by the editor (`image-too-large`).
- **Before release:** move the ports from `devAllowedDomains` to `allowedDomains` with a `reasoning` string.

## Manual test

Needs the Inkwell editor (branch `feat/images`, protocol 3; see its `docs/sync-server.md`). Start it, paste the session token, Connect; the badge should go to `synced`.

1. On one page make two top-level frames (e.g. `Hud` 1920x1080 and `Menu Main` 800x600), each with a text layer, plus one loose text layer directly on the page.
2. Expect two SWFs in the editor window (`build/Hud.swf`, `build/Menu_Main.swf`) and a lint warning `unreachable-node` naming the loose layer.
3. Give a text layer a text style named `Everywhere / Medium / 18` (or a font `Everywhere` / `Medium`): no font lint. Use Inter Regular: a `font-fallback` warning that still names `Inter/Regular`.
4. Drag a layer from `Hud` into `Menu Main`: it leaves one SWF and appears in the other. Delete `Menu Main`: its SWF is marked orphaned in the editor, not deleted.
