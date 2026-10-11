// Pure owner-local coverage. Every result owns fresh bytes, including no-ops.
import { compositionSizeSchema } from './composition-schema.ts';
import type { Plane, Size } from './raster.ts';
import { z } from './zod.ts';

export const sourcePointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() }).readonly();
export type SourcePoint = z.infer<typeof sourcePointSchema>;
export const maskShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rectangle'), from: sourcePointSchema, to: sourcePointSchema }),
  z.strictObject({ kind: z.literal('path'), points: z.array(sourcePointSchema) }),
]);
export type MaskShape = z.infer<typeof maskShapeSchema>;
export type MaskCombine = 'replace' | 'add' | 'remove';
const maskSchema = z.strictObject({ format: z.literal('u8'), size: compositionSizeSchema,
  data: z.instanceof(Uint8Array) }).superRefine((plane, ctx) => {
  if (plane.data.length !== plane.size.width * plane.size.height) ctx.addIssue({ code: 'custom', message: 'Mask byte length must match its dimensions.' });
});
export const featherRadiusSchema = z.number().finite().min(0).max(64);

export function copyMask(plane: Plane<'u8'>): Plane<'u8'> {
  maskSchema.parse(plane);
  return { format: 'u8', size: { ...plane.size }, data: plane.data.slice() };
}

export function emptyMask(size: Size): Plane<'u8'> {
  compositionSizeSchema.parse(size);
  return { format: 'u8', size: { ...size }, data: new Uint8Array(size.width * size.height) };
}

/** Implicitly closed even-odd path, with fixed 4x4 pixel-center subsamples.
 * Scanline intersections use half-open edges so repeated vertices/horizontal edges
 * cannot double count. Empty, collinear and zero-width rectangles remain empty. */
export function rasterizeMask(size: Size, shape: MaskShape): Plane<'u8'> {
  const output = emptyMask(size);
  maskShapeSchema.parse(shape);
  const points = shape.kind === 'path' ? shape.points : [shape.from,
    { x: shape.to.x, y: shape.from.y }, shape.to, { x: shape.from.x, y: shape.to.y }];
  if (points.length < 3) return output;
  const counts = new Uint8Array(size.width);
  for (let y = 0; y < size.height; y++) {
    counts.fill(0);
    for (let sy = 0; sy < 4; sy++) {
      const sampleY = y + (sy + .5) / 4, crossings: number[] = [];
      let previous = points.at(-1);
      for (const point of points) {
        if (previous !== undefined && (point.y > sampleY) !== (previous.y > sampleY)) {
          const t = (sampleY - point.y) / (previous.y - point.y);
          crossings.push(point.x * (1 - t) + previous.x * t);
        }
        previous = point;
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = crossings[i], right = crossings[i + 1];
        if (left === undefined || right === undefined) continue;
        const start = Math.max(0, Math.ceil(left * 4 - .5));
        const end = Math.min(size.width * 4, Math.ceil(right * 4 - .5));
        for (let sx = start; sx < end; sx++) {
          const x = Math.floor(sx / 4);
          counts[x] = (counts[x] ?? 0) + 1;
        }
      }
    }
    for (let x = 0; x < size.width; x++) output.data[y * size.width + x] = Math.round((counts[x] ?? 0) * 255 / 16);
  }
  return output;
}

/** Inside the owner, plane texels clamp to their centers; outside the owner is zero.
 * Legacy coverage materializes the renderer's threshold and inward edge kernel. */
export function sampleMask(input: { readonly plane: Plane<'u8'>; readonly owner: Size;
  readonly at: SourcePoint; readonly sampling: 'coverage' | 'legacy-threshold' }): number {
  const { plane, owner, at, sampling } = input;
  maskSchema.parse(plane); compositionSizeSchema.parse(owner); sourcePointSchema.parse(at);
  return sample(plane, owner, at, sampling);
}

function sample(plane: Plane<'u8'>, owner: Size, at: SourcePoint, sampling: 'coverage' | 'legacy-threshold'): number {
  if (at.x < 0 || at.y < 0 || at.x >= owner.width || at.y >= owner.height) return 0;
  if (sampling === 'coverage') return bilinear(plane, owner, at);
  // geometryCoverage/perspectiveCoverage use .5 normalized (127.5 byte),
  // not the CPU picking/repair-support helper's integer 128 threshold.
  // Preserve their CLAMP_TO_EDGE neighbor taps, but only evaluate this kernel
  // for an in-owner point; output coverage never extends outside the owner.
  if (bilinear(plane, owner, at) < 127.5) return 0;
  let sum = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (bilinear(plane, owner, { x: at.x + dx, y: at.y + dy }) >= 127.5) sum += (3 - Math.abs(dx)) * (3 - Math.abs(dy));
  }
  return Math.max(0, Math.min(1, 2 * sum / 81 - 1)) * 255;
}

