import { describe, expect, it } from "vitest";
import { Node } from "@inkwell-ui/spec";
import { serializeNode, serializeTree, parsePath, toFill, type FigNode } from "../src/serialize/index.js";

const ctx = { id: (n: { id: string }) => n.id, componentOf: (n: FigNode) => (n.id === "i1" ? "c1" : undefined) };
const base = { visible: true, opacity: 1, x: 1, y: 2, width: 30, height: 40, rotation: 0, parent: { id: "p", type: "FRAME" } };
const ser = (n: FigNode) => { const out = serializeNode({ ...base, ...n }, ctx); Node.parse(out); return out as any; };
const solid = { type: "SOLID", color: { r: 1, g: 0, b: 0 } };

describe("serialize", () => {
  it("frame: clip, auto-layout, anchor, transform", () => {
    const n = ser({ id: "f", name: "F", type: "FRAME", clipsContent: true, layoutMode: "VERTICAL", itemSpacing: 4, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4,
      constraints: { horizontal: "STRETCH", vertical: "MAX" }, children: [{ id: "k", name: "k", type: "FRAME" }] });
    expect(n).toMatchObject({ type: "frame", clipContent: true, parent: "p", children: ["k"], anchor: { h: "stretch", v: "bottom" },
      autoLayout: { mode: "vertical", spacing: 4, padding: [1, 2, 3, 4] }, transform: { x: 1, y: 2, width: 30, height: 40, rotation: 0 } });
  });
  it("auto layout: alignment, wrap and per-axis sizing are real fields; a fixed child in the flow gets none", () => {
    const f = ser({ id: "f", name: "F", type: "FRAME", layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "BASELINE", layoutWrap: "WRAP", layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED" });
    expect(f).toMatchObject({ autoLayout: { mode: "horizontal", primaryAlign: "spaceBetween", counterAlign: "start", wrap: true }, layout: { h: "hug", v: "fixed" } });
    expect(ser({ id: "c", name: "C", type: "FRAME", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" }).layout).toBeUndefined();
    expect(ser({ id: "c", name: "C", type: "TEXT", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", layoutPositioning: "ABSOLUTE" }).layout).toEqual({ h: "fill", v: "hug", absolute: true });
    expect(f.extra?.figma).toBeUndefined()
  });
  it("group: children are relative to the group (Figma gives frame-relative coordinates), the group's rotation is dropped", () => {
    const group = { id: "g", name: "G", type: "GROUP", x: 100, y: 50, rotation: 30 } as const;
    const g = ser({ ...group, children: [{ id: "r", name: "R", type: "RECTANGLE" }] });
    expect(g).toMatchObject({ type: "frame", transform: { x: 100, y: 50, rotation: 0 } });
    expect(ser({ id: "r", name: "R", type: "RECTANGLE", x: 120, y: 70, parent: group }).transform).toMatchObject({ x: 20, y: 20 });
    // a group inside a group: both are relative to the same ancestor frame, so each subtracts its own parent
    const inner = { id: "g2", name: "G2", type: "GROUP", x: 110, y: 60, parent: group } as const;
    expect(ser({ ...inner, rotation: 0 }).transform).toMatchObject({ x: 10, y: 10 });
    expect(ser({ id: "r2", name: "R2", type: "RECTANGLE", x: 115, y: 65, parent: inner }).transform).toMatchObject({ x: 5, y: 5 });
  });
  it("page parent becomes null", () => expect(ser({ id: "f", name: "F", type: "FRAME", parent: { id: "0:1", type: "PAGE" } }).parent).toBeNull());
  it("shape keeps cubics; fills and strokes with alignment", () => {
    const n = ser({ id: "v", name: "V", type: "VECTOR", vectorPaths: [{ data: "M 0 0 C 1 2 3 4 5 6 L 7 8 Z" }],
      fills: [solid, { type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }], gradientTransform: [[1, 0, 0], [0, 1, 0]] },
        { type: "GRADIENT_RADIAL", gradientStops: [] }, { type: "IMAGE", imageHash: "abc", scaleMode: "FIT" }],
      strokes: [solid], strokeWeight: 2, strokeAlign: "OUTSIDE" });
    expect(n.paths[0][1]).toEqual({ op: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 });
    expect(n.fills.map((f: any) => f.type)).toEqual(["solid", "linear", "radial", "image"]);
    expect(n.fills[1].transform).toEqual([1, 0, 0, 0, 1, 0]);
    expect(n.strokes).toMatchObject([{ weight: 2, alignment: "outside" }]);
  });
  it("rectangle uses fillGeometry; Q becomes cubic", () => {
    expect(ser({ id: "r", name: "R", type: "RECTANGLE", fillGeometry: [{ data: "M 0 0 L 10 0 L 10 10 Z" }] }).paths[0]).toHaveLength(4);
    expect(parsePath("M 0 0 Q 3 3 6 0")![1]).toMatchObject({ op: "C", x: 6, y: 0 });
    expect(parsePath("M 0 0 A 1 1 0 0 0 1 1")).toBeNull();
  });
  it("lone image-filled rectangle is an image node", () =>
    expect(ser({ id: "m", name: "M", type: "RECTANGLE", fills: [{ type: "IMAGE", imageHash: "h1", scaleMode: "FILL" }] })).toMatchObject({ type: "image", asset: "h1", scaleMode: "fill" }));
  it("image paint opacity: fillOpacity on an image node, opacity on an image fill; hidden image paints are dropped", () => {
    const img = { type: "IMAGE", imageHash: "h1", scaleMode: "FIT", opacity: 0.5 };
    expect(ser({ id: "m", name: "M", type: "RECTANGLE", opacity: 0.8, fills: [img] })).toMatchObject({ type: "image", scaleMode: "fit", fillOpacity: 0.5, opacity: 0.8 });
    expect(ser({ id: "m", name: "M", type: "RECTANGLE", fills: [{ ...img, opacity: 1 }] })).not.toHaveProperty("fillOpacity");
    expect(toFill(img as any)).toEqual({ type: "image", asset: "h1", scaleMode: "fit", opacity: 0.5 });
    expect(toFill({ ...img, visible: false } as any)).toBeNull();
    expect(toFill({ type: "IMAGE", imageHash: null } as any)).toBeNull();
  });
  it("frame keeps its fills (image background), a frame without fills has none", () => {
    const f = ser({ id: "f", name: "F", type: "FRAME", fills: [{ type: "IMAGE", imageHash: "h2", scaleMode: "CROP" }] });
    expect(f).toMatchObject({ type: "frame", fills: [{ type: "image", asset: "h2", scaleMode: "crop" }] });
    expect(ser({ id: "f", name: "F", type: "FRAME", fills: [] })).not.toHaveProperty("fills");
    expect(ser({ id: "g", name: "G", type: "GROUP" })).not.toHaveProperty("fills");
  });
  it("an image rectangle with a stroke stays a shape with an image fill", () =>
    expect(ser({ id: "m", name: "M", type: "RECTANGLE", fills: [{ type: "IMAGE", imageHash: "h1" }], strokes: [solid], strokeWeight: 1 })).toMatchObject({ type: "shape", fills: [{ type: "image" }] }));
  it("text: one run, font reference, sizing, $KEY content", () => {
    const n = ser({ id: "t", name: "T", type: "TEXT", characters: "$HELLO", fontName: { family: "Inter", style: "Bold" }, fontSize: 12, textAutoResize: "WIDTH_AND_HEIGHT", fills: [solid] });
    expect(n).toMatchObject({ type: "text", content: "$HELLO", sizing: "autoWidth", runs: [{ start: 0, end: 6, font: { kind: "alias", name: "Inter/Bold" }, size: 12 }] });
  });
  it("text layout maps to real fields; sizing mode is not textFit", () => {
    const base = { id: "t", name: "T", type: "TEXT", characters: "a", fontName: { family: "I", style: "R" }, fontSize: 10 } as const;
    const n: any = ser({ ...base, textAlignHorizontal: "JUSTIFIED", textAlignVertical: "BOTTOM", lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 2 }, textAutoResize: "HEIGHT", textTruncation: "ENDING" });
    expect(n).toMatchObject({ align: "justify", verticalAlign: "bottom", lineHeight: { unit: "percent", value: 120 }, letterSpacing: { unit: "px", value: 2 }, textFit: "none", truncate: true, sizing: "autoHeight" });
    expect(n.extra?.text).toBeUndefined();
    expect(ser({ ...base, lineHeight: { unit: "AUTO" } })).toMatchObject({ align: "left", verticalAlign: "top", lineHeight: { unit: "auto" }, letterSpacing: { unit: "px", value: 0 }, truncate: false });
  });
  it("mixed text style is flagged, not dropped", () => {
    const n = ser({ id: "t", name: "T", type: "TEXT", characters: "ab", fontName: Symbol("mixed"), fontSize: Symbol("mixed") });
    expect(n.extra.figma.mixedStyle).toBe(true);
  });
  it("instance and component", () => {
    const i = ser({ id: "i1", name: "I", type: "INSTANCE", componentProperties: { Size: { type: "VARIANT", value: "L" }, Label: { type: "TEXT", value: "x" } } });
    expect(i).toMatchObject({ type: "instance", component: "c1", variant: "Size=L", overrides: { Label: "x" } });
    const c = ser({ id: "cs", name: "Set", type: "COMPONENT_SET", children: [{ id: "c2", name: "Size=L", type: "COMPONENT" }] });
    expect(c).toMatchObject({ type: "component", variants: [{ name: "Size=L", node: "c2" }] });
  });
  it("visibility, opacity, blend, mask", () =>
    expect(ser({ id: "f", name: "F", type: "FRAME", visible: false, opacity: 0.5, blendMode: "MULTIPLY", isMask: true })).toMatchObject({ visible: false, opacity: 0.5, blend: "MULTIPLY", mask: true }));
  it("unknown node types, properties and paints are kept in extra", () => {
    const n = ser({ id: "s", name: "S", type: "SECTION", cornerRadius: 4, weird: { a: 1 }, fills: [{ type: "VIDEO" }, { ...solid, visible: false }] } as any);
    expect(n.type).toBe("frame");
    expect(n.extra.figma).toMatchObject({ type: "SECTION", cornerRadius: 4, unknown: { weird: { a: 1 } }, unmappedFills: [{ type: "VIDEO" }, { visible: false }] });
  });
  it("serializeTree is pre-order", () =>
    expect(serializeTree({ id: "a", name: "a", type: "FRAME", children: [{ id: "b", name: "b", type: "FRAME", children: [{ id: "c", name: "c", type: "FRAME" }] }] }, ctx).map((n) => n.id)).toEqual(["a", "b", "c"]));
});
