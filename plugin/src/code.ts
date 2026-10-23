// Main thread: watches the current page, serializes changes to IR patches, hands them to the UI iframe
// (the only place with network access). It only reports visuals; it never stores behavior.
import type { FigNode } from "./serialize/index.js";
import { collector } from "./sync/debounce.js";
import { IdMap, type MappingStore } from "./sync/idmap.js";
import { Syncer } from "./sync/syncer.js";

const NS = "inkwell";
const store: MappingStore = {
  get: (n) => (n as unknown as BaseNode).getSharedPluginData(NS, "id") || undefined,
  set: (n, ir) => (n as unknown as BaseNode).setSharedPluginData(NS, "id", ir),
};
const components = new Map<string, string>(); // instance id -> main component id (async API, prefetched)
const idMap = new IdMap(store);
const syncer = new Syncer(idMap, (n) => components.get(n.id));

const live = async (id: string): Promise<FigNode | null> => {
  const n = await figma.getNodeByIdAsync(id);
  return n && !n.removed && n.type !== "PAGE" && n.type !== "DOCUMENT" ? (n as unknown as FigNode) : null;
};
async function prefetch(n: any): Promise<void> {
  if (n.type === "INSTANCE") { const m = await n.getMainComponentAsync(); if (m) components.set(n.id, m.id); }
  for (const c of n.children ?? []) await prefetch(c);
}
const post = (m: object) => figma.ui.postMessage(m);

// Serialize runs so patches keep their order.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn).catch((e) => post({ kind: "error", message: String(e) })); };

const changes = collector(150, (ids) => enqueue(async () => {
  for (const id of ids) { const n = await live(id); if (n) await prefetch(n); }
  const p = await syncer.flush(ids, live);
  if (p) post({ kind: "patch", ...p });
}));

// Per-page `nodechange` (not `documentchange`): with documentAccess "dynamic-page" documentchange needs every
// page loaded (figma.loadAllPagesAsync), which is slow on big files. Scope is the current page.
let page = figma.currentPage;
const onNodeChange = (e: NodeChangeEvent) => { for (const c of e.nodeChanges) changes.add(c.id); };
page.on("nodechange", onNodeChange);

async function scan(emit: boolean) {
  await prefetch(figma.currentPage);
  const p = await syncer.scan(figma.currentPage.children as unknown as FigNode[]);
  if (emit && p) post({ kind: "patch", ...p });
}
figma.on("currentpagechange", () => enqueue(async () => {
  page.off("nodechange", onNodeChange);
  page = figma.currentPage;
  await page.loadAsync();
  page.on("nodechange", onNodeChange);
  await scan(true);
}));
figma.on("selectionchange", () => post({ kind: "selection", ids: figma.currentPage.selection.map((n) => idMap.id(n)) }));

figma.showUI(__html__, { width: 300, height: 190 });
figma.ui.onmessage = (m: { kind: string; value?: string; ids?: string[] }) => {
  if (m.kind === "ready") enqueue(async () => post({ kind: "init", token: (await figma.clientStorage.getAsync("token")) ?? "", fileKey: figma.fileKey }));
  else if (m.kind === "saveToken") void figma.clientStorage.setAsync("token", m.value);
  else if (m.kind === "requestHashTree") enqueue(async () => post({ kind: "hashTree", nodeHashes: syncer.hashTree() }));
  else if (m.kind === "resend") enqueue(async () => { const p = await syncer.resend(m.ids ?? [], live); if (p) post({ kind: "patch", ...p }); });
};
enqueue(() => scan(false)); // baseline only; the editor gets the state through the hash tree on connect
