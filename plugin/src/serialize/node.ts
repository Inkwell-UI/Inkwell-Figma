import type { Node } from "@inkwell-ui/spec";
import { fillsOf, paintColorBindings, parsePath, strokesOf } from "./paint.js";
import type { Ctx, FigNode, FigPaint } from "./types.js";

const H: Record<string, string> = { MIN: "left", MAX: "right", CENTER: "center", STRETCH: "stretch", SCALE: "scale" };
const V: Record<string, string> = { MIN: "top", MAX: "bottom", CENTER: "center", STRETCH: "stretch", SCALE: "scale" };
const SHAPES = new Set(["RECTANGLE", "ELLIPSE", "VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"]);
const SIZING: Record<string, string> = { NONE: "fixed", TRUNCATE: "fixed", WIDTH_AND_HEIGHT: "autoWidth", HEIGHT: "autoHeight" };
const TEXT_H: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
const TEXT_V: Record<string, string> = { TOP: "top", CENTER: "center", BOTTOM: "bottom" };
const UNIT: Record<string, "px" | "percent"> = { PIXELS: "px", PERCENT: "percent" };
const SIZE: Record<string, string> = { FIXED: "fixed", HUG: "hug", FILL: "fill" };
const PRIMARY: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "spaceBetween" };
const COUNTER: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "start" };
const PLAIN = ["FRAME", "RECTANGLE", "ELLIPSE", "VECTOR", "TEXT", "INSTANCE", "COMPONENT"];

// Known Figma properties with no IR field yet: kept verbatim under extra.figma, never dropped.
const PASSTHROUGH = [
  "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern", "layoutGrow", "layoutAlign",
  "primaryAxisSizingMode", "counterAxisSizingMode", "counterAxisSpacing", "maskType",
  "textCase", "textDecoration",
];
// Properties the serializer reads or that are structural. Any other own-enumerable key also goes to extra
// (plain objects only: real Figma nodes expose properties on the prototype, so PASSTHROUGH is the real net).
const HANDLED = new Set([
  "id", "name", "type", "visible", "opacity", "blendMode", "isMask", "rotation", "x", "y", "width", "height",
  "parent", "children", "constraints", "fills", "strokes", "strokeWeight", "strokeAlign", "clipsContent",
  "boundVariables", "layoutMode", "itemSpacing", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "vectorPaths",
  "fillGeometry", "characters", "fontName", "fontSize", "textStyleId", "textAutoResize", "textTruncation", "textAlignHorizontal", "textAlignVertical", "lineHeight", "letterSpacing", "componentProperties", ...PASSTHROUGH,
]);
const jsonable = (v: unknown) => v !== undefined && typeof v !== "symbol" && typeof v !== "function";

function irType(n: FigNode, fills: { type: string }[], hasStroke: boolean): Node["type"] {
  if (n.type === "TEXT") return "text";
  if (n.type === "INSTANCE") return "instance";
  if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") return "component";
  if (SHAPES.has(n.type)) return n.type === "RECTANGLE" && fills.length === 1 && fills[0].type === "image" && !hasStroke ? "image" : "shape";
  return "frame"; // FRAME, GROUP, SECTION and unknown containers
}

/**
 * Figma text layout -> IR fields. Approximations:
 * - textAutoResize (NONE / HEIGHT / WIDTH_AND_HEIGHT) is a box *sizing mode* -> `sizing`, never textFit.
 * - Figma has no shrink-to-fit, so textFit is always "none" (authors set it in the editor overlay/later spec work).
 * - textTruncation ENDING (or the deprecated textAutoResize TRUNCATE) -> truncate true.
 * - lineHeight AUTO -> auto; unknown units (or a mixed value) fall back to auto. Same for letterSpacing -> 0 px.
 */
function textLayout(n: FigNode) {
  const lh = n.lineHeight, ls = n.letterSpacing;
  const lhUnit = typeof lh === "object" ? UNIT[lh.unit] : undefined;
  const lsUnit = typeof ls === "object" ? UNIT[ls.unit] : undefined;
  return {
    align: TEXT_H[n.textAlignHorizontal ?? ""] ?? "left",
    verticalAlign: TEXT_V[n.textAlignVertical ?? ""] ?? "top",
    lineHeight: lhUnit && typeof lh === "object" && "value" in lh ? { unit: lhUnit, value: lh.value } : { unit: "auto" },
    letterSpacing: lsUnit && typeof ls === "object" ? { unit: lsUnit, value: ls.value } : { unit: "px", value: 0 },
    textFit: "none",
    truncate: n.textTruncation === "ENDING" || n.textAutoResize === "TRUNCATE",
  };
}

