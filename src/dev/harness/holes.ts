// The holes the memory harness hands the inpainting model, made in the page
// from integers alone: every step below is an integer add, multiply, compare,
// or a division by 10 rounded down, so the bytes are the same in every
// JavaScript engine, unlike the synth painter's, whose Math.exp and Math.pow
// may differ in their low bits between engines.
//
// A hole is a plane at the master's size in the hole mask's polarity: 255
// inside the hole, 0 outside.

import type { Plane, Size } from '../../core/raster.ts';

export const HOLE_SHAPES = ['corners', 'full'] as const;

/**
 * `full`: every pixel is in the hole.
 * `corners`: four discs of radius `cornerRadius(size)`, one centred that
 * many pixels in from each corner, so the union's bounding box is the whole
 * frame while it covers about a tenth of it.
 */
export type HoleShape = (typeof HOLE_SHAPES)[number];

function assertSize(size: Size): void {
  for (const side of [size.width, size.height]) {
    if (!Number.isInteger(side) || side < 1) throw new RangeError(`a hole's sides are whole numbers of at least 1, not ${size.width} x ${size.height}`);
  }
}

/** round(0.1 x min(width, height)), halves up, in integers. */
export function cornerRadius(size: Size): number {
  return Math.floor((Math.min(size.width, size.height) + 5) / 10);
}

/** The hole of `shape` at `size`; throws a RangeError for a side that is not a whole number of at least 1. */
export function holePlane(shape: HoleShape, size: Size): Plane<'u8'> {
  assertSize(size);
  const { width, height } = size;
  const data = new Uint8Array(width * height);
  switch (shape) {
    case 'full':
      data.fill(255);
      break;
    case 'corners':
      paintCorners(data, width, height, cornerRadius(size));
      break;
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
  return { format: 'u8', size: { width, height }, data };
}

/**
 * Sets every pixel whose centre (x + 0.5, y + 0.5) lies within r of a disc's
 * centre, tested in doubled coordinates, where both centres are integers:
 * (2x + 1 - 2cx)^2 + (2y + 1 - 2cy)^2 <= (2r)^2.
 */
function paintCorners(data: Uint8Array, width: number, height: number, r: number): void {
  const limit = 4 * r * r;
  const centres: readonly (readonly [number, number])[] = [[r, r], [width - r, r], [r, height - r], [width - r, height - r]];
  for (const [cx, cy] of centres) {
    // Only pixels x in [cx - r, cx + r) can pass: outside it |2x + 1 - 2cx| > 2r.
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y += 1) {
      const dy = 2 * y + 1 - 2 * cy;
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x += 1) {
        const dx = 2 * x + 1 - 2 * cx;
        if (dx * dx + dy * dy <= limit) data[y * width + x] = 255;
      }
    }
  }
}
