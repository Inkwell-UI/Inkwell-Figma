// UI iframe: the only network access. Glue between the main thread and SyncClient.
import { SyncClient, type Socket } from "./sync/client.js";

const PORTS = [8787, 8788, 8789, 8790]; // must match manifest devAllowedDomains
const PLUGIN_VERSION = "0.1.0";
const $ = (id: string) => document.getElementById(id) as HTMLElement & HTMLInputElement;
const toMain = (m: object) => parent.postMessage({ pluginMessage: m }, "*");
let fileKey: string | undefined;
let client: SyncClient | null = null;

function connect() {
  client?.stop();
  const token = $("token").value.trim();
  toMain({ kind: "saveToken", value: token });
  client = new SyncClient({
    ports: PORTS, token, pluginVersion: PLUGIN_VERSION, fileKey,
    open: (url) => new WebSocket(url) as unknown as Socket,
    timers: { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as number) },
    requestHashTree: () => toMain({ kind: "requestHashTree" }),
    onResend: (ids) => toMain({ kind: "resend", ids }),
    onChange: ({ state, badge, error }) => {
      const s = state === "ready" ? (badge ?? "connected") : state;
      $("status").textContent = error ? `${s}: ${error}` : s;
      $("status").className = state === "refused" || badge === "error" ? "err" : state === "ready" ? "ok" : "";
    },
  });
  client.start();
}
$("go").onclick = connect;

onmessage = (e) => {
  const m = e.data.pluginMessage;
  if (!m) return;
  if (m.kind === "init") { $("token").value = m.token; fileKey = m.fileKey || undefined; }
  else if (m.kind === "patch") client?.send({ type: "patch", seq: m.seq, patch: m.patch, ...(m.issues && { issues: m.issues }) });
  else if (m.kind === "selection") client?.send({ type: "selection", ids: m.ids });
  else if (m.kind === "hashTree") client?.send({ type: "hashTree", nodeHashes: m.nodeHashes });
  else if (m.kind === "error") $("status").textContent = `plugin error: ${m.message}`;
};
toMain({ kind: "ready" });
