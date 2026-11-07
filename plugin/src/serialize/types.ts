// Minimal structural view of a Figma node. Real nodes satisfy it (cast at the boundary); tests use plain objects.
export type Mixed = symbol; // figma.mixed
export interface FigPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  gradientStops?: readonly { position: number; color: { r: number; g: number; b: number; a?: number }; boundVariables?: { color?: { id?: string } } }[];
  gradientTransform?: readonly (readonly number[])[];
  imageHash?: string | null;
  scaleMode?: string;
  boundVariables?: { color?: { id?: string } };
}
export interface FigParent { id: string; type: string; x?: number; y?: number; parent?: FigParent | null }
export interface FigNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  /** Figma variable aliases by field (`opacity`, `visible`, `width`, `height`, `fontSize`); paint colours are on the paint. */
  boundVariables?: Readonly<Record<string, { id?: string } | readonly unknown[] | undefined>>;
  /** Variable modes set on this layer (collection id -> mode id); inherited ones are not listed. */
  explicitVariableModes?: Readonly<Record<string, string>>;
  /** Text only: the fills of a character range (`figma.mixed` when they differ inside it). */
  getRangeFills?(start: number, end: number): readonly FigPaint[] | symbol;
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
  strokeTopWeight?: number;
  strokeRightWeight?: number;
  strokeBottomWeight?: number;
  strokeLeftWeight?: number;
  clipsContent?: boolean;
  overflowDirection?: string;
  layoutMode?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutPositioning?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutWrap?: string;
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
  /** Collection and mode names of explicit variable modes (ids in, names out); set by the main thread from the variable collections. */
  modeNames?(explicit: Readonly<Record<string, string>>): Record<string, string> | undefined;
}
