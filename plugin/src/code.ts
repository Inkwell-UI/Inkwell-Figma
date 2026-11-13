// Main thread: watches the current page, serializes changes to IR patches, hands them to the UI iframe
// (the only place with network access). It only reports visuals; it never stores behavior.
import { collectThemes, modeNameResolver, type FigNode, type VariablesApi } from "./serialize/index.js";
import { collector } from "./sync/debounce.js";
import { isSecret, newSecret } from "./sync/secret.js";
import { IdMap, type MappingStore } from "./sync/idmap.js";
import { selectNode } from "./sync/select.js";
import { Syncer } from "./sync/syncer.js";
import { buildSwf } from "./swf/build.js";
import type { SwfModel } from "./swf/model.js";

const NS = "inkwell";
const store: MappingStore = {
  get: (n) => (n as unknown as BaseNode).getSharedPluginData(NS, "id") || undefined,
  set: (n, ir) => (n as unknown as BaseNode).setSharedPluginData(NS, "id", ir),
};
const components = new Map<string, string>(); // instance id -> main component id (async API, prefetched)
const styleNames = new Map<string, string>(); // text node id -> text style name (async API, prefetched)
const idMap = new IdMap(store);
const syncer = new Syncer(idMap, (n) => components.get(n.id), (n) => styleNames.get(n.id));

const live = async (id: string): Promise<FigNode | null> => {
  const n = await figma.getNodeByIdAsync(id);
  return n && !n.removed && n.type !== "PAGE" && n.type !== "DOCUMENT" ? (n as unknown as FigNode) : null;
};
async function prefetch(n: any): Promise<void> {
  if (n.type === "INSTANCE") { const m = await n.getMainComponentAsync(); if (m) components.set(n.id, m.id); }
  if (n.type === "TEXT" && typeof n.textStyleId === "string" && n.textStyleId) {
    const st = await figma.getStyleByIdAsync(n.textStyleId);
    if (st) styleNames.set(n.id, st.name); else styleNames.delete(n.id);
  } else if (n.type === "TEXT") styleNames.delete(n.id);
  for (const c of n.children ?? []) await prefetch(c);
}
let swfCancel = false;
const post = (m: object) => figma.ui.postMessage(m);
const postPatches = (ps: object[]) => { for (const p of ps) post({ kind: "patch", ...p }); };
// Tell the editor which top-level frames exist and which loose layers belong to none; only when it changed.
let lastSwfs = "";
const postSwfs = (force = false) => {
  const s = syncer.swfs(figma.currentPage.children as unknown as FigNode[]);
  const componentTrees = syncer.componentTrees(figma.currentPage.children as unknown as FigNode[]);
  const j = JSON.stringify([s, componentTrees]);
  if (force || j !== lastSwfs) { lastSwfs = j; post({ kind: "swfs", ...s, componentTrees }); }
};

// Figma variable collections -> themes (SPEC-CHANGES V6). Variable edits raise no node change, so they are polled; a change re-sends the metadata of every SWF.
const variablesApi: VariablesApi = {
  collections: async () => (await figma.variables.getLocalVariableCollectionsAsync()) as any,
  variable: async (id) => (await figma.variables.getVariableByIdAsync(id)) as any,
};
let lastThemes = "";
async function refreshThemes(force = false): Promise<void> {
  const themes = await collectThemes(variablesApi);
  const j = JSON.stringify(themes);
  syncer.setThemes(themes);
  syncer.setModeNames(modeNameResolver(await variablesApi.collections()));
  if (force || j !== lastThemes) { lastThemes = j; postPatches(syncer.metaPatches()); }
}

// Serialize runs so patches keep their order.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn).catch((e) => post({ kind: "error", message: String(e) })); };

const changes = collector(150, (ids) => enqueue(async () => {
  for (const id of ids) { const n = await live(id); if (n) await prefetch(n); }
  await refreshThemes(); // before the patches: their metadata carries the themes
  postPatches(await syncer.flush(ids, live));
  postSwfs();
}));

// Per-page `nodechange` (not `documentchange`): with documentAccess "dynamic-page" documentchange needs every
// page loaded (figma.loadAllPagesAsync), which is slow on big files. Scope is the current page.
let page = figma.currentPage;
const onNodeChange = (e: NodeChangeEvent) => { for (const c of e.nodeChanges) changes.add(c.id); };
page.on("nodechange", onNodeChange);

