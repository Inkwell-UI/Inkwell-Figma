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
- **Editor -> Figma selection (protocol 5 `selectNode {nodeId, focus}`)** is the only editor message that touches the document: `sync/select.ts` selects the node only if `getNodeByIdAsync` finds it on the current page tree (`currentPage.selection`; `focus` also `viewport.scrollAndZoomIntoView`), otherwise it changes nothing and shows a `figma.notify`. Nothing else from the payload is used.
- **Themes are Figma variable collections** (0.4, `plugin/src/serialize/themes.ts`): the plugin sends every local collection (name, modes, a value per mode) as `Swf.themes` and, per layer, which IR property is bound to which variable (`bindings`, keys from the Spec's `themes.ts`). It never writes variables. Figma has no event for variable changes, so the plugin polls every 3 seconds. Setup for designers: `Inkwell-Editor/docs/starter-kit.md`.
- **Cache images by hash** (`getImageByHash`); never resend unchanged images.
- **Flag unmapped fonts at sync time.**
- **Distribution:** from GitHub only, imported from its manifest in the Figma desktop app. The editor bundles this plugin and checks its version in the handshake; bump the protocol version in inkwell-spec when the handshake changes. `.github/workflows/release.yml` tests and builds on every push/PR; a tag `v<package.json version>` attaches `Inkwell-Figma-Plugin.zip` (`manifest.json` + `dist`) to a GitHub release.

**Status (0.5, 2026-10-28):** plugin 0.5.0, built against spec 8 / protocol 5 (rebuild with `yarn build` after a Spec change; the editor refuses a mismatch). The portable editor zip carries `plugin/manifest.json` and `plugin/dist` in `Inkwell-Figma-Plugin/`. Not run inside Figma in 0.5 (tests only).

## Agent logging (required for all agents and subagents, any model)
Log your work in `d:\Mods\Inkwell\agents-logs\YYYY-MM-DD.md` (today's date).
1. Log one entry per user request, including short follow-ups ("try this fix", "yes do it"). Write it before your first edit for that request, not after. Only log when you actually write something (files, code, config); if the request is research only, don't log. Before writing, open today's log; if it doesn't exist, create it with the heading `# Agent log — YYYY-MM-DD`.
2. Append (never edit or delete) one entry:
   ```
   ## HH:MM · agent|subagent (model-id)[, spawned by agent HH:MM]
   - **User request:** one-line summary
   - **Doing:** one or two lines on how you're fulfilling it
   ```
3. Say `subagent` if another agent spawned you automatically, otherwise `agent`.
4. The entry may be written by a haiku model.
