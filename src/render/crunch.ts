/** Annex K's standard JPEG quantization tables, in natural row-major order. */
export const LUMA_TABLE = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
] as const;
export const CHROMA_TABLE = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
] as const;

export function crunchQuality(amount: number): number { return Math.round(100 - 80 * amount); }

export function qualityTable(table: readonly number[], quality: number): Float32Array {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new RangeError('JPEG quality must be an integer from 1 to 100.');
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  return Float32Array.from(table, (value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}
