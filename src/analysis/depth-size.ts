// The depth stage's input size, which is also the depth map's size: one rule
// for every device. Pure, and reads no compile-time constant, so the workers,
// the page, and node tests share it.

import type { Size } from '../core/raster.ts';

/** The depth model's patch, in pixels: both input sides are multiples of it. */
export const DEPTH_PATCH = 14;
/** The input's short side before the token bound applies. */
export const DEPTH_SHORT_SIDE = 518;
/** The most patches an input may hold: 37 x 49, the 518 x 686 input of a 4:3 master. */
export const DEPTH_MAX_TOKENS = 1813;

/** `value` rounded by `round` to a multiple of the patch, and at least one patch. */
function toPatches(value: number, round: (x: number) => number): number {
  return Math.max(DEPTH_PATCH, round(value / DEPTH_PATCH) * DEPTH_PATCH);
}

/**
 * The depth input size for a master of `master`'s size.
 * The short side maps to 518 and the long side follows the aspect, each rounded to the nearest multiple of 14 and at least 14.
 * When that holds more than DEPTH_MAX_TOKENS patches, both sides are scaled by sqrt(DEPTH_MAX_TOKENS / patches)
 * and rounded down to multiples of 14, each at least 14.
 * Defined for sides that are whole numbers of at least 1; for every even master from 512 to 2048 px on its long edge
 * and from 64 px on its short edge both sides are multiples of 14 and the patches are at most DEPTH_MAX_TOKENS.
 */
export function depthInputSize(master: Size): Size {
  const scale = DEPTH_SHORT_SIDE / Math.min(master.width, master.height);
  const width = toPatches(master.width * scale, Math.round);
  const height = toPatches(master.height * scale, Math.round);
  const patches = (width / DEPTH_PATCH) * (height / DEPTH_PATCH);
  if (patches <= DEPTH_MAX_TOKENS) return { width, height };
  const shrink = Math.sqrt(DEPTH_MAX_TOKENS / patches);
  return { width: toPatches(width * shrink, Math.floor), height: toPatches(height * shrink, Math.floor) };
}
