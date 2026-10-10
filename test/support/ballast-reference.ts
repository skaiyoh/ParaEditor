// An independent recomputation of a memory-harness ballast chunk, written
// apart from src/dev/harness/ballast.ts so the tests compare two codings of
// one rule: the words of chunk i are xorshift32 states from the seed
// 0x9E3779B9 ^ (i + 1), one per 32-bit word, written in order, and the
// checksum is the 32-bit wrapping sum of every 4,096th word. It reads and
// writes through a DataView, one word at a time, where the ballast fills a
// Uint32Array view page by page.

/** Chunk `index`'s `bytes` bytes, little-endian words, as the ballast writes them. */
export function referenceChunk(index: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  let x = (0x9e3779b9 ^ (index + 1)) >>> 0;
  for (let offset = 0; offset < bytes; offset += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    view.setUint32(offset, x, true);
  }
  return out;
}

/** The checksum of chunk `index` of `bytes` bytes. */
export function referenceSum(index: number, bytes: number): number {
  const view = new DataView(referenceChunk(index, bytes).buffer);
  let sum = 0;
  for (let offset = 0; offset < bytes; offset += 16_384) sum = (sum + view.getUint32(offset, true)) >>> 0;
  return sum;
}
