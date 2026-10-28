// UI iframe: the only network access. Glue between the main thread and SyncClient.
import { isSimplePng, toBase64 } from "./sync/assets.js";
import { statusText, SyncClient, type Socket } from "./sync/client.js";
import { newSecret } from "./sync/secret.js";

const PORTS = [8787, 8788, 8789, 8790]; // must match manifest devAllowedDomains
const PLUGIN_VERSION = "0.5.0";
const $ = (id: string) => document.getElementById(id) as HTMLElement & HTMLButtonElement;
const toMain = (m: object) => parent.postMessage({ pluginMessage: m }, "*");
let fileKey: string | undefined;
let client: SyncClient | null = null;

let secret = "";
let fileName = "";

/** Starts by itself once the main thread has sent the secret: no token, no button. The editor asks the user the first time. */
function connect() {
  client?.stop();
  client = new SyncClient({
    ports: PORTS, pluginSecret: secret, fileName, pluginVersion: PLUGIN_VERSION, fileKey,
    open: (url) => new WebSocket(url) as unknown as Socket,
    timers: { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as number) },
    requestHashTree: () => toMain({ kind: "requestHashTree" }),
    onResend: (swfId, ids) => toMain({ kind: "resend", swfId, ids }),
    onSelectNode: (nodeId, focus) => toMain({ kind: "selectNode", nodeId, focus }),
    onNeedAssets: (hashes) => toMain({ kind: "needAssets", hashes }),
    onChange: (s) => {
      $("status").textContent = statusText(s);
      $("status").className = s.state === "refused" || s.state === "denied" || s.badge === "error" ? "err" : s.state === "ready" ? "ok" : s.state === "pending" ? "wait" : "";
      $("retry").hidden = s.state !== "refused" && s.state !== "denied";
    },
  });
  client.start();
}
$("retry").onclick = connect;

onmessage = (e) => {
  const m = e.data.pluginMessage;
  if (!m) return;
  if (m.kind === "init") {
    fileKey = m.fileKey || undefined;
    fileName = m.fileName ?? "";
    secret = m.secret || newSecret((a) => crypto.getRandomValues(a)); // the main thread had no crypto: make it here
    if (!m.secret) toMain({ kind: "saveSecret", value: secret });
    connect();
  }
  else if (m.kind === "patch") client?.send({ type: "patch", seq: m.seq, swfId: m.swfId, ...(m.swf && { swf: m.swf }), patch: m.patch, ...(m.issues && { issues: m.issues }) });
  else if (m.kind === "selection") client?.send({ type: "selection", ids: m.ids });
  else if (m.kind === "hashTree") client?.send({ type: "hashTree", swfId: m.swfId, nodeHashes: m.nodeHashes });
  else if (m.kind === "swfs") client?.send({ type: "swfs", frames: m.frames, loose: m.loose, components: m.components, componentTrees: m.componentTrees });
  else if (m.kind === "asset") void toPng(m.bytes).then(
    (png) => client?.send({ type: "asset", hash: m.hash, data: toBase64(png) }),
    (e) => { $("status").textContent = `image ${m.hash.slice(0, 8)}: ${e}`; },
  );
  else if (m.kind === "error") $("status").textContent = `plugin error: ${m.message}`;
};

/** Figma hands back the original upload (PNG, JPEG, GIF...); the editor takes plain PNGs, so re-encode anything else through a canvas. */
async function toPng(bytes: Uint8Array): Promise<Uint8Array> {
  if (isSimplePng(bytes)) return bytes;
  const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  return new Uint8Array(await blob.arrayBuffer());
}
toMain({ kind: "ready" });
