import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { scanCalls } from "../src/swf/avm1.js";
import { buildSwf } from "../src/swf/build.js";
import { fontCandidates } from "../src/swf/fonts.js";
import { gradientTransform } from "../src/swf/geom.js";
import { parseSwf } from "../src/swf/parse.js";
import { crc32, encodePng, imageSize } from "../src/swf/png.js";
import { summarize } from "../src/swf/summary.js";

// ---- a tiny SWF writer: just what the fixtures need ----
type Field = [number, number];
const bits = (...f: Field[]) => {
  const out: number[] = [];
  let cur = 0, n = 0;
  for (const [v, w] of f) for (let i = w - 1; i >= 0; i--) {
    cur = (cur << 1) | (Math.floor((v < 0 ? v + 2 ** w : v) / 2 ** i) & 1);
    if (++n === 8) { out.push(cur); cur = 0; n = 0; }
  }
  if (n) out.push(cur << (8 - n));
  return out;
};
const u16 = (v: number) => [v & 255, v >> 8];
const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const tag = (code: number, body: number[]) => (body.length < 63 ? [...u16((code << 6) | body.length), ...body] : [...u16((code << 6) | 63), ...u32(body.length), ...body]);
const str = (s: string) => [...Buffer.from(s), 0];
const rect = (x1: number, y1: number) => bits([15, 5], [0, 15], [x1, 15], [0, 15], [y1, 15]);
const move = (tx: number, ty: number) => bits([0, 1], [0, 1], [15, 5], [tx, 15], [ty, 15]);
const scale = (s: number) => bits([1, 1], [23, 5], [s * 65536, 23], [s * 65536, 23], [0, 1], [0, 5]); // MATRIX scaled by s, no translation
const edge = (dx: number, dy: number): Field[] => [[1, 1], [1, 1], [13, 4], [1, 1], [dx, 15], [dy, 15]]; // general straight line, 15-bit deltas
const swf = (body: number[], compress = false) => {
  const b = [...rect(1920 * 2, 1080 * 2), ...u16(12 << 8), ...u16(1), ...body, ...tag(1, []), ...tag(0, [])];
  return Uint8Array.from(compress
    ? [0x43, 0x57, 0x53, 10, 0, 0, 0, 0, ...deflateSync(Buffer.from(b))]
    : [0x46, 0x57, 0x53, 10, 0, 0, 0, 0, ...b]);
};
const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b));

