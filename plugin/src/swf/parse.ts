// SWF bytes -> SwfModel: the display list of frame 1 of the main timeline, with every sprite and button resolved to nested frames.
// shortcut: only frame 1 of each timeline (no animation, no frame labels); upgrade when a menu needs another frame.
import { scanCalls, type Call } from "./avm1.js";
import { I, move, transformBox, union } from "./geom.js";
import type { Anchor, Box, Fx, Matrix, Rgba, SNode, SwfModel, Vec } from "./model.js";
import { encodePng, imageSize, scanlines } from "./png.js";
import { Reader } from "./read.js";
import { readShape } from "./shape.js";

export type Inflate = (b: Uint8Array) => Promise<Uint8Array>;
/** Optional browser helpers (the UI iframe has them, Node tests may not): decode a JPEG to pixels, and deflate (zlib format) to shrink the PNGs made from lossless bitmaps. */
export type ParseOptions = {
  decodeJpeg?: (jpeg: Uint8Array) => Promise<{ w: number; h: number; rgba: Uint8Array }>;
  deflate?: (b: Uint8Array) => Promise<Uint8Array>;
};
type Place = { id: number; m: Matrix; name?: string; alpha?: number; clip?: number; fx?: Fx[]; blend?: string; hidden?: boolean; scripts?: Uint8Array[] };
type Char = (name: string, m: Matrix, alpha?: number) => SNode;
type Font = { name: string; codes: number[]; bold: boolean; italic: boolean };

const px = (m: { a: number; b: number; c: number; d: number; tx: number; ty: number }): Matrix => ({ ...m, tx: m.tx / 20, ty: m.ty / 20 });
const SHAPE_TAGS: Record<number, number> = { 2: 1, 22: 2, 32: 3, 83: 4 };
// PlaceObject3 blend mode byte -> Figma BlendMode (Subtract, Invert, Alpha, Erase have none)
const BLEND: Record<number, string> = { 3: "MULTIPLY", 4: "SCREEN", 5: "LIGHTEN", 6: "DARKEN", 7: "DIFFERENCE", 8: "LINEAR_DODGE", 13: "OVERLAY", 14: "HARD_LIGHT" };
const GUTTER = 2; // Flash puts a 2 px gutter inside every TextField; the editor grows a compiled field by it, so a game field is shrunk by it
const text = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const boxOf = (kids: SNode[]): Box => (kids.length ? union(kids.map((k) => transformBox(k.m, k.box))) : [0, 0, 0, 0]);
const group = (name: string, kids: SNode[]): SNode => ({ t: "frame", name, m: I, box: boxOf(kids), kids });

// Skyrim's MovieClip.Lock(position): pin the clip to a corner or edge of the safe area
const LOCK: Record<string, Anchor> = { T: { v: "MIN" }, TL: { h: "MIN", v: "MIN" }, TR: { h: "MAX", v: "MIN" }, B: { v: "MAX" }, BL: { h: "MIN", v: "MAX" }, BR: { h: "MAX", v: "MAX" }, L: { h: "MIN" }, R: { h: "MAX" } };
/** gfx.utils.Constraints edge flags (LEFT 1, RIGHT 2, TOP 4, BOTTOM 8): both edges stretch, one edge keeps its distance, none stays. */
const edges = (e: number): Anchor => ({ h: e & 1 && e & 2 ? "STRETCH" : e & 2 ? "MAX" : "MIN", v: e & 4 && e & 8 ? "STRETCH" : e & 8 ? "MAX" : "MIN" });
/** Where a child of `p` sits in it: spans (nearly) all -> stretch, centred -> center, hugs the far edge -> max; otherwise undefined (the default). */
function guessAxis(lo: number, hi: number, p0: number, p1: number): Anchor["h"] {
  const size = p1 - p0, gapL = lo - p0, gapR = p1 - hi;
  if (size <= 0) return undefined;
  if (hi - lo >= 0.9 * size) return "STRETCH";
  if (Math.abs(gapL - gapR) < 0.02 * size) return "CENTER";
  return gapR < gapL * 0.5 && gapR < 0.25 * size ? "MAX" : undefined;
}

