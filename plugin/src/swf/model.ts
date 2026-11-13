// Plain-data result of reading a SWF; built in the UI iframe, posted to the main thread, turned into Figma nodes there.
// All lengths are pixels (SWF twips / 20). A matrix maps a node's local space to its parent's: x' = a*x + c*y + tx.
export type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number };
export type Box = [x0: number, y0: number, x1: number, y1: number];
export type Rgba = { r: number; g: number; b: number; a: number }; // 0..1
export type Paint =
  | { t: "solid"; c: Rgba }
  | { t: "grad"; radial: boolean; stops: { pos: number; c: Rgba }[]; m: Matrix } // m: unit square of the gradient -> shape space
  | { t: "bitmap"; id: number; tile: boolean; m: Matrix }; // m: bitmap pixels -> shape space
/** One filled or stroked outline. `path` is SVG-like and relative to the top-left of `box` (box is in the shape's own space). */
export type Vec = {
  path: string;
  box: Box;
  fill?: Paint;
  stroke?: { paint: Paint; w: number; cap: "ROUND" | "NONE" | "SQUARE"; join: "ROUND" | "BEVEL" | "MITER" };
};
/** A SWF filter that has a Figma effect: drop shadow, glow (a shadow with no offset), blur. */
export type Fx = { t: "shadow"; inner: boolean; c: Rgba; x: number; y: number; blur: number } | { t: "blur"; blur: number };
/** Figma constraints: h and v. Missing = MIN (left / top), Figma's default. */
export type Anchor = { h?: "MIN" | "MAX" | "CENTER" | "STRETCH"; v?: "MIN" | "MAX" | "CENTER" | "STRETCH" };
export type SNode = {
  name: string; m: Matrix; box: Box;
  alpha?: number; hidden?: boolean; mask?: boolean; fx?: Fx[]; anchor?: Anchor;
  blend?: string; // a Figma BlendMode
} & (
  // comp: the sprite/button id; one that is placed more than once becomes a component. label: its name without an instance name.
  | { t: "frame"; kids: SNode[]; comp?: number; label?: string }
  | { t: "shape"; vecs: Vec[] }
  | { t: "text"; text: string; font: string; bold: boolean; italic: boolean; size: number; color: Rgba; align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"; placeholder: boolean; lineHeight?: number; border?: boolean }
);
export type SwfModel = { root: SNode & { t: "frame" }; images: Record<number, Uint8Array>; sizes: Record<number, [number, number]>; warnings: string[];
  /** How many layers got a constraint: from the ActionScript (Lock calls, CLIK Constraints), or guessed from their position when the script had no Lock. */
  anchors: { script: number; guessed: number };
};
