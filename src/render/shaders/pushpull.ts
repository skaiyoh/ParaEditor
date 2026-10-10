import type { Plane } from '../../core/raster.ts';

type Level = { width: number; height: number; values: Float32Array; coverage: Float32Array };

/** Cached CPU push-pull at depth-plane size; uploaded once, never a frame pass. */
export function fillBackgroundDepth(plane: Plane<'f32'>, hole: Plane<'u8'>): Plane<'f32'> {
  const { width, height } = plane.size;
  if (width !== hole.size.width || height !== hole.size.height || plane.data.length !== width * height || hole.data.length !== width * height) {
    throw new RangeError('Depth and hole must have matching sizes.');
  }
  const first: Level = { width, height, values: plane.data.slice(), coverage: new Float32Array(width * height) };
  let total = 0, weight = 0;
  for (let i = 0; i < first.values.length; i++) {
    const value = plane.data[i] ?? 0;
    if (!Number.isFinite(value)) throw new RangeError('Background depth must be finite.');
    const coverage = 1 - (hole.data[i] ?? 0) / 255;
    first.coverage[i] = coverage;
    total += value * coverage; weight += coverage;
  }
  const levels = [first];
  for (let n = 1; n < 8; n++) {
    const previous = levels[n - 1];
    if (previous === undefined || (previous.width === 1 && previous.height === 1)) break;
    const width = Math.ceil(previous.width / 2), height = Math.ceil(previous.height / 2);
    const level: Level = { width, height, values: new Float32Array(width * height), coverage: new Float32Array(width * height) };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, covered = 0, taps = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const px = x * 2 + dx, py = y * 2 + dy;
        if (px >= previous.width || py >= previous.height) continue;
        const i = py * previous.width + px, c = previous.coverage[i] ?? 0;
        sum += (previous.values[i] ?? 0) * c; covered += c; taps++;
      }
      const i = y * width + x;
      level.values[i] = covered > 0 ? sum / covered : 0;
      level.coverage[i] = covered / taps;
    }
    levels.push(level);
  }
  // Eight levels may stop above 1x1. Seed empty coarsest texels from known
  // samples' weighted mean, retaining the convex-range property on large holes.
  const coarsest = levels[levels.length - 1];
  if (coarsest === undefined) throw new Error('The depth pyramid is empty.');
  for (let i = 0; i < coarsest.values.length; i++) if ((coarsest.coverage[i] ?? 0) === 0) {
    coarsest.values[i] = weight > 0 ? total / weight : 0.5;
  }
  for (let n = levels.length - 2; n >= 0; n--) {
    const fine = levels[n], coarse = levels[n + 1];
    if (fine === undefined || coarse === undefined) continue;
    for (let y = 0; y < fine.height; y++) for (let x = 0; x < fine.width; x++) {
      const i = y * fine.width + x;
      if ((fine.coverage[i] ?? 0) > 0) continue;
      const u = (x + 0.5) * coarse.width / fine.width - 0.5;
      const v = (y + 0.5) * coarse.height / fine.height - 0.5;
      const lx = Math.floor(u), ly = Math.floor(v), fx = u - lx, fy = v - ly;
      let value = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const px = Math.max(0, Math.min(coarse.width - 1, lx + dx)), py = Math.max(0, Math.min(coarse.height - 1, ly + dy));
        value += (coarse.values[py * coarse.width + px] ?? 0) * (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy);
      }
      fine.values[i] = value;
    }
  }
  return { format: 'f32', size: plane.size, data: first.values };
}