/** PlaceObject3 filter list -> Figma effects. Filters without an effect are read past and reported. */
function filters(t: Reader): { fx: Fx[]; skipped: boolean } {
  const fx: Fx[] = [];
  let skipped = false;
  for (let n = t.u8(); n > 0; n--) {
    const id = t.u8();
    if (id === 0 || id === 2) { // drop shadow, glow
      const c = t.color(true), bx = t.f16(), by = t.f16(), angle = id === 0 ? t.f16() : 0, dist = id === 0 ? t.f16() : 0, strength = t.f8(), flags = t.u8();
      fx.push({ t: "shadow", inner: !!(flags & 0x80), c: { ...c, a: Math.min(1, c.a * Math.max(strength, 0)) }, x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, blur: (bx + by) / 2 });
    } else if (id === 1) { const bx = t.f16(), by = t.f16(); t.u8(); fx.push({ t: "blur", blur: (bx + by) / 2 }); }
    else if (id === 3) { t.bytes(27); skipped = true; }
    else if (id === 4 || id === 7) { const k = t.u8(); t.bytes(k * 5 + 19); skipped = true; }
    else if (id === 5) { const mx = t.u8(), my = t.u8(); t.bytes(8 + mx * my * 4 + 5); skipped = true; }
    else if (id === 6) { t.bytes(80); skipped = true; }
    else throw new Error(`unknown filter ${id}`);
  }
  return { fx, skipped };
}

