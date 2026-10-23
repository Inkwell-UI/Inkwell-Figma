// Pure helpers for image assets (protocol 3 `asset` messages). The editor decodes only plain PNGs, so anything else is re-encoded in the UI iframe.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** A PNG the editor's decoder takes as is: 8 bits per channel, not interlaced, grey / RGB / palette / grey+alpha / RGBA. */
export function isSimplePng(b: Uint8Array): boolean {
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return false;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return false;
  const depth = b[24], color = b[25], interlace = b[28];
  return depth === 8 && interlace === 0 && [0, 2, 3, 4, 6].includes(color);
}

/** Base64 of bytes; chunked because String.fromCharCode(...) has an argument-count limit. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
