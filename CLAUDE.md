# Inkwell Figma Plugin

Figma plugin that streams design changes to the Inkwell editor as IR patches over a local WebSocket. The full design is in `Inkwell Design Spec.md` (workspace root), section "Figma integration and live sync"; read it before changing behavior. Where this file and the spec disagree, the spec wins; fix this file.

## Commands

Use yarn at the repo root (needs `../Inkwell-Spec` built; see README).

- `yarn test`: Vitest (serializer, sync, protocol client incl. approval states)
- `yarn typecheck`: `tsc --noEmit`
- `yarn build`: esbuild -> `plugin/dist/code.js` + `ui.html`

Spike code lives in `spikes/figma-bridge/` with its own yarn project (`yarn server`, `yarn test`); leave it untouched.

## Stack

TypeScript, Figma Plugin API. Patch, IR and protocol types come from `@inkwell-ui/spec`. Source in `plugin/src/` (`serialize/` pure, `sync/` pure, `code.ts` main thread, `ui.ts` iframe).

## Rules that are easy to break

- **The plugin only reports visuals.** It never stores or edits behavior; that lives in the editor's overlay.
- **IR and patch formats come from inkwell-spec.** Never define them here.
- **One SWF per top-level FRAME.** Patches, hash trees and resends carry `swfId`; loose top-level layers are never synced, only reported in the `swfs` message.
- **Send only changed subtrees,** debounced (about 100–200 ms). On reconnect, send a hash tree and resend only mismatched nodes.
- **Node IDs are the link to behavior.** Write the mapping back with `setSharedPluginData`. Handle duplicate/paste (new IDs), detached instances (re-link by name and path) and deleted nodes (orphans, never silently dropped).
- **Network access only from the UI iframe,** to `localhost`. No other network calls. The manifest's `devAllowedDomains` must use `ws://localhost:<port>`: Figma rejects an IP address there. Plugin iframes send `Origin: null`, which any sandboxed page can also send, so the defence is approve-on-connect (protocol 4): the plugin makes a random 256-bit secret once (`crypto.getRandomValues`, 64 hex, `sync/secret.ts`), keeps it in `figma.clientStorage` (`pluginSecret`), and sends it in every `hello` with `fileName` (`figma.root.name`). The editor asks the user to allow an unknown secret (answers `pending`, then `helloAck` or `denied {reason}`); send nothing before `helloAck`. There is no token and no paste field; the UI connects by itself and shows Connecting / Waiting for approval in the editor / Denied (reason) / Connected. `denied` by the user is not retried (the "Ask again" button does); `busy` and `timeout` retry with backoff. Never log or display the secret.
- **Cache images by hash** (`getImageByHash`); never resend unchanged images.
- **Flag unmapped fonts at sync time.**
- **Distribution:** from GitHub only, imported from its manifest in the Figma desktop app. The editor bundles this plugin and checks its version in the handshake; bump the protocol version in inkwell-spec when the handshake changes.
