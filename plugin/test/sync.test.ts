import { describe, expect, it, vi } from "vitest";
import { Patch, applyPatch, type Swf } from "@inkwell-ui/spec";
import { collector } from "../src/sync/debounce.js";
import { IdMap } from "../src/sync/idmap.js";
import { Syncer, type PatchMessage } from "../src/sync/syncer.js";
import type { FigNode } from "../src/serialize/index.js";

// A tiny fake document: ids -> nodes with parent/children kept consistent by helpers.
function doc() {
  const nodes = new Map<string, FigNode>();
  const page = { id: "0:1", type: "PAGE" };
  const add = (id: string, parent: FigNode | null, extra: Partial<FigNode> = {}) => {
    const n: FigNode = { id, name: id, type: "FRAME", width: 10, height: 10, children: [], parent: parent ?? page, ...extra };
    nodes.set(id, n);
    if (parent) (parent.children as FigNode[]).push(n);
    return n;
  };
  const remove = (id: string) => {
    const n = nodes.get(id)!;
    const sibs = n.parent && (nodes.get(n.parent.id)?.children as FigNode[] | undefined);
    sibs?.splice(sibs.indexOf(n), 1);
    const drop = (x: FigNode) => { nodes.delete(x.id); x.children?.forEach(drop); };
    drop(n);
  };
  const roots = () => [...nodes.values()].filter((n) => n.parent === page);
  return { nodes, add, remove, roots, live: async (id: string) => nodes.get(id) ?? null };
}
const mem = () => {
  const m = new Map<string, string>();
  return { m, store: { get: (n: { id: string }) => m.get(n.id), set: (n: { id: string }, v: string) => void m.set(n.id, v) } };
};
const setup = (styleNameOf?: (n: FigNode) => string | undefined) => { const d = doc(), s = mem(); const syncer = new Syncer(new IdMap(s.store), () => undefined, styleNameOf); return { d, s, syncer }; };
const first = async (p: Promise<PatchMessage[]>) => (await p)[0] ?? null;

describe("collector (debounce)", () => {
  it("flushes the union once, 150ms after the last change", () => {
    vi.useFakeTimers();
    const got: string[][] = [];
    const c = collector(150, (ids) => got.push([...ids]));
    c.add("a"); vi.advanceTimersByTime(100); c.add("b"); c.add("a"); vi.advanceTimersByTime(149);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(got).toEqual([["a", "b"]]);
    vi.useRealTimers();
  });
});

describe("Syncer", () => {
  it("emits only changed subtrees, valid against the spec, and applies cleanly", async () => {
    const { d, syncer } = setup();
    const root = d.add("1:1", null), a = d.add("1:2", root), b = d.add("1:3", root);
    d.add("1:4", a);
    expect(await first(syncer.scan(d.roots()))).toMatchObject({ seq: 1, swfId: "1:1" });
    expect(await syncer.flush(["1:2"], d.live)).toEqual([]); // nothing actually changed

    a.width = 99;
    const p = (await first(syncer.flush(["1:2"], d.live)))!;
    Patch.parse(p.patch);
    expect(p.patch.ops.map((o) => (o as any).node?.id)).toEqual(["1:2"]); // child 1:4 unchanged, so not resent

    const n = d.add("1:5", b); d.add("1:6", n);
    const p2 = (await first(syncer.flush(["1:5"], d.live)))!;
    Patch.parse(p2.patch);
    expect(p2.patch.ops.map((o: any) => o.node.id).sort()).toEqual(["1:3", "1:5", "1:6"]); // new subtree + parent's children

    // replaying a full scan on an empty swf reproduces the document
    const swf = { specVersion: 1, id: "s", name: "s", target: { kind: "hudWidget" }, stage: { width: 1, height: 1 }, root: "1:1", nodes: {} } as unknown as Swf;
    const full = (await first(setup().syncer.scan(d.roots())))!;
    expect(Object.keys(applyPatch(swf, full.patch).nodes).sort()).toEqual(["1:1", "1:2", "1:3", "1:4", "1:5", "1:6"]);
  });

  it("deleted nodes become remove and the parent is updated", async () => {
    const { d, syncer } = setup();
    const root = d.add("1:1", null), a = d.add("1:2", root);
    d.add("1:4", a);
    await syncer.scan(d.roots());
    d.remove("1:2");
    const p = (await first(syncer.flush(["1:2"], d.live)))!;
    Patch.parse(p.patch);
    expect(p.patch.ops).toMatchObject([{ op: "upsert", node: { id: "1:1", children: [] } }, { op: "remove", id: "1:2" }]);
    expect(Object.keys(syncer.hashTrees()['1:1'])).toEqual(["1:1"]);
  });

  it("reparenting an unchanged node is a move", async () => {
    const { d, syncer } = setup();
    const root = d.add("1:1", null), a = d.add("1:2", root), b = d.add("1:3", root), c = d.add("1:4", a);
    await syncer.scan(d.roots());
    (a.children as FigNode[]).splice(0, 1); (b.children as FigNode[]).push(c); c.parent = b;
    const p = (await first(syncer.flush(["1:4"], d.live)))!;
    Patch.parse(p.patch);
    expect(p.patch.ops).toContainEqual({ op: "move", id: "1:4", parent: "1:3", index: 0 });
  });

  it("resend gives fresh subtrees, and removes for dead ids", async () => {
    const { d, syncer } = setup();
    const root = d.add("1:1", null);
    d.add("1:2", root);
    await syncer.scan(d.roots());
    const p = (await syncer.resend("1:1", ["1:1", "9:9"], d.live))!;
    expect(p.patch.ops.map((o: any) => o.op + (o.node?.id ?? o.id))).toEqual(["upsert1:1", "upsert1:2", "remove9:9"]);
  });
});

