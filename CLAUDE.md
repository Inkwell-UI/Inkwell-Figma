# Inkwell Figma Plugin

Figma plugin that streams design changes to the Inkwell editor as IR patches over a local WebSocket. The full design is in `Inkwell Design Spec.md` (workspace root), section "Figma integration and live sync"; read it before changing behavior. Where this file and the spec disagree, the spec wins; fix this file.

## Commands

Not scaffolded yet. List build and test commands here once they exist.

## Stack

TypeScript, Figma Plugin API. Patch and IR types come from `inkwell-spec`.

## Rules that are easy to break

- **The plugin only reports visuals.** It never stores or edits behavior; that lives in the editor's overlay.
- **IR and patch formats come from inkwell-spec.** Never define them here.
- **Send only changed subtrees,** debounced (about 100–200 ms). On reconnect, send a hash tree and resend only mismatched nodes.
- **Node IDs are the link to behavior.** Write the mapping back with `setSharedPluginData`. Handle duplicate/paste (new IDs), detached instances (re-link by name and path) and deleted nodes (orphans, never silently dropped).
- **Network access only from the UI iframe,** to `localhost`, with the session token. No other network calls.
- **Cache images by hash** (`getImageByHash`); never resend unchanged images.
- **Flag unmapped fonts at sync time.**
- **Distribution:** from GitHub only, imported from its manifest in the Figma desktop app. The editor bundles this plugin and checks its version in the handshake; bump the protocol version in inkwell-spec when the handshake changes.
