import { describe, expect, it } from "vitest";
import { isSimplePng, toBase64 } from "../src/sync/assets.js";

// 8-byte signature + IHDR chunk (length, type, w, h, depth, color, compression, filter, interlace, crc)
const png = (depth: number, color: number, interlace = 0) => {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, depth, color, 0, 0, interlace]);
  return b;
};

describe("assets", () => {
  it("passes plain 8-bit PNGs through and flags the rest for re-encoding", () => {
    for (const c of [0, 2, 3, 4, 6]) expect(isSimplePng(png(8, c))).toBe(true);
    expect(isSimplePng(png(16, 6))).toBe(false);
    expect(isSimplePng(png(4, 3))).toBe(false);
    expect(isSimplePng(png(8, 6, 1))).toBe(false); // interlaced
    expect(isSimplePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false); // JPEG
  });
  it("base64 matches Node's encoder, also past one chunk", () => {
    const b = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
    expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
    expect(toBase64(new Uint8Array())).toBe("");
  });
});
