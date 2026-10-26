import { describe, expect, it } from "vitest";
import { Node, SwfMeta, Theme, isThemeBindingKey } from "@inkwell-ui/spec";
import { collectThemes, serializeNode, type FigCollection, type FigNode, type FigVariable } from "../src/serialize/index.js";
import { Syncer } from "../src/sync/syncer.js";
import { IdMap } from "../src/sync/idmap.js";

const mode = (modeId: string, name: string) => ({ modeId, name });
const cols: FigCollection[] = [
  { id: "C1", name: "Colors", defaultModeId: "m1", modes: [mode("m1", "Vanilla"), mode("m2", "Nordic")], variableIds: ["V1", "V2", "V3", "V4"] },
  { id: "C2", name: "Base", defaultModeId: "b1", modes: [mode("b1", "Default")], variableIds: ["B1"] },
  { id: "C3", name: "Empty", defaultModeId: "e1", modes: [], variableIds: [] },
];
const vars: Record<string, FigVariable> = {
  V1: { id: "V1", name: "colors/accent", resolvedType: "COLOR", variableCollectionId: "C1", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0.2, g: 0.4, b: 0.9, a: 0.5 } } },
  V2: { id: "V2", name: "colors/text", resolvedType: "COLOR", variableCollectionId: "C1", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "B1" }, m2: { r: 0, g: 0, b: 0 } } },
  V3: { id: "V3", name: "size/title", resolvedType: "FLOAT", variableCollectionId: "C1", valuesByMode: { m1: 24, m2: 28 } },
  V4: { id: "V4", name: "misc/skip", resolvedType: "VARIABLE_COLLECTION_ID", variableCollectionId: "C1", valuesByMode: { m1: "x" } },
  B1: { id: "B1", name: "base/grey", resolvedType: "COLOR", variableCollectionId: "C2", valuesByMode: { b1: { r: 0.5, g: 0.5, b: 0.5 } } },
};
const api = { collections: async () => cols, variable: async (id: string) => vars[id] ?? null };

describe("collectThemes", () => {
  it("makes one Theme per collection with values per mode name, following aliases", async () => {
    const t = await collectThemes(api);
    t.forEach((x) => Theme.parse(x));
    expect(t.map((x) => x.name)).toEqual(["Colors", "Base"]); // no modes: left out
    expect(t[0]).toMatchObject({ modes: ["Vanilla", "Nordic"] });
    expect(t[0]!.variables!["V1"]).toEqual({ name: "colors/accent", type: "color", values: { Vanilla: { r: 1, g: 1, b: 1 }, Nordic: { r: 0.2, g: 0.4, b: 0.9, a: 0.5 } } });
    expect(t[0]!.variables!["V2"]!.values).toEqual({ Vanilla: { r: 0.5, g: 0.5, b: 0.5 }, Nordic: { r: 0, g: 0, b: 0 } }); // alias into another collection's default mode
    expect(t[0]!.variables!["V3"]).toMatchObject({ type: "number", values: { Vanilla: 24, Nordic: 28 } });
    expect(t[0]!.variables!["V4"]).toBeUndefined(); // unsupported type
  });
  it("survives an alias loop and a missing target", async () => {
    const loop: FigVariable = { id: "L", name: "loop", resolvedType: "COLOR", variableCollectionId: "C1", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "L" } } };
    const t = await collectThemes({ collections: async () => [{ ...cols[0]!, variableIds: ["L", "X"] }], variable: async (id) => (id === "L" ? loop : null) });
    expect(t[0]!.variables).toEqual({});
  });
});

const ctx = { id: (n: { id: string }) => n.id, componentOf: () => undefined };
const base = { visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, parent: { id: "p", type: "FRAME" } };
const ser = (n: FigNode) => { const out = serializeNode({ ...base, ...n }, ctx); Node.parse(out); return out as any; };
const bound = (id: string) => ({ type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: { color: { id } } });

describe("bindings", () => {
  it("shape: fill and stroke colours by IR index; hidden and unbound paints take no key", () => {
    const n = ser({ id: "s", name: "s", type: "RECTANGLE", strokeWeight: 1,
      fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: "HIDDEN" } } }, { type: "SOLID", color: { r: 0, g: 0, b: 0 } }, bound("V1")],
      strokes: [bound("V2")], boundVariables: { opacity: { id: "V3" }, width: { id: "V5" } } });
    expect(n.bindings).toEqual({ opacity: { id: "V3" }, "transform/width": { id: "V5" }, "fills/1/color": { id: "V1" }, "strokes/0/color": { id: "V2" } });
    Object.keys(n.bindings).forEach((k) => expect(isThemeBindingKey(k), k).toBe(true));
  });
  it("text: the fill and size bind to run 0", () => {
    const n = ser({ id: "t", name: "t", type: "TEXT", characters: "hi", fills: [bound("V1")], boundVariables: { fontSize: { id: "V3" }, visible: { id: "V6" } } });
    expect(n.bindings).toEqual({ "runs/0/fill/color": { id: "V1" }, "runs/0/size": { id: "V3" }, visible: { id: "V6" } });
  });
  it("a node without variables has no bindings key and no extra copy of boundVariables", () => {
    const n = ser({ id: "f", name: "f", type: "FRAME", boundVariables: {} });
    expect(n.bindings).toBeUndefined();
    expect(JSON.stringify(n.extra ?? {})).not.toContain("boundVariables");
  });
});

describe("Syncer themes", () => {
  const frame = (id: string, parent: any): FigNode => ({ id, name: id, type: "FRAME", width: 100, height: 50, children: [], parent });
  it("puts the themes on the metadata of a root upsert and sends metadata-only patches on change", async () => {
    const page = { id: "0:1", type: "PAGE" };
    const root = frame("1:1", page);
    const m = new Map<string, string>();
    const syncer = new Syncer(new IdMap({ get: (n) => m.get(n.id), set: (n, v) => void m.set(n.id, v) }), () => undefined);
    syncer.setThemes(await collectThemes(api));
    const first = (await syncer.scan([root]))[0]!;
    expect(SwfMeta.parse(first.swf).themes?.map((t) => t.name)).toEqual(["Colors", "Base"]);
    syncer.setThemes([]);
    const metas = syncer.metaPatches();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ swfId: "1:1", patch: { ops: [] }, swf: { id: "1:1", name: "1:1", stage: { width: 100, height: 50 }, themes: [] } });
  });
});
