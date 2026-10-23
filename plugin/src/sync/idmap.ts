import type { SyncIssue } from "@inkwell-ui/spec";

/** Tiny injected storage; in Figma this wraps getSharedPluginData/setSharedPluginData("inkwell", "id"). */
export interface MappingStore {
  get(node: { id: string }): string | undefined;
  set(node: { id: string }, irId: string): void;
}

/**
 * Figma node -> IR id. The IR id is written into the node's shared plugin data so it travels with the file.
 * Copy/paste duplicates the stored value onto a node with a new Figma id: when a second live node claims an
 * id already owned, it gets its own id and a `duplicate_id` issue (clonedFrom = the source) is reported.
 * shortcut: first node seen wins a conflict, so on a cold start the copy can claim the id before the original;
 * live pastes (original already seen) resolve correctly.
 */
export class IdMap {
  private owners = new Map<string, string>(); // ir id -> figma id
  private byFigma = new Map<string, string>(); // figma id -> ir id
  private issues: SyncIssue[] = [];
  constructor(private store: MappingStore) {}

  id(n: { id: string }): string {
    const known = this.byFigma.get(n.id);
    if (known !== undefined) return known;
    const stored = this.store.get(n);
    let ir = stored ?? n.id;
    const owner = this.owners.get(ir);
    if (owner !== undefined && owner !== n.id) {
      this.issues.push({ code: "duplicate_id", message: `Node ${n.id} is a copy of ${ir}; it was given a new id.`, nodeId: n.id, clonedFrom: ir });
      ir = n.id;
    }
    if (ir !== stored) this.store.set(n, ir);
    this.owners.set(ir, n.id);
    this.byFigma.set(n.id, ir);
    return ir;
  }
  irOf(figmaId: string): string | undefined { return this.byFigma.get(figmaId); }
  figmaOf(irId: string): string | undefined { return this.owners.get(irId); }
  release(irId: string) {
    const f = this.owners.get(irId);
    this.owners.delete(irId);
    if (f !== undefined) this.byFigma.delete(f);
  }
  takeIssues(): SyncIssue[] { return this.issues.splice(0); }
}
