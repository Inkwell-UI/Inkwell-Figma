import type { Node } from "@inkwell-ui/spec";
import { fillsOf, parsePath, strokesOf } from "./paint.js";
import type { Ctx, FigNode } from "./types.js";

const H: Record<string, string> = { MIN: "left", MAX: "right", CENTER: "center", STRETCH: "stretch", SCALE: "scale" };
const V: Record<string, string> = { MIN: "top", MAX: "bottom", CENTER: "center", STRETCH: "stretch", SCALE: "scale" };
const SHAPES = new Set(["RECTANGLE", "ELLIPSE", "VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"]);
const SIZING: Record<string, string> = { NONE: "fixed", TRUNCATE: "fixed", WIDTH_AND_HEIGHT: "autoWidth", HEIGHT: "autoHeight" };
const PLAIN = ["FRAME", "RECTANGLE", "ELLIPSE", "VECTOR", "TEXT", "INSTANCE", "COMPONENT"];

// Known Figma properties with no IR field yet: kept verbatim under extra.figma, never dropped.
const PASSTHROUGH = [
  "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern", "layoutSizingHorizontal", "layoutSizingVertical",
  "layoutPositioning", "layoutGrow", "layoutAlign", "primaryAxisAlignItems", "counterAxisAlignItems",
  "primaryAxisSizingMode", "counterAxisSizingMode", "layoutWrap", "counterAxisSpacing", "maskType",
  "textAlignHorizontal", "textAlignVertical", "lineHeight", "letterSpacing", "textCase", "textDecoration",
];
// Properties the serializer reads or that are structural. Any other own-enumerable key also goes to extra
// (plain objects only: real Figma nodes expose properties on the prototype, so PASSTHROUGH is the real net).
const HANDLED = new Set([
  "id", "name", "type", "visible", "opacity", "blendMode", "isMask", "rotation", "x", "y", "width", "height",
  "parent", "children", "constraints", "fills", "strokes", "strokeWeight", "strokeAlign", "clipsContent",
  "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "vectorPaths",
  "fillGeometry", "characters", "fontName", "fontSize", "textAutoResize", "componentProperties", ...PASSTHROUGH,
]);
const jsonable = (v: unknown) => v !== undefined && typeof v !== "symbol" && typeof v !== "function";

function irType(n: FigNode, fills: { type: string }[], hasStroke: boolean): Node["type"] {
  if (n.type === "TEXT") return "text";
  if (n.type === "INSTANCE") return "instance";
  if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") return "component";
  if (SHAPES.has(n.type)) return n.type === "RECTANGLE" && fills.length === 1 && fills[0].type === "image" && !hasStroke ? "image" : "shape";
  return "frame"; // FRAME, GROUP, SECTION and unknown containers
}

/** One node, shallow: children are ids only. */
export function serializeNode(n: FigNode, ctx: Ctx): Node {
  const { fills, dropped: droppedFills } = fillsOf(n);
  const { strokes, dropped: droppedStrokes } = strokesOf(n);
  const type = irType(n, fills, strokes.length > 0);
  const figma: Record<string, unknown> = {};
  if (!PLAIN.includes(n.type)) figma.type = n.type;
  if (droppedFills.length) figma.unmappedFills = droppedFills;
  if (droppedStrokes.length) figma.unmappedStrokes = droppedStrokes;
  for (const k of PASSTHROUGH) { const v = (n as any)[k]; if (jsonable(v)) figma[k] = v; }
  const unknown: Record<string, unknown> = {};
  for (const k of Object.keys(n)) if (!HANDLED.has(k) && jsonable((n as any)[k])) unknown[k] = (n as any)[k];
  if (Object.keys(unknown).length) figma.unknown = unknown;

  const parentId = n.parent && n.parent.type !== "PAGE" && n.parent.type !== "DOCUMENT" ? ctx.id(n.parent) : null;
  const base = {
    id: ctx.id(n), name: n.name, parent: parentId,
    children: (n.children ?? []).map((c) => ctx.id(c)),
    transform: { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0, rotation: n.rotation ?? 0 },
    anchor: { h: H[n.constraints?.horizontal ?? "MIN"] ?? "left", v: V[n.constraints?.vertical ?? "MIN"] ?? "top" },
    visible: n.visible ?? true,
    opacity: n.opacity ?? 1,
    ...(n.blendMode && { blend: n.blendMode }),
    ...(n.isMask && { mask: true }),
  };
  // `figma` is filled lazily below, so build extra at the end.
  const done = (o: object): Node => ({ ...base, ...o, ...(Object.keys(figma).length && { extra: { figma } }) }) as Node;

  switch (type) {
    case "text": {
      const content = n.characters ?? "";
      if (typeof n.fontName === "symbol" || typeof n.fontSize === "symbol") figma.mixedStyle = true; // 0.1: one run only
      const font = typeof n.fontName === "object" ? `${n.fontName.family}/${n.fontName.style}` : "mixed";
      return done({
        type, content, sizing: SIZING[n.textAutoResize ?? "NONE"] ?? "fixed",
        runs: [{ start: 0, end: content.length, font: { kind: "alias", name: font }, size: typeof n.fontSize === "number" ? n.fontSize : 0, ...(fills[0] && { fill: fills[0] }) }],
      });
    }
    case "image": {
      const f = fills[0] as { asset: string; scaleMode?: string };
      return done({ type, asset: f.asset, scaleMode: f.scaleMode ?? "fill" });
    }
    case "instance": {
      const props = Object.entries(n.componentProperties ?? {});
      const variant = props.filter(([, p]) => p.type === "VARIANT").map(([k, p]) => `${k}=${p.value}`).join(", ");
      const overrides = Object.fromEntries(props.filter(([, p]) => p.type !== "VARIANT").map(([k, p]) => [k, p.value]));
      return done({ type, component: ctx.componentOf(n) ?? "", ...(variant && { variant }), ...(Object.keys(overrides).length && { overrides }) });
    }
    case "component": {
      const kids = n.type === "COMPONENT_SET" ? (n.children ?? []) : [n];
      return done({ type, variants: kids.map((c) => ({ name: c.name, node: ctx.id(c) })) });
    }
    case "shape": {
      const geo = n.vectorPaths ?? n.fillGeometry ?? [];
      const parsed = geo.map((g) => parsePath(g.data));
      if (parsed.some((p) => !p)) figma.rawPaths = geo.map((g) => g.data); // unsupported command: keep the source
      return done({ type, paths: parsed.filter((p): p is NonNullable<typeof p> => !!p), fills, strokes });
    }
    default: {
      const mode = n.layoutMode === "HORIZONTAL" ? "horizontal" : n.layoutMode === "VERTICAL" ? "vertical" : null;
      if (n.layoutMode && !mode && n.layoutMode !== "NONE") figma.layoutMode = n.layoutMode; // e.g. GRID
      return done({
        type: "frame", clipContent: n.clipsContent ?? false,
        ...(mode && { autoLayout: { mode, spacing: n.itemSpacing ?? 0, padding: [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0] } }),
      });
    }
  }
}

/** Pre-order list of a node and all descendants. */
export function serializeTree(n: FigNode, ctx: Ctx): Node[] {
  return [serializeNode(n, ctx), ...(n.children ?? []).flatMap((c) => serializeTree(c, ctx))];
}
