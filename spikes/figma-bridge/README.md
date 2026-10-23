# Spike 4: Figma bridge

**Question:** can a Figma plugin (UI iframe) connect to a local WebSocket using a session token and send a `hello` plus a selection change?

**Result: PASS (2026-10-23, SPIKES.md spike 4 / section 2).** Server side (good token, bad token -> 401, bad origin -> 403, no origin, loopback bind) is verified by `yarn test` (static). The Figma desktop leg was **verified in-game by the owner in Figma desktop**: the UI showed `open` and `helloAck`; the server logged `hello` and selections (ids 3:2 / 3:3 / 3:4, and an empty selection). The server log of that session is not on disk (owner-relayed). Commit `ccc14f4`.

**Key finding (localhost vs IP):** the Figma manifest validator **rejects an IP address** in `devAllowedDomains`; `ws://localhost:8787` is accepted. So the manifest and UI use `ws://localhost:8787` only. The server binds `127.0.0.1` (IPv4) and the plugin reaches it through `localhost`. Untested: a machine where `localhost` resolves to `::1` first (bind `::1` too, or verify Figma resolves IPv4). The wrong-token case was verified only by the self-test, not in Figma.

## What was built
- `server.ts`: `ws` server on `127.0.0.1:8787` only. Random 48-hex session token printed at start; required as `?token=`. Origin must be `null` (Figma iframe) or absent (non-browser); any other origin gets 403, bad token 401. Logs every message, acks `hello`.
- `plugin/`: `manifest.json`, `src/code.ts` (main thread: `selectionchange` -> posts `{id,name}` list to UI), `ui.src.html` (token field, connects `ws://localhost:8787`, sends `hello {pluginVersion, specVersion:"TODO"}`, then forwards selection). Build output goes to `plugin/dist/` (gitignored).
- `selftest.ts`: no Figma needed; asserts good token+origin `null` (hello acked, selection received), bad token, bad origin, no-origin client, loopback bind.

## Run
```
yarn install
yarn test          # self-test, exit 0 on success
yarn build         # esbuild -> plugin/dist/code.js + ui.html
yarn server        # prints TOKEN (binds 127.0.0.1:8787)
```

## Human test script (Figma desktop; run and passed by the owner)
1. `yarn install && yarn build`, then `yarn server`; copy the TOKEN.
2. Figma desktop: open any design file > Plugins > Development > Import plugin from manifest... > pick `plugin/manifest.json`.
3. Run Plugins > Development > Inkwell Bridge Spike. Paste the token, click Connect.
4. Expect UI status `open` then `server: {"type":"helloAck","ok":true}`, and server log `[recv] {"type":"hello",...}`.
5. Select/deselect layers; server log should show `{"type":"selection","nodes":[{"id":..,"name":..}]}` each time.
6. Negative: wrong token -> UI shows error/closed, server logs nothing. Also note the Figma console (Plugins > Development > Open console) for any CSP "Refused to connect" errors and report them.

## Docs findings (developers.figma.com, fetched 2026-10-23)
- Plugin iframes have a `null` origin; CORS applies (plain HTTP APIs need `Access-Control-Allow-Origin: *`). The docs page on network requests does not mention WebSockets; the WS handshake sends `Origin: null`, which is what the server accepts (confirmed by the owner run: the handshake was accepted).
- `networkAccess.allowedDomains` is required if `networkAccess` is used; patterns may use `ws`/`wss` schemes. Local servers belong in `devAllowedDomains` (no `reasoning` needed); in `allowedDomains` they require `reasoning`. The docs give no explicit `ws://localhost` rule; in practice the validator rejects IPs, so the manifest lists only `ws://localhost:8787` in `devAllowedDomains` (accepted, verified).
- Requests to non-listed domains are blocked by Figma via CSP ("Refused to connect to ...").
- Consequence for production: a shipped plugin needs `ws://localhost:<port>` in `allowedDomains` with a `reasoning` string (and a fixed port or port range; unknown whether wildcard ports work). Since it ships via manifest import (not Community), review is not a concern, but the manifest must be edited from `devAllowedDomains` before release.

## Open risks
- IPv6: server binds IPv4 only; works here via `localhost`, untested where `localhost` resolves to `::1` first. Wrong-token case not verified inside Figma.
- `Origin: null` is also sent by any sandboxed iframe/`data:` page on the web, so the origin check is weak; the token is the real defence. Token travels in the URL query (loopback only; fine for a spike, consider first-message auth).
- Fixed port 8787 can clash; the editor would need port negotiation.
- `id` in manifest is a placeholder (works for local import).
