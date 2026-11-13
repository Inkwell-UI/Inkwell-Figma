// DefineShape 1-4: fill/line styles and edge records -> one Vec per fill style and per line style.
import { mul } from "./geom.js";
import type { Box, Paint, Vec } from "./model.js";
import type { Reader } from "./read.js";

type E = { x0: number; y0: number; x1: number; y1: number; cx?: number; cy?: number }; // twips
const rev = (e: E): E => ({ x0: e.x1, y0: e.y1, x1: e.x0, y1: e.y0, cx: e.cx, cy: e.cy });
const px = (v: number) => +(v / 20).toFixed(2);

function fillStyle(r: Reader, ver: number): Paint {
  const t = r.u8();
  if (t === 0) return { t: "solid", c: r.color(ver >= 3) };
  if (t === 0x10 || t === 0x12 || t === 0x13) {
    const m = r.matrix();
    const n = r.u8() & 15; // one byte: spread (2 bits) and interpolation (2 bits), which are ignored, then the stop count
    const stops = Array.from({ length: n }, () => ({ pos: r.u8() / 255, c: r.color(ver >= 3) }));
    if (t === 0x13) r.s16(); // focal point: drawn as a plain radial
    // gradient unit square -> shape px: the SWF gradient square is 32768 twips wide, centred on the matrix origin
    const g = mul({ a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 }, { a: 1638.4, b: 0, c: 0, d: 1638.4, tx: -819.2, ty: -819.2 });
    return { t: "grad", radial: t !== 0x10, stops, m: g };
  }
  if (t >= 0x40 && t <= 0x43) {
    const id = r.u16(), m = r.matrix();
    // matrix scale 20 = one bitmap pixel per pixel, so a..d / 20 maps bitmap pixels to shape px
    return { t: "bitmap", id, tile: t === 0x40 || t === 0x42, m: { a: m.a / 20, b: m.b / 20, c: m.c / 20, d: m.d / 20, tx: m.tx / 20, ty: m.ty / 20 } };
  }
  throw new Error(`unknown fill style ${t}`);
}

type Line = { paint: Paint; w: number; cap: "ROUND" | "NONE" | "SQUARE"; join: "ROUND" | "BEVEL" | "MITER" };
const CAP = ["ROUND", "NONE", "SQUARE"] as const;
const JOIN = ["ROUND", "BEVEL", "MITER"] as const;
function lineStyle(r: Reader, ver: number): Line {
  const w = Math.max(1, r.u16() / 20); // width 0 is a hairline: drawn 1 px
  if (ver < 4) return { paint: { t: "solid", c: r.color(ver >= 3) }, w, cap: "ROUND", join: "ROUND" };
  const f = r.u8();
  r.u8(); // NoClose + end cap
  if (((f >> 4) & 3) === 2) r.u16(); // miter limit
  const paint = (f >> 3) & 1 ? fillStyle(r, 4) : ({ t: "solid", c: r.color(true) } as Paint);
  return { paint, w, cap: CAP[Math.min(f >> 6, 2)], join: JOIN[Math.min((f >> 4) & 3, 2)] };
}

const count = (r: Reader, ver: number) => { const n = r.u8(); return n === 0xff && ver >= 2 ? r.u16() : n; };

/** Joins edges end-to-start into chains (loops when they close). */
function chains(edges: E[]): E[][] {
  const by = new Map<string, E[]>();
  for (const e of edges) { const k = `${e.x0},${e.y0}`; by.set(k, [...(by.get(k) ?? []), e]); }
  const used = new Set<E>();
  const out: E[][] = [];
  for (const e of edges) {
    if (used.has(e)) continue;
    used.add(e);
    const c = [e];
    for (let cur = e; !(cur.x1 === e.x0 && cur.y1 === e.y0); ) {
      const n = by.get(`${cur.x1},${cur.y1}`)?.find((x) => !used.has(x));
      if (!n) break;
      used.add(n);
      c.push(n);
      cur = n;
    }
    out.push(c);
  }
  return out;
}