/** A rectangle shape (w x h twips) with one fill style given as raw bytes; `code` 2 = DefineShape (RGB), 32 = DefineShape3 (RGBA). */
const rectShape = (code: number, id: number, fill: number[], w: number, h: number) => tag(code, [
  ...u16(id), ...rect(w, h),
  1, ...fill, // one fill style
  0, // no line styles
  0x10, // 1 fill bit, 0 line bits
  // one bit stream: style change (fill1 = 1, move to 0,0), four edges, end record
  ...bits([0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [1, 1], [15, 5], [0, 15], [0, 15], [1, 1],
    ...edge(w, 0), ...edge(0, h), ...edge(-w, 0), ...edge(0, -h), [0, 6]),
]);
const red = [0, 255, 0, 0];
const shape = rectShape(2, 1, red, 2000, 1000); // id 1: red 100x50 px
const place = (id: number, depth: number, name: string, tx: number, ty: number) =>
  tag(26, [0x06 | (name ? 0x20 : 0), ...u16(depth), ...u16(id), ...move(tx, ty), ...(name ? str(name) : [])]);
const sprite = (id: number, ...inner: number[][]) => tag(39, [...u16(id), ...u16(1), ...inner.flat(), ...tag(1, []), ...tag(0, [])]);
const editText = (id: number, flagsHi: number, flagsLo: number, ...rest: number[][]) => tag(37, [
  ...u16(id), ...rect(2000, 400), flagsHi, flagsLo, ...rest.flat(), ...str("title"), ...str("Hello"),
]);


// ---- ActionScript 2 bytecode, just enough to write the calls the tests look for ----
const push = (...items: (string | number)[]) => {
  const b = items.flatMap((i) => (typeof i === "string" ? [0, ...str(i)] : [7, ...u32(i)]));
  return [0x96, ...u16(b.length), ...b];
};
const op = (...o: number[]) => o;
const GET_VAR = 0x1c, GET_MEMBER = 0x4e, CALL_METHOD = 0x52, CALL_FUNCTION = 0x3d, BIT_OR = 0x61, POP = 0x17;
/** `obj.member.method(args)`: args are pushed last to first, then the argument count, the object path and the method name. */
const callMethod = (objPath: string[], method: string, ...args: (string | number | string[])[]) => [
  ...args.slice().reverse().flatMap((a) => (Array.isArray(a) ? path(a) : push(a))),
  ...push(args.length), ...path(objPath), ...push(method), ...op(CALL_METHOD, POP),
];
const path = (p: string[]) => [...push(p[0]), ...op(GET_VAR), ...p.slice(1).flatMap((m) => [...push(m), ...op(GET_MEMBER)])];
const doAction = (code: number[]) => tag(12, [...code, 0]);
const doInit = (id: number, code: number[]) => tag(59, [...u16(id), ...code, 0]);
const exportAssets = (...e: [number, string][]) => tag(56, [...u16(e.length), ...e.flatMap(([id, n]) => [...u16(id), ...str(n)])]);

describe("parseSwf", () => {
  const body = [
    ...shape,
    ...sprite(2, place(1, 1, "panel", 0, 0)),
    ...editText(3, 0x80 | 1, 0, u16(0), u16(480)), // HasText, HasFont: font 0 (unknown), 24 px
    ...place(2, 1, "Menu_mc", 200, 100), ...place(3, 2, "title", 0, 0),
  ];

  it("turns shapes, sprites and edit text into a nested frame tree, with instance names", async () => {
    const m = await parseSwf(swf(body), inflate, "menu");
    expect(m.root).toMatchObject({ t: "frame", name: "menu", box: [0, 0, 192, 108] });
    const [menu, title] = m.root.kids;
    expect(menu).toMatchObject({ t: "frame", name: "Menu_mc", box: [0, 0, 100, 50], m: { tx: 10, ty: 5 }, comp: 2 });
    const panel = (menu as any).kids[0];
    expect(panel).toMatchObject({ t: "shape", name: "panel", box: [0, 0, 100, 50] });
    expect(panel.vecs).toHaveLength(1);
    expect(panel.vecs[0].fill).toEqual({ t: "solid", c: { r: 1, g: 0, b: 0, a: 1 } });
    expect(panel.vecs[0].path).toBe("M 0 0 L 100 0 L 100 50 L 0 50 L 0 0 Z");
    // the field is 100x20 px; Flash's 2 px gutter is taken off each side
    expect(title).toMatchObject({ t: "text", name: "title", text: "Hello", size: 24, box: [2, 2, 98, 18] });
    expect(m.warnings).toEqual([]);
  });

  it("reads zlib-compressed files the same way and refuses LZMA and non-SWF input", async () => {
    expect(await parseSwf(swf(body, true), inflate)).toEqual(await parseSwf(swf(body), inflate));
    await expect(parseSwf(Uint8Array.from([0x5a, 0x57, 0x53, 10, 0, 0, 0, 0]), inflate)).rejects.toThrow(/LZMA/);
    await expect(parseSwf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), inflate)).rejects.toThrow(/not a SWF/);
  });

  it("warns instead of throwing on a broken tag and on a placement of something it cannot draw", async () => {
    const m = await parseSwf(swf([...tag(2, [1, 0]), ...place(9, 1, "x", 0, 0)]), inflate);
    expect(m.root.kids).toEqual([]);
    expect(m.warnings.join("\n")).toMatch(/tag 2: truncated/);
    expect(m.warnings.join("\n")).toMatch(/character 9/);
  });

  it("reads a gradient fill (the stop count shares a byte with spread and interpolation)", async () => {
    // DefineShape3, linear gradient, 2 stops (RGBA); a wrong byte count would misread the colours as the next fill style
    const grad = [0x10, ...scale(1), 0x02, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255];
    const m = await parseSwf(swf([...rectShape(32, 1, grad, 2000, 1000), ...place(1, 1, "g", 0, 0)]), inflate);
    expect(m.warnings).toEqual([]);
    const fill = (m.root.kids[0] as any).vecs[0].fill;
    expect(fill).toMatchObject({ t: "grad", radial: false });
    expect(fill.stops).toEqual([{ pos: 0, c: { r: 1, g: 0, b: 0, a: 1 } }, { pos: 1, c: { r: 0, g: 0, b: 1, a: 1 } }]);
  });

  it("groups a clip layer with the layers it masks and marks the mask", async () => {
    const clip = tag(26, [0x02 | 0x04 | 0x40, ...u16(1), ...u16(1), ...move(0, 0), ...u16(2)]); // mask at depth 1, covers depth 2
    const m = await parseSwf(swf([...shape, ...clip, ...place(1, 2, "masked", 0, 0), ...place(1, 3, "free", 0, 0)]), inflate);
    expect(m.root.kids.map((k) => k.name)).toEqual(["Mask", "free"]);
    const g = m.root.kids[0] as any;
    expect(g.kids.map((k: any) => [k.name, k.mask])).toEqual([["Shape 1", true], ["masked", undefined]]);
  });

  it("reads filters, blend mode and visibility of PlaceObject3", async () => {
    const blur = [1, 1, ...u32(5 * 65536), ...u32(3 * 65536), 0]; // 1 filter: blur 5 x 3, flags
    const p3 = tag(70, [0x02 | 0x04, 0x01 | 0x02 | 0x20, ...u16(1), ...u16(1), ...move(0, 0), ...blur, 3, 0]); // blend 3 = multiply, visible = 0
    const m = await parseSwf(swf([...shape, ...p3]), inflate);
    expect(m.root.kids[0]).toMatchObject({ fx: [{ t: "blur", blur: 4 }], blend: "MULTIPLY", hidden: true });
  });

  it("draws a character that lives in another SWF as an empty frame named after it, and warns", async () => {
    const imp = tag(71, [...str("skyui/buttonart.swf"), 0, 0, ...u16(1), ...u16(7), ...str("ButtonArt")]);
    const m = await parseSwf(swf([...imp, ...place(7, 1, "", 0, 0)]), inflate);
    expect(m.root.kids[0]).toMatchObject({ t: "frame", name: "ButtonArt", kids: [] });
    expect(m.warnings).toEqual(["ButtonArt comes from another SWF (skyui/buttonart.swf)"]);
  });

  it("reads font class, field border and leading of a text field", async () => {
    const layout = [0, ...u16(0), ...u16(0), ...u16(0), ...u16(40)]; // align left, margins, indent, leading 2 px
    const t = editText(4, 0x80 | 1, 0x80 | 0x20 | 0x08, u16(5), str("$EverywhereMediumFont"), u16(480), layout);
    const m = await parseSwf(swf([...t, ...place(4, 1, "label", 0, 0)]), inflate);
    expect(m.root.kids[0]).toMatchObject({ font: "$EverywhereMediumFont", border: true, lineHeight: 24 * 1.2 + 2 });
  });

  it("makes a PNG of a lossless bitmap, keeps the fill matrix and records the pixel size", async () => {
    const px = [0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 255, 255]; // 2x2, pad+RGB
    const bmp = tag(20, [...u16(9), 5, ...u16(2), ...u16(2), ...deflateSync(Buffer.from(px))]);
    const fill = [0x41, ...u16(9), ...scale(20)];
    const m = await parseSwf(swf([...bmp, ...rectShape(2, 1, fill, 40, 40), ...place(1, 1, "", 0, 0)]), inflate, "b", { deflate: async (b) => new Uint8Array(deflateSync(b)) });
    expect(m.sizes[9]).toEqual([2, 2]);
    expect([...m.images[9].subarray(1, 4)]).toEqual([80, 78, 71]);
    expect((m.root.kids[0] as any).vecs[0].fill).toMatchObject({ t: "bitmap", id: 9, tile: false, m: { a: 1, d: 1 } });
  });

  it("adds the alpha plane to a JPEG through the host's decoder, and drops it when there is none", async () => {
    const jpeg = [0xff, 0xd8, 0xff, 0xd9];
    const t = tag(35, [...u16(9), ...u32(jpeg.length), ...jpeg, ...deflateSync(Buffer.from([128]))]);
    const body2 = [...t, ...rectShape(2, 1, [0x41, ...u16(9), ...scale(20)], 20, 20), ...place(1, 1, "", 0, 0)];
    const withDecoder = await parseSwf(swf(body2), inflate, "j", { decodeJpeg: async () => ({ w: 1, h: 1, rgba: Uint8Array.from([10, 20, 30, 255]) }) });
    expect(withDecoder.sizes[9]).toEqual([1, 1]); // now a PNG
    expect([...(await parseSwf(swf(body2), inflate)).images[9]]).toEqual(jpeg);
  });
});

