import type { Box, Matrix } from "./model.js";

export const I: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
/** p after q (apply q first). */
export const mul = (p: Matrix, q: Matrix): Matrix => ({
  a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
  c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
  tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty,
});
export const inv = (m: Matrix): Matrix => {
  const det = m.a * m.d - m.b * m.c;
  if (!det) return I; // shortcut: a collapsed matrix (scale 0) is treated as identity; only affects gradients
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) };
};
export const move = (m: Matrix, dx: number, dy: number): Matrix => mul(m, { ...I, tx: dx, ty: dy });
export const transformBox = (m: Matrix, [x0, y0, x1, y1]: Box): Box => {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  const xs = pts.map(([x, y]) => m.a * x + m.c * y + m.tx);
  const ys = pts.map(([x, y]) => m.b * x + m.d * y + m.ty);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
export const union = (boxes: Box[]): Box =>
  boxes.length
    ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]
    : [0, 0, 0, 0];

/** Figma's gradientTransform maps the node's unit square to gradient space: inverse(gradient -> shape) after (unit square -> shape box). */
export function gradientTransform(g: Matrix, [x0, y0, x1, y1]: Box): [[number, number, number], [number, number, number]] {
  const t = mul(inv(g), { a: Math.max(x1 - x0, 0.01), b: 0, c: 0, d: Math.max(y1 - y0, 0.01), tx: x0, ty: y0 });
  return [[t.a, t.c, t.tx], [t.b, t.d, t.ty]];
}
