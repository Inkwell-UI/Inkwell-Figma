import type { Node, PatchOp, SyncIssue } from "@inkwell-ui/spec";
// deep import: the package root pulls in zod (~800 KB); the main thread only needs the hash
import { hashNode } from "@inkwell-ui/spec/dist/hash.js";
import { serializeNode, serializeTree, type Ctx, type FigNode } from "../serialize/index.js";
import type { IdMap } from "./idmap.js";

export interface PatchMessage { seq: number; patch: { ops: PatchOp[] }; issues?: SyncIssue[] }
// async because dynamic-page mode only offers getNodeByIdAsync
type Live = (figmaId: string) => Promise<FigNode | null>;
const isScoped = (p?: { type: string } | null) => !!p && p.type !== "PAGE" && p.type !== "DOCUMENT";

/** Keeps the last-sent IR per node and turns "these Figma ids changed" into the smallest patch. */
export class Syncer {
  private cache = new Map<string, Node>();
  private hashes = new Map<string, string>();
  private seq = 0;
  private ctx: Ctx;
  constructor(private idMap: IdMap, componentOf: Ctx["componentOf"]) {
    this.ctx = { id: (n) => idMap.id(n), componentOf };
  }

  hashTree(): Record<string, string> { return Object.fromEntries(this.hashes); }

  /** Changed (or deleted) Figma ids -> patch of only the affected nodes, or null when nothing differs. */
  async flush(dirty: Iterable<string>, live: Live): Promise<PatchMessage | null> {
    const next = new Map<string, Node>();
    const gone: string[] = [];
    const shallow = (n: FigNode) => { const s = serializeNode(n, this.ctx); if (!next.has(s.id)) next.set(s.id, s); };
    for (const fid of dirty) {
      const n = await live(fid);
      if (!n) {
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
    }
    await this.adoptMoved(next, live);
    return this.commit(next, gone, live);
  }

  /** Whole-scope reconcile (startup, page switch). Anything cached but absent from `roots` is removed. */
  scan(roots: readonly FigNode[]): Promise<PatchMessage | null> {
    const next = new Map<string, Node>();
    for (const r of roots) for (const x of serializeTree(r, this.ctx)) next.set(x.id, x);
    return this.commit(next, [...this.cache.keys()].filter((k) => !next.has(k)), null);
  }

  /** Editor asked for these ids: fresh subtrees regardless of the cache; dead ids become removes. */
  async resend(ids: readonly string[], live: Live): Promise<PatchMessage | null> {
    const ops: PatchOp[] = [];
    for (const id of ids) {
      const n = await live(this.idMap.figmaOf(id) ?? id);
      if (!n) { ops.push({ op: "remove", id }); this.drop(id); continue; }
      for (const x of serializeTree(n, this.ctx)) { ops.push({ op: "upsert", node: x }); this.store(x); }
    }
    return ops.length ? this.wrap(ops) : null;
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

  private async commit(next: Map<string, Node>, gone: string[], live: Live | null): Promise<PatchMessage | null> {
    const removed = new Set(gone);
    for (const x of next.values()) for (const c of this.cache.get(x.id)?.children ?? []) {
      if (x.children.includes(c)) continue;
      if (!live || !(await live(this.idMap.figmaOf(c) ?? c))) removed.add(c); // still alive elsewhere = moved, not removed
    }
    const tops = [...removed].filter((id) => { const p = this.cache.get(id)?.parent; return !(p && removed.has(p)); });
    const ops: PatchOp[] = [];
    const moves: PatchOp[] = [];
    const rems: PatchOp[] = [];
    for (const [id, node] of next) {
      const old = this.cache.get(id);
      const h = hashNode(node);
      if (this.hashes.get(id) === h) continue;
      const idx = node.parent ? (next.get(node.parent) ?? this.cache.get(node.parent))?.children.indexOf(id) ?? -1 : -1;
      // only the parent changed: a move is enough, no need to resend the node
      if (old && node.parent && idx >= 0 && hashNode({ ...node, parent: old.parent }) === this.hashes.get(id)) moves.push({ op: "move", id, parent: node.parent, index: idx });
      else ops.push({ op: "upsert", node });
    }
    for (const id of tops) if (this.cache.has(id)) rems.push({ op: "remove", id });
    for (const x of next.values()) this.store(x);
    for (const id of tops) this.drop(id);
    const all = [...ops, ...moves, ...rems];
    return all.length ? this.wrap(all) : null;
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
  private wrap(ops: PatchOp[]): PatchMessage {
    const issues = this.idMap.takeIssues();
    return { seq: ++this.seq, patch: { ops }, ...(issues.length && { issues }) };
  }
}