function bilinear(plane: Plane<'u8'>, owner: Size, at: SourcePoint): number {
  const x = Math.max(0, Math.min(plane.size.width - 1, at.x / owner.width * plane.size.width - .5));
  const y = Math.max(0, Math.min(plane.size.height - 1, at.y / owner.height * plane.size.height - .5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, plane.size.width - 1), y1 = Math.min(y0 + 1, plane.size.height - 1);
  const top = (plane.data[y0 * plane.size.width + x0] ?? 0) * (1 - x + x0) + (plane.data[y0 * plane.size.width + x1] ?? 0) * (x - x0);
  const bottom = (plane.data[y1 * plane.size.width + x0] ?? 0) * (1 - x + x0) + (plane.data[y1 * plane.size.width + x1] ?? 0) * (x - x0);
  return top * (1 - y + y0) + bottom * (y - y0);
}

export function materializeMask(input: { readonly plane: Plane<'u8'>; readonly owner: Size;
  readonly sampling: 'coverage' | 'legacy-threshold' }): Plane<'u8'> {
  maskSchema.parse(input.plane);
  const output = emptyMask(input.owner);
  for (let y = 0; y < input.owner.height; y++) for (let x = 0; x < input.owner.width; x++) {
    output.data[y * input.owner.width + x] = Math.round(sample(input.plane, input.owner, { x: x + .5, y: y + .5 }, input.sampling));
  }
  return output;
}

export function combineMasks(baseline: Plane<'u8'>, brush: Plane<'u8'>, mode: MaskCombine): Plane<'u8'> {
  const output = copyMask(baseline);
  maskSchema.parse(brush);
  if (baseline.size.width !== brush.size.width || baseline.size.height !== brush.size.height) throw new RangeError('Materialize masks at owner resolution before combining.');
  for (let i = 0; i < output.data.length; i++) {
    const old = baseline.data[i] ?? 0, value = brush.data[i] ?? 0;
    switch (mode) {
      case 'replace': output.data[i] = value; break;
      case 'add': output.data[i] = Math.max(old, value); break;
      case 'remove': output.data[i] = Math.round(old * (1 - value / 255)); break;
      default: { const unhandled: never = mode; throw new Error(`Unknown combination: ${unhandled}`); }
    }
  }
  return output;
}

export function invertMask(plane: Plane<'u8'>): Plane<'u8'> {
  const output = copyMask(plane);
  for (let i = 0; i < output.data.length; i++) output.data[i] = 255 - (output.data[i] ?? 0);
  return output;
}

/** Finite triangular kernel w(d)=max(0,radius+1-|d|), including fractional radii.
 * Prefix sums keep both passes linear in pixel count, even at radius 64.
 * The full kernel denominator is retained at edges (zero exterior), and u8
 * quantization happens only after both axes, never in the intermediate plane. */
export function featherMask(plane: Plane<'u8'>, radius: number): Plane<'u8'> {
  const output = copyMask(plane);
  featherRadiusSchema.parse(radius);
  if (radius === 0) return output;
  const { width, height } = plane.size, extent = Math.ceil(radius), peak = radius + 1;
  const denominator = peak + 2 * (extent * peak - extent * (extent + 1) / 2);
  const horizontal = new Float64Array(plane.data.length);
  const sums = new Float64Array(Math.max(width, height) + 1), moments = new Float64Array(sums.length);
  function line(length: number, read: (i: number) => number, write: (i: number, value: number) => void): void {
    sums[0] = 0; moments[0] = 0;
    for (let i = 0; i < length; i++) {
      sums[i + 1] = (sums[i] ?? 0) + read(i);
      moments[i + 1] = (moments[i] ?? 0) + i * read(i);
    }
    const total = (values: Float64Array, lo: number, hi: number): number => (values[hi] ?? 0) - (values[lo] ?? 0);
    for (let i = 0; i < length; i++) {
      const lo = Math.max(0, i - extent), hi = Math.min(length, i + extent + 1);
      const left = (peak - i) * total(sums, lo, i + 1) + total(moments, lo, i + 1);
      const right = (peak + i) * total(sums, i + 1, hi) - total(moments, i + 1, hi);
      write(i, (left + right) / denominator);
    }
  }
  for (let y = 0; y < height; y++) line(width, x => plane.data[y * width + x] ?? 0, (x, value) => { horizontal[y * width + x] = value; });
  for (let x = 0; x < width; x++) line(height, y => horizontal[y * width + x] ?? 0, (y, value) => { output.data[y * width + x] = Math.round(Math.min(255, Math.max(0, value))); });
  return output;
}

export function sameMask(a: Plane<'u8'>, b: Plane<'u8'>): boolean {
  return a.size.width === b.size.width && a.size.height === b.size.height && a.data.length === b.data.length && a.data.every((value, i) => value === b.data[i]);
}
