// Minimal PNG writer (8-bit RGBA, zlib "stored" blocks). Figma needs PNG/JPEG bytes and the plugin main thread has no canvas.
// shortcut: no compression, so big for large bitmaps; upgrade by deflating in the iframe (CompressionStream) if menus ship large lossless art.
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export const crc32 = (b: ArrayLike<number>): number => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function zlibStored(raw: Uint8Array): number[] {
  const out = [0x78, 0x01];
  for (let o = 0; o < raw.length || o === 0; o += 65535) {
    const n = Math.min(65535, raw.length - o);
    out.push(o + n >= raw.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255);
    for (let i = 0; i < n; i++) out.push(raw[o + i]);
  }
  let s1 = 1, s2 = 0;
  for (const x of raw) { s1 = (s1 + x) % 65521; s2 = (s2 + s1) % 65521; }
  return out.concat(be32(((s2 << 16) | s1) >>> 0));
}

/** PNG scanlines: a filter byte (0) before every row of RGBA. */
export function scanlines(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = w * 4 + 1, raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  return raw;
}

/** `zlib`: the scanlines already deflated (zlib format), when the caller can compress; otherwise they go in uncompressed. */
export function encodePng(w: number, h: number, rgba: Uint8Array, zlib?: Uint8Array): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", zlib ? Array.from(zlib) : zlibStored(scanlines(w, h, rgba))),
    ...chunk("IEND", []),
  ]);
}

/** Pixel size of a PNG or JPEG, or undefined (GIF, damaged). */
export function imageSize(b: Uint8Array): [number, number] | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) return [((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0];
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) ? 2 : 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return undefined;
}
