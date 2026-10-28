import type { Node, PatchOp, SwfMeta, SyncIssue, Theme } from "@inkwell-ui/spec";
// deep import: the package root pulls in zod (~800 KB); the main thread only needs the hash
import { hashNode } from "@inkwell-ui/spec/dist/hash.js";
import { serializeNode, serializeTree, type Ctx, type FigNode } from "../serialize/index.js";
import type { IdMap } from "./idmap.js";

/** One patch for one SWF (= one top-level Figma frame); `swf` rides along when the root is upserted. */
export interface PatchMessage { seq: number; swfId: string; swf?: SwfMeta; patch: { ops: PatchOp[] }; issues?: SyncIssue[] }
export interface Swfs { frames: { id: string; name: string }[]; loose: { id: string; name: string }[] }
// async because dynamic-page mode only offers getNodeByIdAsync
type Live = (figmaId: string) => Promise<FigNode | null>;
const isScoped = (p?: { type: string } | null) => !!p && p.type !== "PAGE" && p.type !== "DOCUMENT";
// Only top-level FRAMEs are SWFs. Anything else directly on the page (and its subtree) is "loose" and never synced.
const isLoose = (n: FigNode) => {
  let t: { type: string; parent?: any } = n;
  while (isScoped(t.parent)) t = t.parent;
  return t.type !== "FRAME";
};

/** Keeps the last-sent IR per node and turns "these Figma ids changed" into the smallest patch per SWF. */
export class Syncer {
  private cache = new Map<string, Node>();
  private hashes = new Map<string, string>();
  private seq = 0;
  private ctx: Ctx;
  private themes: Theme[] | undefined; // Figma variable collections (SPEC-CHANGES V6); undefined until the main thread has read them
  constructor(private idMap: IdMap, componentOf: Ctx["componentOf"], styleNameOf?: Ctx["styleNameOf"]) {
    this.ctx = { id: (n) => idMap.id(n), componentOf, styleNameOf };
  }

