import type { Node } from "@inkwell-ui/spec";
type Shape = Extract<Node, { type: "shape" }>;
type Fill = Shape["fills"][number];
type Stroke = Shape["strokes"][number];
import type { FigNode, FigPaint } from "./types.js";

type Cmd = Record<string, unknown>;
const color = (c: { r: number; g: number; b: number; a?: number }) => ({ r: c.r, g: c.g, b: c.b, ...(c.a !== undefined && { a: c.a }) });
const SCALE: Record<string, string> = { FILL: "fill", FIT: "fit", CROP: "crop", TILE: "tile" };

/** Returns null for hidden or unsupported paints (caller keeps the raw paint in extra). */
export function toFill(p: FigPaint): Fill | null {
  if (p.visible === false) return null;
  const stops = () => (p.gradientStops ?? []).map((s) => ({ position: s.position, color: color(s.color) }));
  // Row-major flatten of Figma's 2x3 matrix: [a, b, tx, c, d, ty].
  const transform = () => (p.gradientTransform ? { transform: p.gradientTransform.flat() } : {});
  switch (p.type) {
    case "SOLID": return p.color ? { type: "solid", color: color(p.color), ...(p.opacity !== undefined && p.opacity !== 1 && { opacity: p.opacity }) } : null;
    case "GRADIENT_LINEAR": return { type: "linear", stops: stops(), ...transform() };
    case "GRADIENT_RADIAL": return { type: "radial", stops: stops(), ...transform() };
    case "IMAGE": return p.imageHash ? {
      type: "image", asset: p.imageHash,
      ...(p.scaleMode && { scaleMode: SCALE[p.scaleMode] ?? p.scaleMode.toLowerCase() }),
      ...(p.opacity !== undefined && p.opacity !== 1 && { opacity: p.opacity }),
    } : null;
    default: return null;
  }
}

/** Variable ids bound to the colour of paints, keyed by the index the paint gets in the IR (a hidden or unsupported paint takes no index). */
export function paintColorBindings(paints: readonly FigPaint[] | undefined): Map<number, string> {
  const out = new Map<number, string>();
  let i = 0;
  for (const p of paints ?? []) {
    if (!toFill(p)) continue;
    const id = p.type === "SOLID" ? p.boundVariables?.color?.id : undefined;
    if (id) out.set(i, id);
    i++;
  }
  return out;
}

export function fillsOf(n: FigNode): { fills: Fill[]; dropped: FigPaint[] } {
  const fills: Fill[] = [], dropped: FigPaint[] = [];
  if (Array.isArray(n.fills)) for (const p of n.fills as FigPaint[]) { const f = toFill(p); f ? fills.push(f) : dropped.push(p); }
  return { fills, dropped };
}

const ALIGN = { INSIDE: "inside", OUTSIDE: "outside", CENTER: "center" } as const;
export function strokesOf(n: FigNode): { strokes: Stroke[]; dropped: FigPaint[] } {
  const strokes: Stroke[] = [], dropped: FigPaint[] = [];
  const weight = typeof n.strokeWeight === "number" ? n.strokeWeight : 0;
  for (const p of n.strokes ?? []) {
    const fill = toFill(p);
    fill ? strokes.push({ fill, weight, alignment: ALIGN[n.strokeAlign as keyof typeof ALIGN] ?? "center" }) : dropped.push(p);
  }
  return { strokes, dropped };
}

/** Absolute M/L/C/Q/Z (what Figma emits). Q becomes an exact cubic. Returns null on any other command. */
export function parsePath(d: string): Cmd[] | null {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: Cmd[] = [];
  let i = 0, cx = 0, cy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const c = tokens[i++];
    if (c === "M" || c === "L") { cx = num(); cy = num(); out.push({ op: c, x: cx, y: cy }); }
    else if (c === "C") { const [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()]; out.push({ op: "C", x1, y1, x2, y2, x, y }); cx = x; cy = y; }
    else if (c === "Q") {
      const [qx, qy, x, y] = [num(), num(), num(), num()];
      out.push({ op: "C", x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy), x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y), x, y });
      cx = x; cy = y;
    } else if (c === "Z") out.push({ op: "Z" });
    else return null;
  }
  return out;
}
