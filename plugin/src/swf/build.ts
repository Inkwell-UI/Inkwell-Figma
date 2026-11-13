// Main thread: turns a SwfModel into Figma nodes (one top-level frame = one SWF, so the normal sync picks it up).
import { fontCandidates } from "./fonts.js";
import { gradientTransform, I, inv, move, mul } from "./geom.js";
import type { Fx, Matrix, Paint as P, SNode, SwfModel, Vec } from "./model.js";

const GREY: P = { t: "solid", c: { r: 0.8, g: 0.8, b: 0.8, a: 1 } };
const rt = (m: Matrix): Transform => [[m.a, m.c, m.tx], [m.b, m.d, m.ty]];
const INTER: FontName = { family: "Inter", style: "Regular" };
const CANCELLED = new Error("cancelled");
const effect = (f: Fx): Effect =>
  f.t === "blur"
    ? { type: "LAYER_BLUR", blurType: "NORMAL", radius: f.blur, visible: true }
    : { type: f.inner ? "INNER_SHADOW" : "DROP_SHADOW", color: f.c, offset: { x: f.x, y: f.y }, radius: f.blur, spread: 0, visible: true, blendMode: "NORMAL" };

export type BuildHooks = { progress?: (done: number, total: number) => void; cancelled?: () => boolean };
export type BuildResult = { root: FrameNode; frames: number; shapes: number; texts: number; components: number; fallbackFonts: string[]; warnings: string[]; anchors: SwfModel["anchors"] };
type Frame = SNode & { t: "frame" };
type Text = SNode & { t: "text" };