  /** swfId (top-level frame IR id) -> node id -> hash. */
  hashTrees(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [id, h] of this.hashes) {
      const swf = this.rootOf(id, this.cache);
      if (swf) (out[swf] ??= {})[id] = h;
    }
    return out;
  }

  /** Sets the variable collections that ride on every SWF's metadata. */
  setThemes(themes: Theme[]): void { this.themes = themes; }

  /** One patch with no ops and the metadata (name, stage, themes) per known SWF: sent when only the variables changed. */
  metaPatches(): PatchMessage[] {
    const out: PatchMessage[] = [];
    for (const n of this.cache.values()) if (n.parent === null) out.push({ seq: ++this.seq, swfId: n.id, swf: this.meta(n), patch: { ops: [] } });
    return out;
  }

  private meta(root: Node): SwfMeta {
    return { id: root.id, name: root.name, stage: { width: root.transform.width, height: root.transform.height }, ...(this.themes && { themes: this.themes }) };
  }

  /** Frames that become SWFs, and loose top-level layers that belong to none. A component kept off the design (to be added by code) is neither: it is not a stray layer. */
  swfs(top: readonly FigNode[]): Swfs {
    const r: Swfs = { frames: [], loose: [] };
    for (const n of top) if (n.type !== "COMPONENT" && n.type !== "COMPONENT_SET") (n.type === "FRAME" ? r.frames : r.loose).push({ id: this.idMap.id(n), name: n.name });
    return r;
  }

  private rootOf(id: string, ...maps: Map<string, Node>[]): string | undefined {
    let cur: string | null = id;
    for (let i = 0; cur !== null && i < 10000; i++) {
      const c: string = cur;
      const n: Node | undefined = maps.map((m) => m.get(c)).find(Boolean);
      if (!n) return undefined;
      if (n.parent === null) return n.id;
      cur = n.parent;
    }
    return undefined;
  }

  /** Changed (or deleted) Figma ids -> one patch per affected SWF; empty when nothing differs. */
  async flush(dirty: Iterable<string>, live: Live): Promise<PatchMessage[]> {
    const next = new Map<string, Node>();
    const gone: string[] = [];
    const shallow = (n: FigNode) => { const s = serializeNode(n, this.ctx); if (!next.has(s.id)) next.set(s.id, s); };
    for (const fid of dirty) {
      const n = await live(fid);
      if (!n || isLoose(n)) {
        const ir = this.idMap.irOf(fid) ?? fid;
        gone.push(ir);
        const p = this.cache.get(ir)?.parent;
        const pn = p ? await live(this.idMap.figmaOf(p) ?? p) : null;
        if (pn) shallow(pn);
        continue;
      }
      for (const x of serializeTree(n, this.ctx)) next.set(x.id, x);
      const pn = isScoped(n.parent) ? await live(n.parent!.id) : null;
      if (pn) shallow(pn); // its children array may have changed
      const oldParent = this.cache.get(this.idMap.id(n))?.parent; // moved: the old parent's children changed too
      const opn = oldParent && oldParent !== (pn && this.idMap.id(pn)) ? await live(this.idMap.figmaOf(oldParent) ?? oldParent) : null;
      if (opn) shallow(opn);
    }
    await this.adoptMoved(next, live);
    return this.commit(next, gone, live);
  }

  /** Whole-scope reconcile (startup, page switch). Anything cached but absent from `roots` is removed. */
  scan(roots: readonly FigNode[]): Promise<PatchMessage[]> {
    const next = new Map<string, Node>();
    for (const r of roots) if (!isLoose(r)) for (const x of serializeTree(r, this.ctx)) next.set(x.id, x);
    return this.commit(next, [...this.cache.keys()].filter((k) => !next.has(k)), null);
  }

  /** Editor asked for these ids of one SWF: fresh subtrees regardless of the cache; dead ids become removes. */
  async resend(swfId: string, ids: readonly string[], live: Live): Promise<PatchMessage | null> {
    const ops: PatchOp[] = [];
    for (const id of ids) {
      const n = await live(this.idMap.figmaOf(id) ?? id);
      if (!n || isLoose(n)) { ops.push({ op: "remove", id }); this.drop(id); continue; }
      for (const x of serializeTree(n, this.ctx)) { ops.push({ op: "upsert", node: x }); this.store(x); }
    }
    return ops.length ? this.wrap(swfId, ops, this.cache.get(swfId)) : null;
  }

  // A node listed as a child here but cached under another parent was moved in without being dirty itself.
  private async adoptMoved(next: Map<string, Node>, live: Live) {
    for (const x of [...next.values()]) for (const c of x.children) {
      const old = this.cache.get(c);
      if (next.has(c) || !old || old.parent === x.id) continue;
      const n = await live(this.idMap.figmaOf(c) ?? c);
      if (n) next.set(c, serializeNode(n, this.ctx));
    }
  }

  private async commit(next: Map<string, Node>, gone: string[], live: Live | null): Promise<PatchMessage[]> {
    const removed = new Set(gone);
    for (const x of next.values()) for (const c of this.cache.get(x.id)?.children ?? []) {
      if (x.children.includes(c)) continue;
      if (!live || !(await live(this.idMap.figmaOf(c) ?? c))) removed.add(c); // still alive elsewhere = moved, not removed
    }
    const tops = [...removed].filter((id) => { const p = this.cache.get(id)?.parent; return !(p && removed.has(p)); });
    // A node that changed top-level frame (dragged into another frame) is removed from the old SWF and upserted whole into the new one.
    const force = new Set<string>();
    const crossed: { id: string; from: string }[] = [];
    for (const [id, node] of [...next]) {
      const from = this.cache.has(id) ? this.rootOf(id, this.cache) : undefined;
      if (from === undefined || node.parent === null || from === this.rootOf(id, next, this.cache)) continue;
      crossed.push({ id, from });
      const stack = [id];
      while (stack.length) {
        const c = stack.pop()!;
        force.add(c);
        const cn = next.get(c) ?? this.cache.get(c);
        if (cn) { if (!next.has(c)) next.set(c, cn); stack.push(...cn.children); }
      }
    }
    const per = new Map<string, { ops: PatchOp[]; moves: PatchOp[]; rems: PatchOp[] }>();
    const bucket = (swf: string) => { let b = per.get(swf); if (!b) per.set(swf, (b = { ops: [], moves: [], rems: [] })); return b; };
    for (const [id, node] of next) {
      const old = this.cache.get(id);
      const h = hashNode(node);
      if (!force.has(id) && this.hashes.get(id) === h) continue;
      const swf = this.rootOf(id, next, this.cache);
      if (!swf) continue;
      const idx = node.parent ? (next.get(node.parent) ?? this.cache.get(node.parent))?.children.indexOf(id) ?? -1 : -1;
      // only the parent changed: a move is enough, no need to resend the node
      if (!force.has(id) && old && node.parent && idx >= 0 && hashNode({ ...node, parent: old.parent }) === this.hashes.get(id)) bucket(swf).moves.push({ op: "move", id, parent: node.parent, index: idx });
      else bucket(swf).ops.push({ op: "upsert", node });
    }
    for (const { id, from } of crossed) bucket(from).rems.push({ op: "remove", id });
    for (const id of tops) { const swf = this.rootOf(id, this.cache); if (swf) bucket(swf).rems.push({ op: "remove", id }); }
    const rootNode = (swf: string) => next.get(swf) ?? this.cache.get(swf);
    const out: PatchMessage[] = [];
    for (const [swf, b] of per) {
      const all = [...b.ops, ...b.moves, ...b.rems];
      if (all.length) out.push(this.wrap(swf, all, rootNode(swf)));
    }
    for (const x of next.values()) this.store(x);
    for (const id of tops) this.drop(id);
    return out;
  }

  private store(n: Node) { this.cache.set(n.id, n); this.hashes.set(n.id, hashNode(n)); }
  private drop(id: string) {
    const n = this.cache.get(id);
    if (!n) return;
    this.cache.delete(id);
    this.hashes.delete(id);
    this.idMap.release(id);
    for (const c of n.children) this.drop(c);
  }
  private wrap(swfId: string, ops: PatchOp[], root?: Node): PatchMessage {
    const issues = this.idMap.takeIssues();
    const meta = root && ops.some((o) => o.op === "upsert" && o.node.id === swfId)
      ? { swf: this.meta(root) } : {};
    return { seq: ++this.seq, swfId, ...meta, patch: { ops }, ...(issues.length && { issues }) };
  }
}