/** Variable bindings of a node (SPEC-CHANGES V6.2): IR property path -> variable id. Only the keys of `THEME_BINDING_KEYS`; text fill and size go to run 0. */
function bindingsOf(n: FigNode, type: Node["type"]): Record<string, { id: string }> {
  const out: Record<string, { id: string }> = {};
  const put = (key: string, id: string | undefined) => { if (id) out[key] = { id }; };
  const bv = n.boundVariables ?? {};
  const one = (f: string) => { const a = bv[f]; return a && !Array.isArray(a) ? (a as { id?: string }).id : undefined; };
  put("opacity", one("opacity"));
  put("visible", one("visible"));
  put("transform/width", one("width"));
  put("transform/height", one("height"));
  const fills = Array.isArray(n.fills) ? (n.fills as readonly FigPaint[]) : undefined;
  if (type === "text") {
    put("runs/0/fill/color", paintColorBindings(fills).get(0));
    put("runs/0/size", one("fontSize"));
  } else {
    for (const [i, id] of paintColorBindings(fills)) put(`fills/${i}/color`, id);
    for (const [i, id] of paintColorBindings(n.strokes)) put(`strokes/${i}/color`, id);
  }
  return out;
}

/** Auto layout sizing of a node (spec 9): omitted when it is fixed on both axes and in the flow, which is what an absent `layout` means. */
function layoutOf(n: FigNode): { layout?: { h: string; v: string; absolute?: boolean } } {
  const h = SIZE[n.layoutSizingHorizontal ?? ""] ?? "fixed";
  const v = SIZE[n.layoutSizingVertical ?? ""] ?? "fixed";
  const absolute = n.layoutPositioning === "ABSOLUTE";
  return h === "fixed" && v === "fixed" && !absolute ? {} : { layout: { h, v, ...(absolute && { absolute }) } };
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

  const bound = bindingsOf(n, type);
  const parentId = n.parent && n.parent.type !== "PAGE" && n.parent.type !== "DOCUMENT" ? ctx.id(n.parent) : null;
  // Figma gives the children of a GROUP coordinates relative to the group's containing frame, not to the group, but a group becomes
  // a frame here, so make the child relative to it. The group's own rotation is dropped for the same reason: its children's
  // coordinates and rotations already include it, and the group's x/y/width/height are its axis-aligned bounding box.
  const inGroup = n.parent?.type === "GROUP";
  const gx = inGroup ? n.parent?.x ?? 0 : 0;
  const gy = inGroup ? n.parent?.y ?? 0 : 0;
  const base = {
    id: ctx.id(n), name: n.name, parent: parentId,
    children: (n.children ?? []).map((c) => ctx.id(c)),
    transform: { x: (n.x ?? 0) - gx, y: (n.y ?? 0) - gy, width: n.width ?? 0, height: n.height ?? 0, rotation: n.type === "GROUP" ? 0 : n.rotation ?? 0 },
    anchor: { h: H[n.constraints?.horizontal ?? "MIN"] ?? "left", v: V[n.constraints?.vertical ?? "MIN"] ?? "top" },
    visible: n.visible ?? true,
    opacity: n.opacity ?? 1,
    ...(n.blendMode && { blend: n.blendMode }),
    ...(n.isMask && { mask: true }),
    ...layoutOf(n),
    ...(Object.keys(bound).length && { bindings: bound }),
  };
  // `figma` is filled lazily below, so build extra at the end.
  const done = (o: object): Node => ({ ...base, ...o, ...(Object.keys(figma).length && { extra: { figma } }) }) as Node;

  switch (type) {
    case "text": {
      const content = n.characters ?? "";
      if (typeof n.fontName === "symbol" || typeof n.fontSize === "symbol") figma.mixedStyle = true; // 0.1: one run only
      const font = typeof n.fontName === "object" ? `${n.fontName.family}/${n.fontName.style}` : "mixed";
      const styleName = ctx.styleNameOf?.(n);
      return done({
        type, content, sizing: SIZING[n.textAutoResize ?? "NONE"] ?? "fixed", ...textLayout(n),
        runs: [{ start: 0, end: content.length, font: { kind: "alias", name: font, ...(styleName && { styleName }) }, size: typeof n.fontSize === "number" ? n.fontSize : 0, ...(fills[0] && { fill: fills[0] }) }],
      });
    }
    case "image": {
      const f = fills[0] as { asset: string; scaleMode?: string; opacity?: number };
      return done({ type, asset: f.asset, scaleMode: f.scaleMode ?? "fill", ...(f.opacity !== undefined && { fillOpacity: f.opacity }) });
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
        type: "frame", clipContent: n.clipsContent ?? false, ...(fills.length && { fills }),
        ...(mode && { autoLayout: {
          mode, spacing: n.itemSpacing ?? 0, padding: [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0],
          primaryAlign: PRIMARY[n.primaryAxisAlignItems ?? ""] ?? "start", counterAlign: COUNTER[n.counterAxisAlignItems ?? ""] ?? "start", wrap: n.layoutWrap === "WRAP",
        } }),
      });
    }
  }
}

/** Pre-order list of a node and all descendants. */
export function serializeTree(n: FigNode, ctx: Ctx): Node[] {
  return [serializeNode(n, ctx), ...(n.children ?? []).flatMap((c) => serializeTree(c, ctx))];
}