describe("anchoring from the ActionScript", () => {
  const rectAt = (id: number, w: number, h: number) => rectShape(2, id, red, w, h);
  const inflateOnly = inflate;

  it("scanCalls reads object path, method and arguments, including a function body", () => {
    const body = [...callMethod(["this", "constraints"], "addElement", ["this", "track"], 12), ...callMethod(["Menu_mc"], "Lock", "TR")];
    // wrap the first call in a DefineFunction2 (no name, no params, flags: preload this)
    const fn = [0x8e, ...u16(6 + 0), 0, ...u16(0), 0, ...u16(1), ...u16(body.length), ...body];
    expect(scanCalls(Uint8Array.from(fn))).toEqual([
      { obj: "this.constraints", method: "addElement", args: [{ k: "p", v: "this.track" }, { k: "n", v: 12 }] },
      { obj: "Menu_mc", method: "Lock", args: [{ k: "s", v: "TR" }] },
    ]);
  });

  it("knows CLIK's edge flags, also combined with |", () => {
    const code = [...push(0), ...path(["gfx", "utils", "Constraints", "BOTTOM"]), ...path(["gfx", "utils", "Constraints", "TOP"]), ...op(BIT_OR),
      ...push(2), ...path(["c"]), ...push("addElement"), ...op(CALL_METHOD, POP)];
    // addElement(TOP | BOTTOM, 0): the first argument is the last pushed
    expect(scanCalls(Uint8Array.from(code))[0].args[0]).toEqual({ k: "n", v: 12 });
  });

  it("anchors the clip a frame script locks to the screen", async () => {
    const body = [...rectAt(1, 200, 200), ...sprite(2, place(1, 1, "", 0, 0)), ...place(2, 1, "Menu_mc", 20, 20), ...place(2, 2, "Corner", 20, 1000),
      ...doAction(callMethod(["Corner"], "Lock", "BR"))];
    const m = await parseSwf(swf(body), inflateOnly, "m");
    expect(m.root.kids.find((k) => k.name === "Corner")!.anchor).toEqual({ h: "MAX", v: "MAX" });
    expect(m.anchors.script).toBe(1);
    expect(m.anchors.guessed).toBe(0); // the script has a Lock: nothing is guessed
  });

  it("anchors the children a component class pins, through Object.registerClass and the symbol's export name", async () => {
    // sprite 2 "scrollBar" holds child "track"; class code in init block 50 (exported as __Packages.gfx.controls.ScrollBar)
    const cls = doInit(50, callMethod(["this", "constraints"], "addElement", ["this", "track"], 12));
    const register = doInit(2, [
      ...push("gfx.controls.ScrollBar"), ...push(1), ...push("eval"), ...op(CALL_FUNCTION),
      ...push("scrollBar"), ...push(2), ...path(["Object"]), ...push("registerClass"), ...op(CALL_METHOD, POP),
    ]);
    const body = [...rectAt(1, 100, 400), ...sprite(2, place(1, 1, "track", 0, 0)),
      ...exportAssets([2, "scrollBar"], [50, "__Packages.gfx.controls.ScrollBar"]), ...cls, ...register, ...place(2, 1, "bar", 0, 0)];
    const m = await parseSwf(swf(body), inflateOnly, "m");
    const bar = m.root.kids[0] as any;
    expect(bar.kids[0]).toMatchObject({ name: "track", anchor: { h: "MIN", v: "STRETCH" } });
  });

  it("guesses from position when the script has no Lock: stretch, centre, far edge", async () => {
    // the test stage is 192 x 108 px, the shape 20 x 10 px; placements are in twips
    const m = await parseSwf(swf([...rectAt(1, 400, 200), ...place(1, 1, "plain", 0, 0), ...place(1, 2, "right", 170 * 20, 10 * 20), ...place(1, 3, "mid", 86 * 20, 40 * 20), ...rectAt(2, 3840, 2160), ...place(2, 4, "bg", 0, 0)]), inflateOnly, "g");
    const by = (n: string) => m.root.kids.find((k) => k.name === n)!;
    expect(by("plain").anchor).toBeUndefined();
    expect(by("right").anchor).toEqual({ h: "MAX" });
    expect(by("mid").anchor).toEqual({ h: "CENTER" });
    expect(by("bg").anchor).toEqual({ h: "STRETCH", v: "STRETCH" });
    expect(m.anchors).toEqual({ script: 0, guessed: 3 });
  });
});

