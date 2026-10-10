import { oklabToLinear, oklchToOklab } from '../core/color.ts';
import type { Oklch } from '../core/raster.ts';

export function inGamut(color: Oklch): boolean {
  const rgb = oklabToLinear(oklchToOklab(color));
  return [rgb.r, rgb.g, rgb.b].every((v) => v >= 0 && v <= 1);
}

/** Return the inside endpoint, never the outside endpoint of the bracket. */
export function Cmax(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 26; i++) {
    const c = (lo + hi) / 2;
    if (inGamut({ l, c, h })) lo = c;
    else hi = c;
  }
  return lo;
}

/** The sRGB radial boundary has one maximum along a fixed hue. */
export function Lcusp(h: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 36; i++) {
    const left = lo + (hi - lo) / 3;
    const right = hi - (hi - lo) / 3;
    if (Cmax(left, h) < Cmax(right, h)) lo = left;
    else hi = right;
  }
  return (lo + hi) / 2;
}

export function clipGamut(color: Oklch): Oklch {
  return { ...color, c: Math.min(color.c, Cmax(color.l, color.h)) };
}