export async function parseSwf(bytes: Uint8Array, inflate: Inflate, name = "SWF", opts: ParseOptions = {}): Promise<SwfModel> {
  const sig = String.fromCharCode(...bytes.subarray(0, 3));
  if (sig === "ZWS") throw new Error("LZMA-compressed SWF (ZWS) is not supported; re-save it uncompressed or zlib-compressed");
  if (sig !== "FWS" && sig !== "CWS") throw new Error("not a SWF file");
  const body = sig === "CWS" ? await inflate(bytes.subarray(8)) : bytes.subarray(8);
  const r = new Reader(body);
  const [x0, y0, x1, y1] = r.rect().map((v) => v / 20);
  r.u16(); r.u16(); // frame rate, frame count

  const warnings = new Set<string>();
  const chars = new Map<number, Char>();
  const fonts = new Map<number, Font>();
  const exported = new Map<number, string>();
  const imported = new Map<number, { name: string; url: string }>(); // characters (and fonts) that live in another SWF
  const bitmaps = new Map<number, () => Promise<Uint8Array>>();
  let jpegTables: Uint8Array = new Uint8Array();
  const version = bytes[3];
  const frameScripts: { owner: number; code: Uint8Array }[] = []; // DoAction; owner = sprite id, -1 = the main timeline
  const initBlocks: { id: number; code: Uint8Array }[] = []; // DoInitAction: class bodies and Object.registerClass calls
  const nodeScripts = new Map<SNode, Uint8Array[]>(); // clip actions of a placement (on(construct) ...)

  const frameChar = (id: string, kids: SNode[], comp?: number): Char => {
    const box = boxOf(kids);
    return (name, m, alpha) => ({
      t: "frame", name: name || id, m, box, alpha, kids,
      ...(comp !== undefined && { comp, label: exported.get(comp) ?? id }),
    });
  };

  const instance = (p: Place): SNode | null => {
    let c = chars.get(p.id);
    const imp = imported.get(p.id);
    if (!c && imp) { warnings.add(`${imp.name} comes from another SWF (${imp.url})`); c = frameChar(imp.name, []); }
    if (!c) { warnings.add(`character ${p.id} is not drawable, skipped`); return null; }
    const n = c(p.name ?? exported.get(p.id) ?? "", p.m, p.alpha);
    if (p.scripts) nodeScripts.set(n, p.scripts);
    if (p.fx?.length) n.fx = p.fx;
    if (p.blend) n.blend = p.blend;
    if (p.hidden) n.hidden = true;
    return n;
  };

  /** Places tags until the first ShowFrame (or the end) and resolves the display list. */
  async function timeline(r: Reader, end: number, owner: number): Promise<SNode[]> {
    const dl = new Map<number, Place>();
    while (r.p < end) {
      const h = r.u16();
      const code = h >> 6;
      const len = (h & 63) === 63 ? r.u32() : h & 63;
      const t = new Reader(r.b, r.p, Math.min(r.p + len, end));
      r.p = t.end;
      if (code === 0 || code === 1) break;
      try { await tag(code, t, dl, owner); } catch (e) { warnings.add(`tag ${code}: ${(e as Error).message}`); }
    }
    const list = [...dl].sort((a, b) => a[0] - b[0]);
    const out: SNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i][1], n = instance(p);
      if (!p.clip) { if (n) out.push(n); continue; }
      // a clip layer masks everything from the next depth up to its ClipDepth: they become one frame, so Figma's mask stops there
      const kids: SNode[] = [];
      if (n) { n.mask = true; kids.push(n); }
      while (i + 1 < list.length && list[i + 1][0] <= p.clip) { const k = instance(list[++i][1]); if (k) kids.push(k); }
      if (kids.length) out.push(group("Mask", kids));
    }
    return out;
  }

  async function tag(code: number, t: Reader, dl: Map<number, Place>, owner: number): Promise<void> {
    if (SHAPE_TAGS[code]) {
      const id = t.u16();
      const vecs: Vec[] = readShape(t, SHAPE_TAGS[code]);
      const box = union(vecs.map((v): Box => [v.box[0], v.box[1], v.box[2], v.box[3]]));
      chars.set(id, (name, m, alpha) => ({ t: "shape", name: name || `Shape ${id}`, m, box, alpha, vecs }));
    } else if (code === 39) { // DefineSprite
      const id = t.u16(); t.u16();
      chars.set(id, frameChar(`Sprite ${id}`, await timeline(t, t.end, id), id));
    } else if (code === 7 || code === 34) { // DefineButton(2): the Up state
      const id = t.u16();
      if (code === 34) { t.u8(); t.u16(); }
      const up = new Map<number, Place>();
      for (let f = t.u8(); f; f = t.u8()) {
        const cid = t.u16(), depth = t.u16(), m = px(t.matrix());
        if (code === 34) { t.cxform(true); if (f & 0x10) break; if (f & 0x20) t.u8(); } // filters are not skipped: stop at the first
        if (f & 1) up.set(depth, { id: cid, m });
      }
      const kids = [...up].sort((a, b) => a[0] - b[0]).flatMap(([, p]) => { const n = instance(p); return n ? [n] : []; });
      chars.set(id, frameChar(`Button ${id}`, kids, id));
    } else if (code === 4 || code === 26 || code === 70) place(code, t, dl);
    else if (code === 5) { t.u16(); dl.delete(t.u16()); }
    else if (code === 28) dl.delete(t.u16());
    else if (code === 12) frameScripts.push({ owner, code: t.bytes(t.left) });
    else if (code === 59) { const id = t.u16(); initBlocks.push({ id, code: t.bytes(t.left) }); }
    else if (code === 56) { for (let n = t.u16(); n > 0; n--) { const id = t.u16(); exported.set(id, t.str()); } }
    else if (code === 57 || code === 71) { // ImportAssets(2): drawn from another SWF at run time; fonts are known by their name here
      const url = t.str();
      if (code === 71) { t.u8(); t.u8(); }
      for (let n = t.u16(); n > 0; n--) {
        const id = t.u16(), nm = t.str();
        imported.set(id, { name: nm, url });
        if (!fonts.has(id)) fonts.set(id, { name: nm, codes: [], bold: false, italic: false });
      }
    } else if (code === 48 || code === 75) { // DefineFont2/3: the name, bold/italic and the glyph -> character table
      const id = t.u16(), f = t.u8();
      t.u8();
      const name = new TextDecoder().decode(t.bytes(t.u8())).replace(/\0+$/, "");
      const n = t.u16(), wide = f & 8, table = t.p;
      for (let i = 0; i < n; i++) wide ? t.u32() : t.u16();
      const off = wide ? t.u32() : t.u16();
      t.p = table + off;
      fonts.set(id, { name, bold: !!(f & 1), italic: !!(f & 2), codes: Array.from({ length: n }, () => (f & 4 || code === 75 ? t.u16() : t.u8())) });
    } else if (code === 37) editText(t);
    else if (code === 11 || code === 33) staticText(t, code === 33);
    else if (code === 8) jpegTables = t.bytes(t.left);
    else if (code === 6 || code === 21 || code === 35 || code === 90 || code === 20 || code === 36) bitmap(code, t);
    else if (code === 46 || code === 84) warnings.add("morph shapes are skipped");
  }

  function place(code: number, t: Reader, dl: Map<number, Place>): void {
    if (code === 4) { const id = t.u16(), depth = t.u16(), m = px(t.matrix()); dl.set(depth, { id, m }); return; }
    const f = t.u8(), f2 = code === 70 ? t.u8() : 0, depth = t.u16();
    if (f2 & 0x08 || (f2 & 0x10 && f & 2)) t.str();
    const id = f & 2 ? t.u16() : undefined;
    const m = f & 4 ? px(t.matrix()) : undefined;
    const alpha = f & 8 ? t.cxform(true) : undefined;
    if (f & 16) t.u16();
    const name = f & 32 ? t.str() : undefined;
    const clip = f & 64 ? t.u16() : undefined;
    let fx: Fx[] | undefined, blend: string | undefined, hidden: boolean | undefined;
    if (f2 & 0x01) { const r = filters(t); fx = r.fx; if (r.skipped) warnings.add("some filters (bevel, gradient, colour) are not supported"); }
    if (f2 & 0x02) { const b = t.u8(); blend = BLEND[b]; if (b >= 9 && b <= 12) warnings.add("some blend modes (subtract, invert, alpha, erase) are not supported"); }
    if (f2 & 0x04) t.u8();
    if (f2 & 0x20) hidden = t.u8() === 0;
    if (f2 & 0x40) t.bytes(4); // opaque background colour
    let scripts: Uint8Array[] | undefined;
    if (f & 0x80) { // clip actions: reserved, the union of the events, then one record per event set
      t.u16();
      const wide = version >= 6;
      if (wide) t.u32(); else t.u16();
      scripts = [];
      for (let ev = wide ? t.u32() : t.u16(); ev; ev = wide ? t.u32() : t.u16()) {
        const size = t.u32(), keyPress = wide && ev & 0x20000; // a key press record starts with its key code
        const b = t.bytes(size);
        scripts.push(keyPress ? b.subarray(1) : b);
      }
    }
    const old = f & 1 ? dl.get(depth) : undefined;
    const pid = id ?? old?.id;
    if (pid === undefined) return;
    dl.set(depth, {
      id: pid, m: m ?? old?.m ?? I, name: name ?? old?.name, alpha: alpha ?? old?.alpha, clip: clip ?? old?.clip,
      fx: fx ?? old?.fx, blend: blend ?? old?.blend, hidden: hidden ?? old?.hidden, scripts: scripts ?? old?.scripts,
    });
  }

  function editText(t: Reader): void {
    const id = t.u16(), [bx0, by0, bx1, by1] = t.rect().map((v) => v / 20);
    const f = t.u8(), g = t.u8();
    const fid = f & 1 ? t.u16() : undefined;
    const fclass = g & 0x80 ? t.str() : undefined;
    const size = f & 1 ? t.u16() / 20 : 12;
    const color: Rgba = f & 4 ? t.color(true) : { r: 0, g: 0, b: 0, a: 1 };
    if (f & 2) t.u16();
    let align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" = "LEFT", leading = 0;
    if (g & 0x20) { align = (["LEFT", "RIGHT", "CENTER", "JUSTIFIED"] as const)[t.u8()] ?? "LEFT"; t.bytes(6); leading = t.s16() / 20; } // margins and indent are not used
    const variable = t.str();
    const initial = f & 0x80 ? t.str() : "";
    const shown = g & 2 ? text(initial) : initial;
    const fnt = fid !== undefined ? fonts.get(fid) : undefined;
    const font = fnt?.name || fclass || "";
    const box: Box = bx1 - bx0 > 4 * GUTTER && by1 - by0 > 4 * GUTTER ? [bx0 + GUTTER, by0 + GUTTER, bx1 - GUTTER, by1 - GUTTER] : [bx0, by0, bx1, by1];
    chars.set(id, (name, m, alpha) => ({
      t: "text", name: name || variable || `Text ${id}`, m, alpha, box,
      text: shown || name || variable || `Text ${id}`, placeholder: !shown, font, bold: !!fnt?.bold, italic: !!fnt?.italic, size, color, align,
      ...(leading ? { lineHeight: size * 1.2 + leading } : {}), ...(g & 0x08 ? { border: true } : {}),
    }));
  }

  function staticText(t: Reader, alpha: boolean): void {
    const id = t.u16();
    t.rect();
    const tm = px(t.matrix()), gb = t.u8(), ab = t.u8();
    let font: Font | undefined, size = 12, color: Rgba = { r: 0, g: 0, b: 0, a: 1 }, x = 0, y = 0;
    const kids: SNode[] = [];
    for (let f = t.u8(); f; f = t.u8()) {
      if (f & 0x80) {
        if (f & 8) font = fonts.get(t.u16());
        if (f & 4) color = t.color(alpha);
        if (f & 1) x = t.s16();
        if (f & 2) y = t.s16();
        if (f & 8) size = t.u16() / 20;
        continue;
      }
      let s = "", w = 0;
      if (font && !font.codes.length) warnings.add(`text in the imported font ${font.name} cannot be read`);
      for (let i = f & 127; i > 0; i--) { const gi = t.ub(gb), adv = t.sb(ab); s += String.fromCharCode(font?.codes[gi] ?? 63); w += adv; }
      t.align();
      kids.push({
        t: "text", name: s.trim() || `Text ${id}`, m: move(tm, x / 20, y / 20 - size * 0.95), // shortcut: baseline -> top by a fixed 0.95 of the size
        box: [0, 0, Math.max(w, 20) / 20, size * 1.2], text: s, placeholder: false, font: font?.name ?? "", bold: !!font?.bold, italic: !!font?.italic, size, color, align: "LEFT",
      });
      x += w;
    }
    chars.set(id, frameChar(`Static text ${id}`, kids));
  }

  /** Pixels -> PNG, deflated when the host can. */
  const png = async (w: number, h: number, rgba: Uint8Array) => encodePng(w, h, rgba, opts.deflate ? await opts.deflate(scanlines(w, h, rgba)) : undefined);

  function bitmap(code: number, t: Reader): void {
    const id = t.u16();
    if (code === 6) { const d = t.bytes(t.left); bitmaps.set(id, async () => joinJpeg(jpegTables, d)); }
    else if (code === 21) { const d = fixJpeg(t.bytes(t.left)); bitmaps.set(id, async () => d); }
    else if (code === 35 || code === 90) { // JPEG + a zlib alpha plane; without a JPEG decoder the alpha is dropped
      const n = t.u32();
      if (code === 90) t.u16();
      const d = fixJpeg(t.bytes(n)), z = t.bytes(t.left);
      bitmaps.set(id, async () => {
        if (!opts.decodeJpeg || d[0] !== 0xff) return d;
        const { w, h, rgba } = await opts.decodeJpeg(d);
        const a = await inflate(z);
        for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = a[i] ?? 255;
        return png(w, h, rgba);
      });
    } else {
      const fmt = t.u8(), w = t.u16(), h = t.u16(), colors = fmt === 3 ? t.u8() + 1 : 0, z = t.bytes(t.left);
      bitmaps.set(id, async () => png(w, h, lossless(await inflate(z), code === 36, fmt, w, h, colors)));
    }
  }

  /**
   * Constraints from the script, else from position. Script: Skyrim's `clip.Lock("TL")` (frame scripts, clip actions, class code) and CLIK's
   * `constraints.addElement(this.child, edges)` in a component class (the class reaches its symbols through Object.registerClass).
   * When no Lock is found the menu does not pin itself to the screen; as a fallback the layers directly under the stage and under `Menu_mc` are
   * anchored by where they sit.
   * shortcut: class code is matched by its exact class (no `extends` chain); branches are read straight through.
   */
  function anchor(root: SwfModel["root"]): SwfModel["anchors"] {
    const byComp = new Map<number, SNode[]>(); // every placement of a sprite
    const seen = new Set<SNode>();
    const index = (n: SNode) => {
      if (seen.has(n)) return;
      seen.add(n);
      if (n.t !== "frame") return;
      if (n.comp !== undefined) byComp.set(n.comp, [...(byComp.get(n.comp) ?? []), n]);
      n.kids.forEach(index);
    };
    index(root);
    const done = new Set<SNode>();
    let locks = 0;
    const put = (n: SNode, a: Anchor) => { n.anchor = { ...n.anchor, ...a }; done.add(n); };
    /** `this`, `this.a.b`, `a.b` (relative to the owner) or `_root.a`: the nodes it names. */
    const target = (owners: SNode[], p: string): SNode[] => {
      const segs = p.split(".").filter(Boolean);
      let cur = owners;
      if (segs[0] === "_root") { cur = [root]; segs.shift(); } else if (segs[0] === "this") segs.shift();
      for (const seg of segs) cur = cur.flatMap((n) => (n.t === "frame" ? n.kids.filter((k) => k.name === seg) : []));
      return cur;
    };
    const apply = (calls: Call[], owners: SNode[]) => {
      for (const c of calls) {
        const a0 = c.args[0], a1 = c.args[1];
        if (c.method === "Lock" && a0?.k === "s" && LOCK[a0.v]) {
          for (const n of target(owners, c.obj)) { put(n, LOCK[a0.v]); locks++; }
        } else if (c.method === "addElement" && a0?.k === "p" && a1?.k === "n" && /^this\.[^.]+$/.test(a0.v)) {
          for (const n of target(owners, a0.v)) put(n, edges(a1.v));
        }
      }
    };
    for (const f of frameScripts) apply(scanCalls(f.code), f.owner < 0 ? [root] : byComp.get(f.owner) ?? []);
    for (const [n, codes] of nodeScripts) for (const code of codes) apply(scanCalls(code), [n]);
    // class code: a sprite's linkage name -> Object.registerClass -> `__Packages.<class>` init block
    const registered = new Map<string, string>();
    const classCalls = new Map<string, Call[]>();
    for (const b of initBlocks) {
      const calls = scanCalls(b.code), nm = exported.get(b.id);
      if (nm?.startsWith("__Packages.")) classCalls.set(nm.slice(11), calls);
      else for (const c of calls) if (c.method === "registerClass" && c.obj === "Object" && c.args[0]?.k === "s" && c.args[1]?.k === "p") registered.set(c.args[0].v, c.args[1].v);
    }
    for (const [id, nodes] of byComp) {
      const cls = registered.get(exported.get(id) ?? "");
      if (cls && classCalls.has(cls)) apply(classCalls.get(cls)!, nodes);
    }
    const script = done.size;
    let guessed = 0;
    if (!locks) {
      const guess = (p: SNode & { t: "frame" }) => {
        for (const k of p.kids) {
          if (k.anchor) continue;
          const [bx0, by0, bx1, by1] = transformBox(k.m, k.box);
          const h = guessAxis(bx0, bx1, p.box[0], p.box[2]), v = guessAxis(by0, by1, p.box[1], p.box[3]);
          if (h || v) { k.anchor = { ...(h && { h }), ...(v && { v }) }; guessed++; }
        }
      };
      guess(root);
      const menu = root.kids.find((k) => k.name === "Menu_mc" && k.t === "frame");
      if (menu?.t === "frame") guess(menu);
    }
    return { script, guessed };
  }

  const kids = await timeline(r, r.end, -1);
  const root: SwfModel["root"] = { t: "frame", name, m: I, box: [x0, y0, x1, y1], kids };
  const anchors = anchor(root);
  // only bitmaps that a fill uses are decoded
  const images: Record<number, Uint8Array> = {};
  const sizes: Record<number, [number, number]> = {};
  const used = new Set<number>();
  const seen = new Set<SNode[]>();
  const walk = (n: SNode) => {
    if (n.t === "frame") { if (!seen.has(n.kids)) { seen.add(n.kids); n.kids.forEach(walk); } }
    else if (n.t === "shape") for (const v of n.vecs) for (const p of [v.fill, v.stroke?.paint]) if (p?.t === "bitmap") used.add(p.id);
  };
  walk(root);
  for (const id of used) {
    try {
      const b = bitmaps.get(id);
      if (!b) { warnings.add(`bitmap ${id} is missing`); continue; }
      images[id] = await b();
      const s = imageSize(images[id]);
      if (s) sizes[id] = s;
    } catch (e) { warnings.add(`bitmap ${id}: ${(e as Error).message}`); }
  }
  return { root, images, sizes, warnings: [...warnings], anchors };
}