describe("IdMap", () => {
  it("stores the mapping on first sight and reuses a stored one", () => {
    const { m, store } = mem();
    m.set("5:5", "orig");
    const ids = new IdMap(store);
    expect(ids.id({ id: "1:1" })).toBe("1:1");
    expect(m.get("1:1")).toBe("1:1");
    expect(ids.id({ id: "5:5" })).toBe("orig");
  });
  it("detects a duplicate (pasted copy) and reassigns it", async () => {
    const { d, s, syncer } = setup();
    const root = d.add("1:1", null);
    await syncer.scan(d.roots());
    d.add("2:1", root);
    s.m.set("2:1", "1:1"); // paste copied the stored mapping of the original
    const p = (await first(syncer.flush(["2:1"], d.live)))!;
    expect(p.issues).toMatchObject([{ code: "duplicate_id", nodeId: "2:1", clonedFrom: "1:1" }]);
    expect(s.m.get("2:1")).toBe("2:1");
    expect(p.patch.ops.some((o: any) => o.node?.id === "2:1")).toBe(true);
  });
});

describe("one SWF per top-level frame", () => {
  const two = () => {
    const x = setup();
    const a = x.d.add("1:1", null, { name: "Hud", width: 100, height: 50 }), b = x.d.add("2:1", null, { name: "Menu", width: 200, height: 80 });
    x.d.add("1:2", a); x.d.add("2:2", b);
    return { ...x, a, b };
  };
  it("a scan gives one patch per frame, with swf metadata on the root upsert", async () => {
    const { d, syncer } = two();
    const ps = await syncer.scan(d.roots());
    expect(ps.map((p) => p.swfId).sort()).toEqual(["1:1", "2:1"]);
    for (const p of ps) Patch.parse(p.patch);
    expect(ps.find((p) => p.swfId === "2:1")).toMatchObject({ swf: { id: "2:1", name: "Menu", stage: { width: 200, height: 80 } } });
    expect(ps.find((p) => p.swfId === "1:1")!.patch.ops.map((o: any) => o.node.id).sort()).toEqual(["1:1", "1:2"]);
    expect(Object.keys(syncer.hashTrees()).sort()).toEqual(["1:1", "2:1"]);
    expect(Object.keys(syncer.hashTrees()["2:1"]).sort()).toEqual(["2:1", "2:2"]);
  });
  it("a change in one frame only patches that swf, and sends no metadata unless the root changed", async () => {
    const { d, syncer } = two();
    await syncer.scan(d.roots());
    d.nodes.get("2:2")!.width = 5;
    const ps = await syncer.flush(["2:2"], d.live);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ swfId: "2:1" });
    expect(ps[0].swf).toBeUndefined();
  });
  it("loose top-level layers are never synced and are reported", async () => {
    const { d, syncer } = two();
    d.add("3:1", null, { type: "TEXT", name: "Stray", characters: "x", fontName: { family: "Inter", style: "Bold" }, fontSize: 9 });
    const g = d.add("4:1", null, { type: "GROUP", name: "Grp" }); d.add("4:2", g);
    const ps = await syncer.scan(d.roots());
    expect(ps.flatMap((p) => p.patch.ops.map((o: any) => o.node.id)).sort()).toEqual(["1:1", "1:2", "2:1", "2:2"]);
    expect(await syncer.flush(["3:1", "4:2"], d.live)).toEqual([]);
    expect(syncer.swfs(d.roots())).toEqual({ frames: [{ id: "1:1", name: "Hud" }, { id: "2:1", name: "Menu" }], loose: [{ id: "3:1", name: "Stray" }, { id: "4:1", name: "Grp" }], components: [] });
  });
  it("a component on the page (kept away from the design) is not reported as a loose layer", () => {
    const { d, syncer } = two();
    d.add("5:1", null, { type: "COMPONENT", name: "ListItem" });
    d.add("6:1", null, { type: "COMPONENT_SET", name: "Button" });
    const s = syncer.swfs(d.roots());
    expect(s.loose).toEqual([]);
    expect(s.components).toEqual([{ id: "5:1", name: "ListItem" }, { id: "6:1", name: "Button" }]);
    const trees = syncer.componentTrees(d.roots());
    expect(trees.map((t) => [t.id, t.nodes.map((n) => n.id)])).toEqual([["5:1", ["5:1"]], ["6:1", ["6:1"]]]);
  });
  it("deleting a frame removes its root from that swf only", async () => {
    const { d, syncer } = two();
    await syncer.scan(d.roots());
    d.remove("2:1");
    const ps = await syncer.flush(["2:1"], d.live);
    expect(ps).toMatchObject([{ swfId: "2:1", patch: { ops: [{ op: "remove", id: "2:1" }] } }]);
  });
  it("moving a node into another frame removes it from the old swf and upserts it whole in the new one", async () => {
    const { d, syncer, a, b } = two();
    d.add("1:3", d.nodes.get("1:2")!);
    await syncer.scan(d.roots());
    const m = d.nodes.get("1:2")!;
    (a.children as FigNode[]).splice(0, 1); (b.children as FigNode[]).push(m); m.parent = b;
    const ps = await syncer.flush(["1:2"], d.live);
    const o = ps.find((p) => p.swfId === "1:1")!, n = ps.find((p) => p.swfId === "2:1")!;
    expect(o.patch.ops).toContainEqual({ op: "remove", id: "1:2" });
    expect(n.patch.ops.filter((x) => x.op === "upsert").map((x: any) => x.node.id).sort()).toEqual(["1:2", "1:3", "2:1"]);
    expect(Object.keys(syncer.hashTrees()["2:1"]).sort()).toEqual(["1:2", "1:3", "2:1", "2:2"]);
  });
  it("resend is answered for the asked swf", async () => {
    const { d, syncer } = two();
    await syncer.scan(d.roots());
    const p = (await syncer.resend("2:1", ["2:1"], d.live))!;
    expect(p).toMatchObject({ swfId: "2:1", swf: { name: "Menu" } });
  });
  it("text style name is captured next to the family/style alias", async () => {
    const { d, syncer } = setup((n) => (n.id === "1:2" ? "Everywhere / Medium / 18" : undefined));
    const a = d.add("1:1", null);
    d.add("1:2", a, { type: "TEXT", characters: "hi", fontName: { family: "Inter", style: "Regular" }, fontSize: 18 });
    d.add("1:3", a, { type: "TEXT", characters: "yo", fontName: { family: "Inter", style: "Regular" }, fontSize: 18 });
    const ops = (await syncer.scan(d.roots()))[0].patch.ops as any[];
    expect(ops.find((o) => o.node.id === "1:2").node.runs[0].font).toEqual({ kind: "alias", name: "Inter/Regular", styleName: "Everywhere / Medium / 18" });
    expect(ops.find((o) => o.node.id === "1:3").node.runs[0].font).toEqual({ kind: "alias", name: "Inter/Regular" });
  });
});