// ---- a recording fake of the Figma API ----
function fakeApi(opts: { fonts?: string[]; existing?: any[] } = {}) {
  const made: any[] = [];
  const node = (type: string) => {
    const n: any = {
      type, children: [], width: 0, height: 0, x: 0, y: 0, removed: false,
      appendChild(c: any) { n.children.push(c); }, resize(w: number, h: number) { n.width = w; n.height = h; }, remove() { n.removed = true; },
      createInstance() { const i = node("INSTANCE"); i.main = n; return i; },
    };
    made.push(n);
    return n;
  };
  const api: any = {
    currentPage: { children: opts.existing ?? [{ x: 0, width: 300 }] },
    loadFontAsync: async (f: any) => { if (opts.fonts && f.family !== "Inter" && !opts.fonts.includes(`${f.family}/${f.style}`)) throw new Error("no font"); },
    createFrame: () => node("FRAME"), createComponent: () => node("COMPONENT"), createVector: () => node("VECTOR"), createText: () => node("TEXT"),
    createImage: () => ({ hash: "h" }),
  };
  return { api, made };
}

describe("buildSwf", () => {
  const sheet = [...shape, ...sprite(2, place(1, 1, "panel", 0, 0))];

  it("creates a stage frame with the named children, parked right of existing layers", async () => {
    const { api } = fakeApi();
    const r = (await buildSwf(await parseSwf(swf([...sheet, ...place(2, 1, "Menu_mc", 200, 100)]), inflate, "menu"), api))!;
    expect(r).toMatchObject({ frames: 2, shapes: 1, texts: 0, components: 0 });
    expect(r.root).toMatchObject({ name: "menu", x: 400, width: 192 });
    const menu = r.root.children[0] as any;
    expect(menu).toMatchObject({ name: "Menu_mc", width: 100, height: 50, relativeTransform: [[1, 0, 10], [0, 1, 5]] });
    expect(menu.children[0]).toMatchObject({ name: "panel", vectorPaths: [{ windingRule: "EVENODD" }] });
  });

  it("builds a sprite that is placed twice once, as a component, and places two instances", async () => {
    const { api, made } = fakeApi();
    const r = (await buildSwf(await parseSwf(swf([...sheet, ...place(2, 1, "row_0", 0, 0), ...place(2, 2, "row_1", 0, 300)]), inflate, "menu"), api))!;
    expect(r.components).toBe(1);
    expect(made.filter((n) => n.type === "COMPONENT")).toHaveLength(1);
    expect(made.filter((n) => n.type === "VECTOR")).toHaveLength(1); // the panel exists once, inside the component
    const [a, b] = r.root.children as any[];
    expect([a.type, a.name, b.type, b.name]).toEqual(["INSTANCE", "row_0", "INSTANCE", "row_1"]);
    expect(a.main).toBe(b.main);
    expect(a.main).toMatchObject({ name: "Sprite 2", x: 192 + 400 + 100 });
    expect(b.relativeTransform[1][2]).toBe(15);
  });

  it("applies mask, hidden, blend and effects to the nodes", async () => {
    const { api } = fakeApi();
    const blur = [1, 1, ...u16(0), ...u16(5), ...u16(0), ...u16(3), 0];
    const p3 = tag(70, [0x02 | 0x04, 0x01 | 0x02 | 0x20, ...u16(2), ...u16(1), ...move(0, 0), ...blur, 3, 0]);
    const clip = tag(26, [0x02 | 0x04 | 0x40, ...u16(1), ...u16(1), ...move(0, 0), ...u16(1)]);
    const r = (await buildSwf(await parseSwf(swf([...shape, ...clip, ...p3]), inflate, "m"), api))!;
    const [group] = r.root.children as any[];
    expect(group.name).toBe("Mask");
    expect(group.children[0].isMask).toBe(true);
    const r2 = (await buildSwf(await parseSwf(swf([...shape, ...p3]), inflate, "m"), api))!;
    expect(r2.root.children[0]).toMatchObject({ visible: false, blendMode: "MULTIPLY", effects: [{ type: "LAYER_BLUR", radius: 4 }] });
  });

  it("maps game font aliases to their Figma face, falls back to Inter and reports it", async () => {
    const t = (id: number, cls: string) => editText(id, 0x80 | 1, 0x80, u16(5), str(cls), u16(480));
    const { api, made } = fakeApi({ fonts: ["Everywhere/Medium"] });
    const r = (await buildSwf(await parseSwf(swf([...t(4, "$EverywhereMediumFont"), ...t(5, "$ConsoleFont"), ...place(4, 1, "a", 0, 0), ...place(5, 2, "b", 0, 0)]), inflate, "t"), api))!;
    const [a, b] = made.filter((n) => n.type === "TEXT");
    expect(a.fontName).toEqual({ family: "Everywhere", style: "Medium" });
    expect(b.fontName).toEqual({ family: "Inter", style: "Regular" });
    expect(r.fallbackFonts).toEqual(["$ConsoleFont"]);
  });

  it("puts a bordered text field in a white, outlined frame", async () => {
    const { api } = fakeApi();
    const t = editText(4, 0x80 | 1, 0x08, u16(0), u16(480));
    const r = (await buildSwf(await parseSwf(swf([...t, ...place(4, 1, "field", 0, 0)]), inflate, "t"), api))!;
    const f = r.root.children[0] as any;
    expect(f).toMatchObject({ type: "FRAME", name: "field", strokeWeight: 1 });
    expect(f.children[0]).toMatchObject({ type: "TEXT", characters: "Hello" });
  });

  it("gives a clipped bitmap fill an image transform that is the identity when the bitmap covers the shape", async () => {
    const px = [0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 255, 255];
    const bmp = tag(20, [...u16(9), 5, ...u16(2), ...u16(2), ...deflateSync(Buffer.from(px))]);
    const { api } = fakeApi();
    const m = await parseSwf(swf([...bmp, ...rectShape(2, 1, [0x41, ...u16(9), ...scale(20)], 40, 40), ...place(1, 1, "", 0, 0)]), inflate);
    const r = (await buildSwf(m, api))!;
    const fill = (r.root.children[0] as any).fills[0];
    expect(fill).toMatchObject({ type: "IMAGE", scaleMode: "CROP", imageHash: "h" });
    expect(fill.imageTransform.flat().map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it("sets Figma constraints on anchored layers and leaves the others at the default", async () => {
    const { api } = fakeApi();
    const body = [...shape, ...place(1, 1, "Corner", 0, 0), ...place(1, 2, "Free", 0, 0), ...doAction(callMethod(["Corner"], "Lock", "BR"))];
    const r = (await buildSwf(await parseSwf(swf(body), inflate, "a"), api))!;
    const [corner, free] = r.root.children as any[];
    expect(corner.constraints).toEqual({ horizontal: "MAX", vertical: "MAX" });
    expect(free.constraints).toBeUndefined();
    expect(r.anchors).toEqual({ script: 1, guessed: 0 });
  });

  it("reports progress, and removes everything again when cancelled", async () => {
    const many = Array.from({ length: 150 }, (_, i) => place(1, i + 1, `s${i}`, 0, 0)).flat();
    const m = await parseSwf(swf([...shape, ...many]), inflate, "big");
    const progress: number[] = [];
    const ok = (await buildSwf(m, fakeApi().api, { progress: (d) => progress.push(d) }))!;
    expect(ok.shapes).toBe(150);
    expect(progress).toEqual([100]);
    const { api, made } = fakeApi();
    expect(await buildSwf(m, api, { cancelled: () => true })).toBeNull();
    expect(made.find((n) => n.type === "FRAME")!.removed).toBe(true);
  });
});

describe("summarize", () => {
  it("counts layers and groups reader warnings into plain words", () => {
    const r = summarize({
      name: "bestiarymenu", frames: 87, shapes: 39, texts: 48, fonts: [],
      warnings: ["character 136 is not drawable, skipped", "tag 32: unknown fill style 153", "character 143 is not drawable, skipped"],
    });
    expect(r).toMatchObject({ title: "Added “bestiarymenu”", layers: 174, skippedCount: 3, fonts: "" });
    expect(r.skipped).toEqual(["2 elements could not be drawn", "1 shape has a fill Inkwell cannot read"]);
  });
  it("is quiet when nothing was skipped and names the font fallbacks", () => {
    const r = summarize({ name: "settings", frames: 12, shapes: 4, texts: 9, fonts: ["$ConsoleFont"], warnings: ["some filters (bevel, gradient, colour) are not supported", "something new"] });
    expect(r.skipped).toEqual(["Some effects (bevel, colour filters, some blend modes) were left out", "something new"]);
    expect(r.fonts).toBe("Inter used instead of $ConsoleFont");
    expect(summarize({ name: "a", frames: 1, shapes: 0, texts: 0, fonts: [], warnings: [] })).toMatchObject({ skipped: [], skippedCount: 0 });
  });
  it("names elements that live in other SWF files", () => {
    const r = summarize({ name: "a", frames: 1, shapes: 0, texts: 0, fonts: [], warnings: ["ButtonArt comes from another SWF (skyui/buttonart.swf)"] });
    expect(r.skipped).toEqual(["1 element comes from other SWF files and is left as empty frames"]);
  });
});

describe("helpers", () => {
  it("encodePng wraps the pixels in a valid, inflatable PNG, and takes a ready zlib stream", () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128]);
    for (const png of [encodePng(2, 1, rgba), encodePng(2, 1, rgba, new Uint8Array(deflateSync(Buffer.from([0, ...rgba]))))]) {
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const chunks: Record<string, Buffer> = {};
      for (let p = 8; p < png.length; ) { // length, type, data, crc: every CRC must match
        const len = Buffer.from(png).readUInt32BE(p), body = Buffer.from(png.subarray(p + 4, p + 8 + len));
        expect(Buffer.from(png).readUInt32BE(p + 8 + len)).toBe(crc32(body));
        chunks[body.subarray(0, 4).toString()] = body.subarray(4);
        p += 12 + len;
      }
      expect([...chunks.IHDR.subarray(0, 8)]).toEqual([0, 0, 0, 2, 0, 0, 0, 1]);
      expect([...inflateSync(chunks.IDAT)]).toEqual([0, ...rgba]);
    }
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
  it("imageSize reads PNG and JPEG headers", () => {
    expect(imageSize(encodePng(7, 3, new Uint8Array(7 * 3 * 4)))).toEqual([7, 3]);
    expect(imageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 16, 0, 32, 3]))).toEqual([32, 16]);
    expect(imageSize(Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });
  it("a gradient that exactly covers the shape box maps to the identity transform", () => {
    // gradient unit square -> a 100x50 box at (10, 20)
    const t = gradientTransform({ a: 100, b: 0, c: 0, d: 50, tx: 10, ty: 20 }, [10, 20, 110, 70]);
    expect(t.flat().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0]);
  });
  it("tries the game's face first, then the name, then Inter", () => {
    expect(fontCandidates("$EverywhereBoldFont", true, false)[0]).toEqual({ family: "Everywhere", style: "Bold" });
    expect(fontCandidates("Arial", true, true).slice(0, 2)).toEqual([{ family: "Arial", style: "Bold Italic" }, { family: "Arial", style: "Regular" }]);
    expect(fontCandidates("", false, false)).toEqual([{ family: "Inter", style: "Regular" }, { family: "Inter", style: "Regular" }]);
  });
});