/** Old files start the image with the stray bytes FF D9 FF D8. */
const fixJpeg = (d: Uint8Array): Uint8Array => (d[0] === 0xff && d[1] === 0xd9 && d[2] === 0xff && d[3] === 0xd8 ? d.subarray(4) : d);

/** JPEGTables (SOI ... EOI) + image data (SOI ... EOI) make one stream once the table's EOI and the data's SOI are dropped. */
function joinJpeg(tables: Uint8Array, d: Uint8Array): Uint8Array {
  if (!tables.length) return d;
  const t = tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.subarray(0, -2) : tables;
  const i = d[0] === 0xff && d[1] === 0xd8 ? 2 : 0;
  const out = new Uint8Array(t.length + d.length - i);
  out.set(t);
  out.set(d.subarray(i), t.length);
  return out;
}

/** DefineBitsLossless(2) pixel data -> straight-alpha RGBA. Rows are padded to 4 bytes for colour-mapped and 15-bit data. */
export function lossless(z: Uint8Array, alpha: boolean, fmt: number, w: number, h: number, colors: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const cs = alpha ? 4 : 3;
  const pal = z.subarray(0, colors * cs);
  const data = z.subarray(colors * cs);
  const rowBytes = fmt === 3 ? Math.ceil(w / 4) * 4 : fmt === 4 ? Math.ceil((w * 2) / 4) * 4 : w * 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, i = y * rowBytes;
    let r = 0, g = 0, b = 0, a = 255;
    if (fmt === 3) {
      const k = (data[i + x] ?? 0) * cs;
      [r, g, b] = [pal[k] ?? 0, pal[k + 1] ?? 0, pal[k + 2] ?? 0];
      if (alpha) a = pal[k + 3] ?? 0;
    } else if (fmt === 4) {
      const v = (data[i + x * 2] << 8) | data[i + x * 2 + 1];
      r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31;
    } else if (alpha) { // ARGB, premultiplied
      a = data[i + x * 4];
      [r, g, b] = [1, 2, 3].map((k) => (a ? Math.min(255, Math.round((data[i + x * 4 + k] * 255) / a)) : 0));
    } else [r, g, b] = [data[i + x * 4 + 1], data[i + x * 4 + 2], data[i + x * 4 + 3]]; // pad, R, G, B
    out.set([r, g, b, a], o);
  }
  return out;
}
