// UI iframe: the only network access. Glue between the main thread and SyncClient.
import { isSimplePng, toBase64 } from "./sync/assets.js";
import { describeStatus, SyncClient, type Badge, type Socket, type Status } from "./sync/client.js";
import { newSecret } from "./sync/secret.js";
import { parseSwf } from "./swf/parse.js";
import { summarize, type ImportSummary } from "./swf/summary.js";

const PORTS = [8787, 8788, 8789, 8790]; // must match manifest devAllowedDomains
const PLUGIN_VERSION = "0.5.0";
const $ = (id: string) => document.getElementById(id) as HTMLElement & HTMLButtonElement;
const toMain = (m: object) => parent.postMessage({ pluginMessage: m }, "*");
let fileKey: string | undefined;
let client: SyncClient | null = null;

let last: Status = { state: "connecting" };
let frames: { id: string; name: string }[] = [];
let loose: { id: string; name: string }[] = [];
let imp = ""; // progress or error text of the SWF load
let impDone: ImportSummary | null = null; // result of the last SWF load
let busy = false; // a SWF is being read or built
let note = ""; // a plugin-side error (image, serializer); shown under the status until the next change
const BADGE_LABEL: Record<Badge | "none", [string, string]> = { synced: ["ok", "Built"], compiling: ["busy", "Building"], error: ["err", "Error"], none: ["busy", "Waiting"] };

/** The whole window: status line, then (once connected) the frames that become SWFs with their build state, and a warning for loose layers. Text only through textContent: layer names are the user's. */
function render() {
  const d = describeStatus(last);
  const live = last.state === "ready";
  $("dot").className = `dot ${d.tone}`;
  $("head").textContent = d.head;
  $("sub").textContent = live ? (last.badge === "error" ? d.sub : `${fileName || "Figma file"} \u00b7 ${frames.length} ${frames.length === 1 ? "frame" : "frames"}`) : d.sub;
  $("sub").hidden = !$("sub").textContent;
  $("retry").hidden = last.state !== "refused" && !(last.state === "denied" && last.error?.includes("Run the plugin again"));
  $("retry").textContent = last.state === "refused" ? "Try again" : "Ask again";
  const ul = $("frames");
  ul.hidden = !live || frames.length === 0;
  ul.replaceChildren(...(live ? frames : []).map((f) => {
    const [tone, label] = BADGE_LABEL[last.swfs?.[f.id] ?? "none"];
    const li = document.createElement("li");
    const dot = Object.assign(document.createElement("span"), { className: `dot ${tone}` });
    const nm = Object.assign(document.createElement("span"), { className: "nm", textContent: f.name, title: f.name });
    const st = Object.assign(document.createElement("span"), { className: "dim small", textContent: label });
    li.append(dot, nm, st);
    return li;
  }));
  const n = live ? loose.length : 0;
  renderImport();
  $("note").hidden = !(n || note);
  $("note").textContent = note || `${n} ${n === 1 ? "layer sits" : "layers sit"} outside a frame and ${n === 1 ? "is" : "are"} not sent. Put ${n === 1 ? "it" : "them"} in a frame to use ${n === 1 ? "it" : "them"}.`;
  fit();
}
const fit = () => toMain({ kind: "resize", height: Math.min(420, Math.max(70, document.getElementById("app")!.offsetHeight + 20)) });

/** Result of a SWF load: one line (name, layer count), an amber row for skipped parts that opens to a list, a row for font fallbacks. Text only through textContent: names come from the file. */
function renderImport() {
  const box = $("imp");
  box.hidden = !imp && !impDone;
  if (!impDone) {
    const kids: HTMLElement[] = imp ? [Object.assign(document.createElement("div"), { className: "dim", textContent: imp })] : [];
    if (busy) kids.push(Object.assign(document.createElement("button"), { className: "imp-cancel", textContent: "Cancel", onclick: () => { toMain({ kind: "swfCancel" }); imp = "Cancelling…"; render(); } }));
    box.replaceChildren(...kids);
    return;
  }
  const el = (tag: string, cls: string, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const row = (tone: string, text: string, extra = "") => { const r = el("div", "line"); r.append(el("span", `dot ${tone}`), el("span", "", text)); if (extra) r.lastChild!.appendChild(el("span", "dim imp-more", extra)); return r; };
  const kids: HTMLElement[] = [row("ok", impDone.title, ` · ${impDone.layers} layers${impDone.components ? `, ${impDone.components} components` : ""}`)];
  if (impDone.skippedCount) {
    const d = el("details", "") as HTMLDetailsElement;
    const s = el("summary", "");
    s.append(el("span", "dot warn"), el("span", "imp-grow", `${impDone.skippedCount} ${impDone.skippedCount === 1 ? "part" : "parts"} skipped`), el("span", "imp-chev", "›"));
    const ul = el("ul", "");
    ul.append(...impDone.skipped.map((t) => el("li", "", t)));
    d.append(s, ul);
    d.ontoggle = fit;
    kids.push(d);
  }
  if (impDone.fonts) kids.push(row("warn", impDone.fonts));
  box.replaceChildren(...kids);
}

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
    onChange: (s) => { last = s; render(); },
  });
  client.start();
}
$("retry").onclick = connect;

const stream = async (b: Uint8Array, t: TransformStream<Uint8Array, Uint8Array>) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
const inflate = (b: Uint8Array) => stream(b, new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
const deflate = (b: Uint8Array) => stream(b, new CompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
/** JPEG -> pixels through a canvas, so the SWF's separate alpha plane can be merged in. */
async function decodeJpeg(jpeg: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  return { w: c.width, h: c.height, rgba: new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer.slice(0)) };
}

async function loadFile(f: File) {
  if (busy) return;
  impDone = null;
  if (!/\.swf$/i.test(f.name)) { imp = `${f.name} is not a .swf file`; render(); return; }
  busy = true;
  $("load").disabled = true;
  imp = `Reading ${f.name}…`;
  render();
  try {
    toMain({ kind: "importSwf", model: await parseSwf(new Uint8Array(await f.arrayBuffer()), inflate, f.name.replace(/\.swf$/i, ""), { decodeJpeg, deflate }) });
    imp = "Building…";
    render();
  } catch (e) { busy = false; imp = `${f.name}: ${(e as Error).message}`; $("load").disabled = false; render(); }
}
$("load").onclick = () => $("file").click();
$("file").onchange = () => {
  const input = $("file") as unknown as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f) void loadFile(f);
};
// dropping a .swf anywhere on the panel loads it, like the button
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drop"); });
document.addEventListener("dragleave", () => document.body.classList.remove("drop"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drop");
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

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
  else if (m.kind === "swfs") { frames = m.frames; loose = m.loose; render(); client?.send({ type: "swfs", frames: m.frames, loose: m.loose, components: m.components, componentTrees: m.componentTrees }); }
  else if (m.kind === "asset") void toPng(m.bytes).then(
    (png) => client?.send({ type: "asset", hash: m.hash, data: toBase64(png) }),
    (e) => { note = `Image ${m.hash.slice(0, 8)}: ${e}`; render(); },
  );
  else if (m.kind === "swfProgress") { imp = `Building ${m.done} of ${m.total} layers…`; render(); }
  else if (m.kind === "swfImported") {
    busy = false;
    $("load").disabled = false;
    imp = m.cancelled ? "Import cancelled" : "";
    impDone = m.cancelled ? null : summarize(m);
    render();
  }
  else if (m.kind === "error") {
    busy = false;
    $("load").disabled = false; note = `Plugin error: ${m.message}`; render(); }
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
render();
toMain({ kind: "ready" });