async function scan(emit: boolean) {
  await prefetch(figma.currentPage);
  await refreshThemes();
  const ps = await syncer.scan(figma.currentPage.children as unknown as FigNode[]);
  if (emit) { postPatches(ps); postSwfs(); }
}
figma.on("currentpagechange", () => enqueue(async () => {
  page.off("nodechange", onNodeChange);
  page = figma.currentPage;
  await page.loadAsync();
  page.on("nodechange", onNodeChange);
  await scan(true);
}));
figma.on("selectionchange", () => post({ kind: "selection", ids: figma.currentPage.selection.map((n) => idMap.id(n)) }));

figma.showUI(__html__, { width: 300, height: 110, themeColors: true });
figma.ui.onmessage = (m: { kind: string; value?: string; ids?: string[]; swfId?: string; hashes?: string[]; nodeId?: string; focus?: boolean; height?: number; model?: SwfModel }) => {
  if (m.kind === "ready") enqueue(async () => {
    // The secret is made once and kept in clientStorage; the editor stores only its SHA-256 after the user allowed it.
    let secret = await figma.clientStorage.getAsync("pluginSecret");
    if (!isSecret(secret)) {
      // shortcut: if this sandbox has no `crypto`, the UI iframe makes the secret and sends it back (saveSecret); unverified in real Figma
      secret = typeof crypto !== "undefined" ? newSecret((a) => crypto.getRandomValues(a)) : "";
      if (secret) await figma.clientStorage.setAsync("pluginSecret", secret);
    }
    post({ kind: "init", secret, fileName: figma.root.name, fileKey: figma.fileKey });
  });
  else if (m.kind === "resize" && typeof m.height === "number") figma.ui.resize(300, Math.round(Math.min(420, Math.max(70, m.height))));
  else if (m.kind === "saveSecret" && isSecret(m.value)) void figma.clientStorage.setAsync("pluginSecret", m.value);
  else if (m.kind === "requestHashTree") enqueue(async () => {
    postSwfs(true);
    await refreshThemes(true); // a fresh connection gets the themes whether or not a layer changes
    for (const [swfId, nodeHashes] of Object.entries(syncer.hashTrees())) post({ kind: "hashTree", swfId, nodeHashes });
  });
  // A SWF read by the UI becomes one new top-level frame; the normal change tracking then syncs it like any hand-drawn frame.
  else if (m.kind === "importSwf" && m.model) enqueue(async () => {
    swfCancel = false;
    const r = await buildSwf(m.model!, figma, { progress: (done, total) => post({ kind: "swfProgress", done, total }), cancelled: () => swfCancel });
    if (!r) { post({ kind: "swfImported", cancelled: true }); return; }
    figma.currentPage.selection = [r.root];
    figma.viewport.scrollAndZoomIntoView([r.root]);
    post({ kind: "swfImported", name: r.root.name, frames: r.frames, shapes: r.shapes, texts: r.texts, components: r.components, fonts: r.fallbackFonts, warnings: r.warnings });
  });
  else if (m.kind === "swfCancel") swfCancel = true; // not queued: it must reach the build that is running
  else if (m.kind === "resend") enqueue(async () => { const p = await syncer.resend(m.swfId ?? "", m.ids ?? [], live); if (p) postPatches([p]); });
  else if (m.kind === "selectNode" && typeof m.nodeId === "string") void selectNode(figma as any, m.nodeId, m.focus === true)
    .then((ok) => { if (!ok) figma.notify("Inkwell: that layer is not on this page any more", { timeout: 2000 }); })
    .catch(() => {});
  // Image bytes by hash, only for hashes the editor asked for (it caches them on disk, so this runs once per image).
  else if (m.kind === "needAssets") void (async () => {
    for (const hash of m.hashes ?? []) {
      try {
        const bytes = await figma.getImageByHash(hash)?.getBytesAsync();
        if (bytes) post({ kind: "asset", hash, bytes });
        else post({ kind: "error", message: `image ${hash} is not in this file` });
      } catch (e) { post({ kind: "error", message: `image ${hash}: ${e}` }); }
    }
  })();
};
setInterval(() => enqueue(() => refreshThemes()), 3000); // shortcut: variables have no change event; a poll every 3 s, cheap when nothing changed
enqueue(() => scan(false)); // baseline only; the editor gets the state through the hash tree on connect
