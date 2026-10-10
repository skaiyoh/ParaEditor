import { srgbToOklab } from '../core/color.ts';
import { maskCovers } from '../core/derive.ts';
import type { AssetId, ModelId } from '../core/ids.ts';
import type { ImagePoint, Plane, Rect, Size } from '../core/raster.ts';
import type { DepthStats, ObjectColor, ObjectProduced, Selection } from '../core/types.ts';
import { clusterPixels } from '../photo/stats.ts';

export type Thumbnail = { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray };

/** Outward-rounded master pixel box of the occupied guide texel cells. */
export function maskBounds(mask: Plane<'u8'>, master: Size): Rect | null {
  let left = mask.size.width, top = mask.size.height, right = -1, bottom = -1;
  let count = 0;
  for (let y = 0; y < mask.size.height; y++) for (let x = 0; x < mask.size.width; x++) {
    if ((mask.data[y * mask.size.width + x] ?? 0) < 128) continue;
    count++; left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (count < mask.size.width * mask.size.height * 0.001) return null;
  const x = Math.floor(left * master.width / mask.size.width);
  const y = Math.floor(top * master.height / mask.size.height);
  return { x, y, width: Math.ceil((right + 1) * master.width / mask.size.width) - x,
    height: Math.ceil((bottom + 1) * master.height / mask.size.height) - y };
}

/** Center sampling normally; occupied texel projection preserves thin accepted masks. */
function maskedIndices(mask: Plane<'u8'>, size: Size): readonly number[] {
  const indices: number[] = [];
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    if (maskCovers(mask, { x: (x + 0.5) / size.width, y: (y + 0.5) / size.height })) indices.push(y * size.width + x);
  }
  if (indices.length > 0) return indices;
  const projected = new Set<number>();
  for (let y = 0; y < mask.size.height; y++) for (let x = 0; x < mask.size.width; x++) {
    if ((mask.data[y * mask.size.width + x] ?? 0) < 128) continue;
    const tx = Math.min(size.width - 1, Math.floor((x + 0.5) * size.width / mask.size.width));
    const ty = Math.min(size.height - 1, Math.floor((y + 0.5) * size.height / mask.size.height));
    projected.add(ty * size.width + tx);
  }
  return [...projected];
}

/** Sample the mask at depth texel centers, using the core's coverage rule. */
export function maskedDepth(mask: Plane<'u8'>, depth: Plane<'f32'>): DepthStats | null {
  const values: number[] = [];
  for (const index of maskedIndices(mask, depth.size)) {
    const value = depth.data[index];
    if (value !== undefined && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const percentile = (fraction: number): number => {
    const rank = (values.length - 1) * fraction;
    const low = values[Math.floor(rank)] ?? 0;
    const high = values[Math.ceil(rank)] ?? low;
    return low + (high - low) * (rank - Math.floor(rank));
  };
  return { p10: percentile(0.1), median: percentile(0.5), p90: percentile(0.9) };
}

export function maskedColor(mask: Plane<'u8'>, thumbnail: Thumbnail, seed: number): ObjectColor {
  const pixels: number[] = [];
  let L = 0, a = 0, b = 0;
  for (const index of maskedIndices(mask, thumbnail)) {
    const i = index * 4;
    const r = thumbnail.data[i] ?? 0, g = thumbnail.data[i + 1] ?? 0, blue = thumbnail.data[i + 2] ?? 0;
    const lab = srgbToOklab({ r: r / 255, g: g / 255, b: blue / 255 });
    L += lab.L; a += lab.a; b += lab.b;
    pixels.push(r, g, blue, 255);
  }
  const count = pixels.length / 4;
  if (count === 0) throw new Error('The object contains no thumbnail pixels.');
  const [first, ...rest] = clusterPixels(new Uint8ClampedArray(pixels), seed, 3);
  // The schema requires two clusters even for a perfectly flat object.
  const clusters: ObjectColor['clusters'] = rest.length === 0
    ? [{ lab: first.lab, weight: 0.5 }, { lab: first.lab, weight: 0.5 }]
    : [first, ...rest];
  return { mean: { L: L / count, a: a / count, b: b / count }, clusters };
}

export function objectProduced(input: {
  readonly model: ModelId; readonly at: ImagePoint; readonly asset: AssetId;
  readonly mask: Plane<'u8'>; readonly master: Size; readonly depth: Plane<'f32'> | null;
  readonly thumbnail: Thumbnail; readonly seed: number;
  readonly selection?: Selection;
}): ObjectProduced | null {
  const bounds = maskBounds(input.mask, input.master);
  if (bounds === null) return null;
  return {
    model: input.model, selection: input.selection ?? { kind: 'taps', points: [{ at: input.at, label: 'include' }], candidate: 0, size: 0.5 },
    mask: { asset: input.asset, size: input.mask.size, format: 'u8' }, bounds,
    depth: input.depth === null ? null : maskedDepth(input.mask, input.depth),
    color: maskedColor(input.mask, input.thumbnail, input.seed),
  };
}
