// Minimal structural view of a Figma node. Real nodes satisfy it (cast at the boundary); tests use plain objects.
export type Mixed = symbol; // figma.mixed
export interface FigPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  gradientStops?: readonly { position: number; color: { r: number; g: number; b: number; a?: number } }[];
  gradientTransform?: readonly (readonly number[])[];
  imageHash?: string | null;
  scaleMode?: string;
}
export interface FigParent { id: string; type: string; parent?: FigParent | null }
export interface FigNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  isMask?: boolean;
  rotation?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parent?: FigParent | null;
  children?: readonly FigNode[];
  constraints?: { horizontal: string; vertical: string };
  fills?: readonly FigPaint[] | Mixed;
  strokes?: readonly FigPaint[];
  strokeWeight?: number | Mixed;
  strokeAlign?: string;
  clipsContent?: boolean;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  vectorPaths?: readonly { data: string }[];
  fillGeometry?: readonly { data: string }[];
  characters?: string;
  fontName?: { family: string; style: string } | Mixed;
  fontSize?: number | Mixed;
  textStyleId?: string | Mixed;
  textAutoResize?: string;
  textTruncation?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: { unit: string; value?: number } | Mixed;
  letterSpacing?: { unit: string; value: number } | Mixed;
  componentProperties?: Readonly<Record<string, { type: string; value: unknown }>>;
}

/** Things the pure serializer cannot read synchronously on real nodes. */
export interface Ctx {
  /** IR id of a node (see IdMap); equals the Figma id unless a stored mapping says otherwise. */
  id(n: { id: string }): string;
  /** Resolved main component id of an instance (async in dynamic-page mode, so prefetched). */
  componentOf(n: FigNode): string | undefined;
  /** Name of the text style a text node uses (async in Figma, so prefetched by the main thread). */
  styleNameOf?(n: FigNode): string | undefined;
}
