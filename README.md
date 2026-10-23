# Inkwell Figma plugin

Streams Figma design changes to the Inkwell editor as IR patches over a local WebSocket. Design: `Inkwell Design Spec.md`, section "Figma integration and live sync". Formats come from `@inkwell-ui/spec` (sibling checkout `../Inkwell-Spec`, on branch `feat/protocol` or later; it becomes a published, pinned dependency later).

## Build

```
(cd ../Inkwell-Spec && yarn install && yarn build)
yarn install        # re-run `yarn install --force` after rebuilding the spec: yarn copies file: deps
yarn test && yarn typecheck && yarn build
```

Output: `plugin/dist/code.js` (main thread) and `plugin/dist/ui.html` (iframe script inlined). In Figma desktop: Plugins > Development > Import plugin from manifest... > `plugin/manifest.json`.

## Design notes

- **Scope:** the current page. Top-level layers have `parent: null`. Switching pages sends a reconcile patch.
- **Change detection:** per-page `nodechange` (not `documentchange`). With `documentAccess: dynamic-page`, `documentchange` requires `figma.loadAllPagesAsync()`, which is slow on large files. Changes are debounced 150 ms, then the changed subtrees (plus their parents) are re-serialized and diffed against the last-sent IR; only differing nodes are sent (`upsert`, `move` for pure reparenting, `remove` for deleted nodes).
- **Node IDs:** the IR id is stored in `setSharedPluginData("inkwell", "id")` (written on every synced node, so a first sync touches the file). A pasted copy carries the source's id; it is given a new id and a `duplicate_id` issue (`clonedFrom`) rides on the patch. Detached-instance re-linking is not implemented yet.
- **Network:** only the UI iframe, `ws://localhost:8787..8790` (the manifest lists each explicitly in `devAllowedDomains`; `allowedDomains` is `["none"]`). It tries the ports in order, sends `hello`, and waits for `helloAck`. A version mismatch is shown and not retried. Reconnects back off 0.5 s doubling to 8 s; on every (re)connect the plugin sends a `hashTree` and answers `resend {ids}` with fresh subtrees.
- **Before release:** move the ports from `devAllowedDomains` to `allowedDomains` with a `reasoning` string.

## Manual test

The editor-side server does not exist yet (a later Editor task), and the spike's `yarn server` is not compatible (its `helloAck` lacks `editorVersion`/`protocolVersion`). Once the editor server exists: start it, paste its session token into the plugin, Connect; the badge should go to `synced`, then edit layers and watch patches arrive. Until then the protocol is covered by the fake-socket tests in `plugin/test/client.test.ts`.
