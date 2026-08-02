// CRC-32 (IEEE 802.3), matching zlib.crc32 — which is what tools/grr.py uses
// when it uploads (`hex(zlib.crc32(data))[2:]`, i.e. lowercase, unpadded).
// RepRapFirmware verifies this against its own computation and rejects the
// upload with err:1 on mismatch, so the encoding has to agree exactly.

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Lowercase, unpadded hex — the form grr.py sends and RRF expects. */
export function crc32Hex(data: Uint8Array): string {
  return crc32(data).toString(16);
}
