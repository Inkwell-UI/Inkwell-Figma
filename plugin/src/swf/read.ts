// Byte and bit reader for SWF data (little-endian bytes, MSB-first bit fields). A byte read drops any half-read bit field.
export class Reader {
  private cur = 0;
  private n = 0;
  constructor(readonly b: Uint8Array, public p = 0, readonly end = b.length) {}
  get left(): number { return this.end - this.p; }
  private raw(): number {
    if (this.p >= this.end) throw new Error("truncated SWF");
    return this.b[this.p++];
  }
  align(): void { this.n = 0; }
  u8(): number { this.n = 0; return this.raw(); }
  u16(): number { return this.u8() | (this.u8() << 8); }
  s16(): number { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
  u32(): number { return this.u16() + this.u16() * 65536; }
  s32(): number { const v = this.u32(); return v >= 2 ** 31 ? v - 2 ** 32 : v; }
  /** FIXED (16.16) and FIXED8 (8.8). */
  f16(): number { return this.s32() / 65536; }
  f8(): number { return this.s16() / 256; }
  bytes(n: number): Uint8Array {
    this.n = 0;
    if (n < 0 || this.p + n > this.end) throw new Error("truncated SWF");
    return this.b.subarray(this.p, (this.p += n));
  }
  str(): string {
    const s = this.p;
    while (this.u8() !== 0);
    return new TextDecoder().decode(this.b.subarray(s, this.p - 1));
  }
  ub(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      if (this.n === 0) { this.cur = this.raw(); this.n = 8; }
      v = v * 2 + ((this.cur >> --this.n) & 1);
    }
    return v;
  }
  sb(bits: number): number { const v = this.ub(bits); return bits > 0 && v >= 2 ** (bits - 1) ? v - 2 ** bits : v; }
  fb(bits: number): number { return this.sb(bits) / 65536; }
  /** RECT in twips: [x0, y0, x1, y1]. */
  rect(): [number, number, number, number] {
    const n = this.ub(5);
    const [x0, x1, y0, y1] = [this.sb(n), this.sb(n), this.sb(n), this.sb(n)];
    this.align();
    return [x0, y0, x1, y1];
  }
  /** MATRIX with the translation still in twips. */
  matrix(): { a: number; b: number; c: number; d: number; tx: number; ty: number } {
    let a = 1, d = 1, b = 0, c = 0;
    if (this.ub(1)) { const n = this.ub(5); a = this.fb(n); d = this.fb(n); }
    if (this.ub(1)) { const n = this.ub(5); b = this.fb(n); c = this.fb(n); }
    const n = this.ub(5);
    const tx = this.sb(n), ty = this.sb(n);
    this.align();
    return { a, b, c, d, tx, ty };
  }
  /** RGB or RGBA as 0..1. */
  color(alpha: boolean): { r: number; g: number; b: number; a: number } {
    const r = this.u8() / 255, g = this.u8() / 255, b = this.u8() / 255;
    return { r, g, b, a: alpha ? this.u8() / 255 : 1 };
  }
  /** CXFORM / CXFORMWITHALPHA: only the alpha multiplier is kept (1 when absent). */
  cxform(alpha: boolean): number {
    const add = this.ub(1), mult = this.ub(1), n = this.ub(4), k = alpha ? 4 : 3;
    let am = 256;
    if (mult) for (let i = 0; i < k; i++) { const v = this.sb(n); if (i === 3) am = v; }
    if (add) for (let i = 0; i < k; i++) this.sb(n);
    this.align();
    return am / 256;
  }
}