function bounds(cs: E[][]): Box {
  const xs: number[] = [], ys: number[] = [];
  for (const e of cs.flat()) {
    xs.push(e.x0, e.x1);
    ys.push(e.y0, e.y1);
    if (e.cx !== undefined && e.cy !== undefined) {
      // a quadratic's extreme lies where its derivative is 0: t = (p0 - c) / (p0 - 2c + p1)
      for (const [p0, c, p1, out] of [[e.x0, e.cx, e.x1, xs], [e.y0, e.cy, e.y1, ys]] as const) {
        const d = p0 - 2 * c + p1, t = d ? (p0 - c) / d : -1;
        if (t > 0 && t < 1) out.push((1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t * t * p1);
      }
    }
  }
  return [Math.min(...xs) / 20, Math.min(...ys) / 20, Math.max(...xs) / 20, Math.max(...ys) / 20];
}

function toVec(cs: E[][], close: boolean): Pick<Vec, "path" | "box"> {
  const box = bounds(cs);
  const f = (x: number, y: number) => `${+(px(x) - box[0]).toFixed(2)} ${+(px(y) - box[1]).toFixed(2)}`;
  const path = cs.map((c) => {
    const closed = close || (c[c.length - 1].x1 === c[0].x0 && c[c.length - 1].y1 === c[0].y0);
    return `M ${f(c[0].x0, c[0].y0)} ` + c.map((e) => (e.cx === undefined ? `L ${f(e.x1, e.y1)}` : `Q ${f(e.cx, e.cy!)} ${f(e.x1, e.y1)}`)).join(" ") + (closed ? " Z" : "");
  }).join(" ");
  return { path, box };
}

/** `ver` = 1..4 for DefineShape..DefineShape4. The reader sits just after the shape id (and bounds are read here). */
export function readShape(r: Reader, ver: number): Vec[] {
  r.rect();
  if (ver === 4) { r.rect(); r.u8(); }
  const fills: Paint[] = [], lines: Line[] = [];
  let fillBase = 0, lineBase = 0;
  const readStyles = () => {
    fillBase = fills.length;
    lineBase = lines.length;
    for (let n = count(r, ver); n > 0; n--) fills.push(fillStyle(r, ver));
    for (let n = count(r, ver); n > 0; n--) lines.push(lineStyle(r, ver));
  };
  readStyles();
  let fb = r.ub(4), lb = r.ub(4);
  const fillEdges = new Map<number, E[]>(), lineEdges = new Map<number, E[]>();
  const add = (m: Map<number, E[]>, k: number, e: E) => { if (k) m.set(k, [...(m.get(k) ?? []), e]); };
  let x = 0, y = 0, f0 = 0, f1 = 0, ln = 0;
  for (;;) {
    if (r.ub(1)) { // edge record
      const e: E = { x0: x, y0: y, x1: x, y1: y };
      const straight = r.ub(1), n = r.ub(4) + 2;
      if (straight) {
        if (r.ub(1)) { e.x1 += r.sb(n); e.y1 += r.sb(n); }
        else if (r.ub(1)) e.y1 += r.sb(n);
        else e.x1 += r.sb(n);
      } else {
        e.cx = x + r.sb(n); e.cy = y + r.sb(n);
        e.x1 = e.cx + r.sb(n); e.y1 = e.cy + r.sb(n);
      }
      add(fillEdges, f1, e);
      add(fillEdges, f0, rev(e));
      add(lineEdges, ln, e);
      x = e.x1; y = e.y1;
      continue;
    }
    const newStyles = r.ub(1), line = r.ub(1), fill1 = r.ub(1), fill0 = r.ub(1), mv = r.ub(1);
    if (!(newStyles || line || fill1 || fill0 || mv)) break;
    if (mv) { const n = r.ub(5); x = r.sb(n); y = r.sb(n); }
    const idx = (v: number, base: number) => (v ? base + v : 0);
    if (fill0) f0 = idx(r.ub(fb), fillBase);
    if (fill1) f1 = idx(r.ub(fb), fillBase);
    if (line) ln = idx(r.ub(lb), lineBase);
    if (newStyles && ver >= 2) { readStyles(); fb = r.ub(4); lb = r.ub(4); }
  }
  const vecs: Vec[] = [];
  for (const [k, es] of [...fillEdges].sort((a, b) => a[0] - b[0])) vecs.push({ ...toVec(chains(es), true), fill: fills[k - 1] });
  for (const [k, es] of [...lineEdges].sort((a, b) => a[0] - b[0])) {
    const l = lines[k - 1];
    vecs.push({ ...toVec(chains(es), false), stroke: { paint: l.paint, w: l.w, cap: l.cap, join: l.join } });
  }
  return vecs;
}