/** Returns null when `hooks.cancelled()` turned true: everything made so far is removed again. */
export async function buildSwf(model: SwfModel, api: PluginAPI, hooks: BuildHooks = {}): Promise<BuildResult | null> {
  // One look at the tree first: how many nodes (for progress), which sprites repeat (they become components), which fonts are needed.
  const fontKeys = new Map<string, { name: string; bold: boolean; italic: boolean }>();
  const uses = new Map<number, number>();
  const seen = new Set<SNode[]>();
  let total = 0;
  const key = (n: Text) => `${n.font}|${n.bold}|${n.italic}`;
  const scan = (n: SNode) => {
    total++;
    if (n.t === "text") fontKeys.set(key(n), { name: n.font, bold: n.bold, italic: n.italic });
    if (n.t !== "frame") return;
    if (n.comp !== undefined) uses.set(n.comp, (uses.get(n.comp) ?? 0) + 1);
    if (!seen.has(n.kids)) { seen.add(n.kids); n.kids.forEach(scan); } // a repeated sprite shares its kids: visit them once
  };
  scan(model.root);

  // Fonts: loadFontAsync must finish before a text node can use the font.
  const fonts = new Map<string, FontName>();
  const fallbackFonts: string[] = [];
  await api.loadFontAsync(INTER);
  for (const [k, f] of fontKeys) {
    for (const c of fontCandidates(f.name, f.bold, f.italic)) {
      try { await api.loadFontAsync(c); fonts.set(k, c); break; } catch { /* try the next one */ }
    }
    if (!fonts.has(k)) fonts.set(k, INTER);
    if (f.name && fonts.get(k)!.family === "Inter" && f.name !== "Inter" && !fallbackFonts.includes(f.name)) fallbackFonts.push(f.name);
  }

  const hashes = new Map<number, string>();
  const paint = (p: P, v: Vec): Paint => {
    if (p.t === "solid") return { type: "SOLID", color: { r: p.c.r, g: p.c.g, b: p.c.b }, opacity: p.c.a };
    if (p.t === "grad") {
      return {
        type: p.radial ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR", gradientTransform: gradientTransform(p.m, v.box),
        gradientStops: p.stops.map((s) => ({ position: s.pos, color: s.c })),
      };
    }
    const bytes = model.images[p.id];
    if (!bytes) return paint(GREY, v);
    if (!hashes.has(p.id)) hashes.set(p.id, api.createImage(bytes).hash);
    const imageHash = hashes.get(p.id) ?? null, size = model.sizes[p.id];
    if (!size) return { type: "IMAGE", imageHash, scaleMode: "FILL" };
    // shortcut: a repeating bitmap keeps its scale but starts at the shape's corner (Figma cannot offset or rotate a tile)
    if (p.tile) return { type: "IMAGE", imageHash, scaleMode: "TILE", scalingFactor: Math.hypot(p.m.a, p.m.b) || 1 };
    const [x0, y0, x1, y1] = v.box;
    // clipped bitmap: node unit square -> normalized image = inverse(normalized image -> shape) after (unit square -> shape box)
    const t = mul(inv(mul(p.m, { a: size[0], b: 0, c: 0, d: size[1], tx: 0, ty: 0 })), { a: Math.max(x1 - x0, 0.01), b: 0, c: 0, d: Math.max(y1 - y0, 0.01), tx: x0, ty: y0 });
    return { type: "IMAGE", imageHash, scaleMode: "CROP", imageTransform: [[t.a, t.c, t.tx], [t.b, t.d, t.ty]] };
  };

  let frames = 0, shapes = 0, texts = 0, made = 0;
  const tick = async () => {
    if (++made % 100) return;
    hooks.progress?.(made, total);
    await new Promise<void>((r) => setTimeout(r, 0)); // let Figma and the UI breathe; a cancel arrives between ticks
    if (hooks.cancelled?.()) throw CANCELLED;
  };

  const vector = (v: Vec, parent: BaseNode & ChildrenMixin, name: string, m: Matrix) => {
    const n = api.createVector();
    parent.appendChild(n);
    n.name = name;
    n.vectorPaths = [{ windingRule: v.stroke ? "NONE" : "EVENODD", data: v.path }];
    n.fills = v.fill ? [paint(v.fill, v)] : [];
    n.strokes = v.stroke ? [paint(v.stroke.paint, v)] : [];
    if (v.stroke) { n.strokeWeight = v.stroke.w; n.strokeCap = v.stroke.cap; n.strokeJoin = v.stroke.join; }
    n.relativeTransform = rt(m);
    return n;
  };

  const text = (n: Text, parent: BaseNode & ChildrenMixin, m: Matrix) => {
    const t = api.createText();
    parent.appendChild(t);
    t.name = n.name;
    t.fontName = fonts.get(key(n)) ?? INTER;
    t.characters = n.text;
    t.fontSize = Math.max(1, n.size);
    t.fills = [paint({ t: "solid", c: n.color }, { box: n.box } as Vec)];
    t.textAlignHorizontal = n.align;
    if (n.lineHeight) t.lineHeight = { unit: "PIXELS", value: n.lineHeight };
    t.textAutoResize = "NONE";
    t.resize(Math.max(1, n.box[2] - n.box[0]), Math.max(1, n.box[3] - n.box[1]));
    t.relativeTransform = rt(m);
    return t;
  };

  const decorate = (node: SceneNode, n: SNode) => {
    if (n.alpha !== undefined && n.alpha < 1) (node as BlendMixin).opacity = n.alpha;
    if (n.blend) (node as BlendMixin).blendMode = n.blend as BlendMode;
    if (n.fx?.length) (node as BlendMixin).effects = n.fx.map(effect);
    if (n.mask) (node as BlendMixin).isMask = true;
    if (n.hidden) node.visible = false;
    if (n.anchor) (node as ConstraintMixin).constraints = { horizontal: n.anchor.h ?? "MIN", vertical: n.anchor.v ?? "MIN" };
  };

  // A sprite placed more than once is built once as a component (parked right of the stage); each placement is an instance of it.
  const [x0, y0, x1, y1] = model.root.box;
  const x = api.currentPage.children.reduce((m, c) => Math.max(m, c.x + c.width + 100), 0);
  const built = new Map<number, ComponentNode>();
  let compY = 0;
  const component = async (n: Frame): Promise<ComponentNode> => {
    let c = built.get(n.comp!);
    if (c) return c;
    c = api.createComponent();
    built.set(n.comp!, c);
    const w = Math.max(1, n.box[2] - n.box[0]), h = Math.max(1, n.box[3] - n.box[1]);
    c.name = n.label ?? n.name;
    c.fills = [];
    c.clipsContent = false;
    c.resize(w, h);
    c.x = x + (x1 - x0) + 100;
    c.y = compY;
    compY += h + 40;
    for (const k of n.kids) await make(k, c, [n.box[0], n.box[1]]);
    return c;
  };

  /** `off`: the parent's origin in its own character space (children are placed relative to the parent frame's top-left). */
  const make = async (n: SNode, parent: BaseNode & ChildrenMixin, off: [number, number]): Promise<void> => {
    await tick();
    const k = { ...n.m, tx: n.m.tx - off[0], ty: n.m.ty - off[1] };
    const own = move(k, n.box[0], n.box[1]); // the node's top-left corner
    let node: SceneNode;
    if (n.t === "frame" && n.comp !== undefined && (uses.get(n.comp) ?? 0) > 1) {
      const i = (await component(n)).createInstance();
      parent.appendChild(i);
      i.name = n.name;
      i.relativeTransform = rt(own);
      frames++;
      node = i;
    } else if (n.t === "shape" && n.vecs.length === 1) {
      shapes++;
      node = vector(n.vecs[0], parent, n.name, move(k, n.vecs[0].box[0], n.vecs[0].box[1]));
    } else if (n.t === "text" && !n.border) {
      texts++;
      node = text(n, parent, own);
    } else {
      const f = api.createFrame();
      parent.appendChild(f);
      f.name = n.name;
      f.fills = [];
      f.clipsContent = false;
      f.resize(Math.max(1, n.box[2] - n.box[0]), Math.max(1, n.box[3] - n.box[1]));
      f.relativeTransform = rt(own);
      if (n.t === "frame") { frames++; for (const c of n.kids) await make(c, f, [n.box[0], n.box[1]]); }
      else if (n.t === "text") { // a field with a border: white box, black outline, the text inside
        texts++;
        f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        f.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
        f.strokeWeight = 1;
        text(n, f, I);
      } else { shapes++; n.vecs.forEach((v, i) => vector(v, f, v.stroke ? `Line ${i + 1}` : `Fill ${i + 1}`, move(I, v.box[0] - n.box[0], v.box[1] - n.box[1]))); }
      node = f;
    }
    decorate(node, n);
  };

  const root = api.createFrame();
  root.name = model.root.name;
  root.fills = [];
  root.clipsContent = true;
  root.resize(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  root.x = x;
  root.y = 0;
  frames++;
  try { for (const c of model.root.kids) await make(c, root, [x0, y0]); }
  catch (e) {
    if (e !== CANCELLED) throw e;
    for (const c of built.values()) c.remove();
    root.remove();
    return null;
  }
  return { root, frames, shapes, texts, components: built.size, fallbackFonts, warnings: model.warnings, anchors: model.anchors };
}
